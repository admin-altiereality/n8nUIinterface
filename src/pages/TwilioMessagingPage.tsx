import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCheck,
  Clock3,
  Loader2,
  MessageCircleMore,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Smartphone,
  X,
  UserRound,
  Plus,
  MoreVertical,
  ShieldCheck,
  LogOut,
  User,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Label } from '../components/ui/label';
import {
  fetchTwilioHealth,
  getTwilioMessage,
  listTwilioMessages,
  sendTwilioMessage,
  type TwilioMessage,
  type TwilioHealth,
} from '../api/twilioClient';
import { isFirebaseConfigured, uploadTwilioMediaToStorage } from '../lib/firebase';

type Thread = {
  id: string;
  contact: string;
  sendTo: string;
  lastText: string;
  lastAt: number;
  unreadCount: number;
  messages: TwilioMessage[];
};

type QueueFilter = 'all' | 'needsFollowUp' | 'highRisk' | 'failed';

function normalizeParty(value: string | undefined): string {
  if (!value) return 'Unknown';
  return value.replace(/^whatsapp:/i, '').trim() || 'Unknown';
}

function normalizeRecipient(value: string): string {
  const val = value.trim();
  if (!val) return '';

  // If it already has a prefix, leave it alone.
  if (val.startsWith('whatsapp:') || val.startsWith('+')) return val;

  // If it's a 10-digit number, assume Indian (+91) and WhatsApp.
  if (/^\d{10}$/.test(val)) return `whatsapp:+91${val}`;

  // If it's all digits but not 10, just add whatsapp:+ for now (user might have entered a different country code).
  if (/^\d+$/.test(val)) return `whatsapp:+${val}`;

  // Default to adding whatsapp: prefix if missing.
  return `whatsapp:${val}`;
}

function isInbound(direction: string | undefined): boolean {
  return String(direction || '').toLowerCase() === 'inbound';
}

function messageTime(message: TwilioMessage): number {
  const raw = message.date_sent || message.date_created || message.date_updated;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

function shortTime(timeMs: number): string {
  if (!timeMs) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timeMs));
}

function smartDate(timeMs: number): string {
  if (!timeMs) return '';
  const date = new Date(timeMs);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return shortTime(timeMs);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function bubbleStatusVariant(status: string | undefined): 'secondary' | 'warning' | 'danger' | 'success' {
  const s = String(status || '').toLowerCase();
  if (s === 'failed' || s === 'undelivered' || s === 'canceled') return 'danger';
  if (s === 'queued' || s === 'sending' || s === 'sent' || s === 'accepted') return 'warning';
  if (s === 'delivered' || s === 'read' || s === 'received') return 'success';
  return 'secondary';
}

function getContactForThread(message: TwilioMessage): string {
  return isInbound(message.direction) ? normalizeParty(message.from) : normalizeParty(message.to);
}

function buildThreads(messages: TwilioMessage[]): Thread[] {
  const grouped = new Map<string, TwilioMessage[]>();

  for (const message of messages) {
    const key = getContactForThread(message);
    const arr = grouped.get(key);
    if (arr) arr.push(message);
    else grouped.set(key, [message]);
  }

  const threads: Thread[] = [];
  for (const [key, arr] of grouped.entries()) {
    const sorted = [...arr].sort((a, b) => messageTime(a) - messageTime(b));
    const last = sorted[sorted.length - 1];
    const latest = [...sorted].reverse();
    const preferredAddress =
      latest.find((m) => isInbound(m.direction))?.from ||
      latest.find((m) => !isInbound(m.direction))?.to ||
      key;
    const unreadCount = sorted.filter((m) => isInbound(m.direction) && String(m.status || '').toLowerCase() !== 'read').length;
    const lastTextRaw =
      (last && last.body) ||
      (last && Array.isArray(last.media) && last.media.length > 0 ? 'Attachment' : '(No text)');
    threads.push({
      id: key,
      contact: key,
      sendTo: preferredAddress,
      lastText: String(lastTextRaw).slice(0, 72),
      lastAt: messageTime(last),
      unreadCount,
      messages: sorted,
    });
  }

  threads.sort((a, b) => b.lastAt - a.lastAt);
  return threads;
}

function threadLastInbound(thread: Thread): TwilioMessage | null {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
    if (isInbound(thread.messages[i].direction)) return thread.messages[i];
  }
  return null;
}

function threadLastOutbound(thread: Thread): TwilioMessage | null {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
    if (!isInbound(thread.messages[i].direction)) return thread.messages[i];
  }
  return null;
}

function followUpState(thread: Thread): {
  needsFollowUp: boolean;
  hasFailed: boolean;
  risk: 'low' | 'medium' | 'high';
  waitingMinutes: number;
} {
  const lastInbound = threadLastInbound(thread);
  const lastOutbound = threadLastOutbound(thread);
  const inboundTime = lastInbound ? messageTime(lastInbound) : 0;
  const outboundTime = lastOutbound ? messageTime(lastOutbound) : 0;
  const needsFollowUp = Boolean(inboundTime && inboundTime > outboundTime);
  const waitingMinutes = needsFollowUp ? Math.max(0, Math.round((Date.now() - inboundTime) / 60000)) : 0;
  const hasFailed = thread.messages.some((m) => {
    const s = String(m.status || '').toLowerCase();
    return s === 'failed' || s === 'undelivered';
  });

  let risk: 'low' | 'medium' | 'high' = 'low';
  if (needsFollowUp && waitingMinutes >= 180) risk = 'high';
  else if (needsFollowUp && waitingMinutes >= 45) risk = 'medium';

  return { needsFollowUp, hasFailed, risk, waitingMinutes };
}

function waitingLabel(waitingMinutes: number): string {
  if (waitingMinutes < 60) return `${waitingMinutes}m waiting`;
  const h = Math.floor(waitingMinutes / 60);
  const m = waitingMinutes % 60;
  return `${h}h ${m}m waiting`;
}

export default function TwilioMessagingPage() {
  const [health, setHealth] = useState<TwilioHealth>({ ok: false, accountHint: null });
  const [messages, setMessages] = useState<TwilioMessage[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [isNewChatMode, setIsNewChatMode] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [manualTo, setManualTo] = useState('');
  const [sending, setSending] = useState(false);
  const [sendInfo, setSendInfo] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const firebaseEnabled = useMemo(() => isFirebaseConfigured(), []);
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const h = await fetchTwilioHealth();
      setHealth(h);
      const result = await listTwilioMessages({ pageSize: 50 });
      setMessages(result.messages);
      setNextPageToken(result.nextPageToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load messages.');
      setMessages([]);
      setNextPageToken(null);
      setHealth({ ok: false, accountHint: null });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextPageToken) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await listTwilioMessages({ pageSize: 50, pageToken: nextPageToken });
      setMessages((prev) => [...prev, ...result.messages]);
      setNextPageToken(result.nextPageToken);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load older messages.');
    } finally {
      setLoadingMore(false);
    }
  }, [nextPageToken]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => {
    return () => {
      if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
    };
  }, [attachmentPreviewUrl]);

  const threads = useMemo(() => buildThreads(messages), [messages]);
  const filteredThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((thread) => {
      if (thread.contact.toLowerCase().includes(q)) return true;
      return thread.messages.some((m) => String(m.body || '').toLowerCase().includes(q));
    });
  }, [threads, search]);

  const queueFilteredThreads = useMemo(() => {
    return filteredThreads.filter((thread) => {
      const state = followUpState(thread);
      if (queueFilter === 'all') return true;
      if (queueFilter === 'needsFollowUp') return state.needsFollowUp;
      if (queueFilter === 'highRisk') return state.risk === 'high';
      if (queueFilter === 'failed') return state.hasFailed;
      return true;
    });
  }, [filteredThreads, queueFilter]);

  const queueStats = useMemo(() => {
    const states = threads.map((t) => followUpState(t));
    return {
      total: threads.length,
      needsFollowUp: states.filter((s) => s.needsFollowUp).length,
      highRisk: states.filter((s) => s.risk === 'high').length,
      failed: states.filter((s) => s.hasFailed).length,
    };
  }, [threads]);

  useEffect(() => {
    if (!selectedThreadId && !isNewChatMode && queueFilteredThreads[0]) {
      setSelectedThreadId(queueFilteredThreads[0].id);
    }
  }, [queueFilteredThreads, selectedThreadId, isNewChatMode]);

  const activeThread = useMemo(
    () => (isNewChatMode ? null : queueFilteredThreads.find((thread) => thread.id === selectedThreadId) || queueFilteredThreads[0] || null),
    [queueFilteredThreads, selectedThreadId, isNewChatMode]
  );

  const activeFollowUp = useMemo(() => (activeThread ? followUpState(activeThread) : null), [activeThread]);

  const normalizedManualTo = useMemo(() => normalizeRecipient(manualTo), [manualTo]);

  useEffect(() => {
    if (!autoScroll) return;
    // Scroll to the latest message when switching chats or new messages arrive.
    requestAnimationFrame(() => {
      messageEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    });
  }, [autoScroll, activeThread?.id, activeThread?.messages.length]);

  const onSend = async () => {
    const to = isNewChatMode ? normalizedManualTo : activeThread?.sendTo;
    const text = composerText.trim();
    if (!to || (!text && !attachmentFile)) return;

    setSending(true);
    setSendInfo(null);
    try {
      setAutoScroll(true);

      let mediaUrl: string | undefined;
      if (attachmentFile) {
        setSendInfo(`Uploading ${attachmentFile.name}…`);
        if (!firebaseEnabled) {
          throw new Error('Firebase is not configured for media uploads.');
        }
        const uploaded = await uploadTwilioMediaToStorage(attachmentFile, { pathPrefix: 'twilio-media' });
        mediaUrl = uploaded.downloadUrl;
        setSendInfo('Media uploaded. Sending to WhatsApp…');
      }

      // WhatsApp does not deliver a text Body together with media types.
      // We send ONLY media when an attachment is selected.
      const bodyToSend = attachmentFile ? '' : text;

      const sent = await sendTwilioMessage({
        to,
        body: bodyToSend,
        mediaUrl,
      });

      setComposerText('');
      if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
      setAttachmentPreviewUrl(null);
      setAttachmentFile(null);

      // Update UI with the full message payload (so `media` field show up),
      // instead of relying only on the list endpoint.
      try {
        // If we sent media, fetch full message to ensure `media` field exists.
        let debug: string | null = null;
        if (mediaUrl && sent.sid) {
          const full = await getTwilioMessage(sent.sid);
          debug = `Twilio status: ${String(full.status || 'n/a')}, mediaItems: ${Array.isArray(full.media) ? full.media.length : 0}`;
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.sid === full.sid);
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = full;
              return copy;
            }
            return [...prev, full];
          });
        }
        setSendInfo(debug ? `Sent successfully. ${debug}` : 'Sent successfully.');
      } catch {
        // If full fetch fails, just fall back to reload.
        setSendInfo('Sent successfully.');
      }

      await loadFirstPage();
      if (isNewChatMode) {
        setIsNewChatMode(false);
        setManualTo('');
        // Let the useEffect handle selection of the new thread if it appears
      }
    } catch (e) {
      setSendInfo(e instanceof Error ? e.message : 'Send failed.');
    } finally {
      setSending(false);
    }
  };

  const recipient = activeThread ? activeThread.sendTo : manualTo.trim();
  const canSend = Boolean(recipient && !sending && (composerText.trim() || attachmentFile));

  const removeAttachment = () => {
    if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
    setAttachmentPreviewUrl(null);
    setAttachmentFile(null);
  };

  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-transparent text-slate-100 selection:bg-rose-500/30">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        
        {/* Header */}
        <header className="glass-card mb-8 rounded-3xl p-6 lg:p-8 animate-fade-in">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-rose-500/20 bg-rose-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-rose-300">
                <ShieldCheck className="size-3" />
                {user?.role === 'superadmin' ? 'Super Admin' : 'Chat Manager'}
              </div>
              <h1 className="text-gradient-rose text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
                Messages
              </h1>
              <div className="flex items-center gap-2 text-xs text-slate-500 font-medium">
                <User className="size-3 text-rose-400" />
                <span>Logged in as <span className="text-slate-300">{user?.name}</span></span>
              </div>
            </div>
            
            <div className="flex flex-wrap items-center gap-3">
               {health && health.ok && (
                  <div className="glass-card flex items-center gap-2 h-9 px-4 rounded-2xl text-[10px] font-black uppercase tracking-widest text-emerald-400 border-emerald-500/10 mr-4">
                    <ShieldCheck className="size-3" /> Twilio Healthy
                  </div>
               )}
              
              {user?.role === 'superadmin' && (
                <>
                  <Link to="/" className="glass-card rounded-2xl px-5 py-2.5 text-xs font-semibold text-slate-200 hover:bg-white/5 transition-all">
                    Builder
                  </Link>
                  <Link to="/sales-funnel" className="glass-card border-emerald-500/10 bg-emerald-500/5 rounded-2xl px-5 py-2.5 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/10 transition-all">
                    Funnel
                  </Link>
                </>
              )}

              <Button 
                variant="ghost" 
                onClick={logout}
                className="rounded-2xl px-4 py-2.5 text-xs font-bold text-rose-500 hover:bg-rose-500/10 transition-all flex items-center gap-2 border border-rose-500/10"
              >
                <LogOut className="size-3" /> Sign Out
              </Button>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 h-[calc(100vh-320px)] min-h-[600px]">
          
          {/* Sidebar - Threads */}
          <div className="lg:col-span-4 flex flex-col h-full glass-card rounded-3xl overflow-hidden animate-fade-in [animation-delay:100ms]">
            <div className="p-5 border-b border-white/5 bg-white/5 flex items-center justify-between">
               <h3 className="font-heading text-lg font-semibold text-rose-100 uppercase tracking-tight">Chats</h3>
               <div className="flex items-center gap-2">
                  <button onClick={() => { setIsNewChatMode(true); setSelectedThreadId(null); }} className="p-2 rounded-xl bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition-all active:scale-95">
                     <Plus className="size-4" />
                  </button>
                  <button onClick={() => void loadFirstPage()} className="p-2 rounded-xl bg-white/5 text-slate-400 hover:bg-white/10 transition-all">
                     <RefreshCw className={`size-4 ${loading && !loadingMore ? 'animate-spin' : ''}`} />
                  </button>
               </div>
            </div>

            <div className="p-4 border-b border-white/5">
               <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
                  <Input 
                    placeholder="Search messages..." 
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-10 pl-10 bg-slate-950/50 border-white/5 rounded-xl text-xs"
                  />
               </div>
               <div className="grid grid-cols-2 gap-2 mt-3 text-[9px] font-bold uppercase tracking-wider">
                  <button onClick={() => setQueueFilter('needsFollowUp')} className={`p-2 rounded-lg border transition-all ${queueFilter === 'needsFollowUp' ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-white/5 bg-white/5 text-slate-500'}`}>
                    Follow-up ({queueStats.needsFollowUp})
                  </button>
                  <button onClick={() => setQueueFilter('failed')} className={`p-2 rounded-lg border transition-all ${queueFilter === 'failed' ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-white/5 bg-white/5 text-slate-500'}`}>
                    Failed ({queueStats.failed})
                  </button>
               </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
              {loading && !loadingMore && threads.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-16 w-full animate-pulse rounded-2xl bg-white/5 border border-white/5"></div>
                ))
              ) : threads.length === 0 ? (
                <div className="flex h-32 items-center justify-center p-6 text-center text-slate-500 text-xs italic">
                  No conversations
                </div>
              ) : (
                queueFilteredThreads.map((thread) => {
                  const selected = activeThread?.id === thread.id;
                  const state = followUpState(thread);
                  return (
                    <button
                      key={thread.id}
                      onClick={() => { setSelectedThreadId(thread.id); setIsNewChatMode(false); }}
                      className={`w-full p-4 rounded-2xl transition-all border group text-left ${
                        selected && !isNewChatMode
                          ? 'bg-rose-500/10 border-rose-500/20 shadow-lg shadow-rose-950/20'
                          : 'bg-white/5 border-white/5 hover:bg-white/[0.08] hover:border-white/10'
                      }`}
                    >
                      <div className="flex items-start justify-between mb-1.5">
                         <p className={`text-xs font-bold font-heading uppercase tracking-tight ${selected && !isNewChatMode ? 'text-rose-200' : 'text-slate-100'}`}>
                            {thread.contact}
                         </p>
                         <span className="text-[9px] text-slate-600 font-medium">{smartDate(thread.lastAt)}</span>
                      </div>
                      <p className="text-[11px] text-slate-500 line-clamp-1 group-hover:text-slate-400 transition-colors">
                         {thread.lastText || 'Sent media'}
                      </p>
                      {(state.needsFollowUp || thread.unreadCount > 0) && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {thread.unreadCount > 0 && <Badge variant="success" className="text-[8px] h-4 uppercase px-1">NEW</Badge>}
                          {state.needsFollowUp && (
                            <div className={`p-1 px-2 rounded-full text-[8px] font-bold ${state.risk === 'high' ? 'bg-rose-500/20 text-rose-400' : 'bg-amber-500/20 text-amber-400'}`}>
                              {waitingLabel(state.waitingMinutes)}
                            </div>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })
              )}
              {nextPageToken && (
                <button 
                   onClick={() => void loadMore()} 
                   disabled={loadingMore}
                   className="w-full py-3 rounded-2xl border border-dashed border-white/10 text-[9px] text-slate-500 hover:text-rose-300 hover:border-rose-500/30 transition-all font-bold tracking-widest uppercase"
                >
                  {loadingMore ? 'Syncing...' : 'Load History'}
                </button>
              )}
            </div>
          </div>

          {/* Main Chat Area */}
          <div className="lg:col-span-8 flex flex-col h-full glass-card rounded-3xl overflow-hidden animate-fade-in [animation-delay:200ms]">
            
            {/* Thread Header */}
            <div className="p-5 border-b border-white/5 bg-white/5 flex items-center justify-between">
               <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-rose-500/20 to-indigo-500/20 flex items-center justify-center border border-white/10">
                     <UserRound className="size-5 text-rose-300" />
                  </div>
                  <div>
                     <h3 className="font-heading font-bold text-slate-100 uppercase tracking-tight">
                        {isNewChatMode ? 'New Conversation' : activeThread ? activeThread.contact : 'Messenger'}
                     </h3>
                     <p className="text-[10px] text-slate-600 font-medium">{isNewChatMode ? 'Recipient required' : activeThread ? 'WhatsApp Chat' : 'Select a thread'}</p>
                  </div>
               </div>
               <div className="flex items-center gap-2">
                  <button className="p-2 rounded-xl hover:bg-white/5 text-slate-600 transition-all">
                      <MoreVertical className="size-5" />
                  </button>
               </div>
            </div>

            {/* Messages */}
            <div 
              ref={messageScrollRef}
              className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-950/20 custom-scrollbar"
              onScroll={() => {
                const el = messageScrollRef.current;
                if (!el) return;
                const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                setAutoScroll(distanceFromBottom < 140);
              }}
            >
              {!activeThread && !isNewChatMode ? (
                <div className="flex h-full items-center justify-center">
                   <div className="text-center space-y-4">
                      <div className="mx-auto h-16 w-16 rounded-3xl bg-white/5 flex items-center justify-center border border-white/5">
                         <MessageCircleMore className="size-8 text-slate-800" />
                      </div>
                      <p className="text-[11px] text-slate-600 font-bold uppercase tracking-widest">Select a chat to begin</p>
                   </div>
                </div>
              ) : isNewChatMode ? (
                <div className="flex h-full items-center justify-center">
                   <div className="max-w-xs text-center space-y-6">
                      <div className="mx-auto h-20 w-20 rounded-[40px] bg-rose-500/5 flex items-center justify-center border border-rose-500/10">
                         <Smartphone className="size-10 text-rose-500/40" />
                      </div>
                      <div className="space-y-2">
                         <h4 className="font-heading font-bold text-slate-100 uppercase tracking-tight">Draft New Message</h4>
                         <p className="text-xs text-slate-500 leading-relaxed font-medium">Start a direct WhatsApp session by entering a recipient number below.</p>
                      </div>
                   </div>
                </div>
              ) : activeThread && (
                activeThread.messages.map((message) => {
                  const inbound = isInbound(message.direction);
                  const t = messageTime(message);
                  const firstMedia = Array.isArray(message.media) && message.media.length > 0 ? message.media[0] : undefined;
                  const mediaUrl = firstMedia?.preview_url || firstMedia?.media_url || firstMedia?.uri;
                  const contentType = String(firstMedia?.content_type || '');
                  const filename = firstMedia?.filename || 'Attachment';

                  return (
                    <div key={message.sid} className={`flex ${inbound ? 'justify-start' : 'justify-end'} animate-scale-in`}>
                       <div className={`max-w-[75%] space-y-1.5`}>
                          <div className={`p-4 rounded-3xl border shadow-xl ${
                            inbound 
                              ? 'bg-slate-900 border-white/5 rounded-tl-none shadow-black/40' 
                              : 'bg-rose-500/10 border-rose-500/20 rounded-tr-none shadow-rose-950/20'
                          }`}>
                             {message.body && (
                                <p className="text-[13px] leading-[1.6] text-slate-200 whitespace-pre-wrap">{message.body}</p>
                             )}
                             {mediaUrl && (
                               <div className="mt-3">
                                  {contentType.startsWith('image') ? (
                                    <img src={mediaUrl} alt={filename} className="max-w-full rounded-2xl border border-white/10" />
                                  ) : contentType.startsWith('video') ? (
                                    <video controls src={mediaUrl} className="max-w-full rounded-2xl border border-white/10" />
                                  ) : (
                                    <a href={mediaUrl} target="_blank" rel="noreferrer" className="flex items-center gap-3 p-3 rounded-2xl bg-white/5 border border-white/5 text-xs text-slate-300 hover:bg-white/10 transition-all">
                                       <Paperclip className="size-4" /> {filename}
                                    </a>
                                  )}
                               </div>
                             )}
                             <div className="mt-3 flex items-center justify-end gap-2 text-[8px] font-black text-slate-600 uppercase tracking-[0.2em]">
                                <span>{shortTime(t)}</span>
                                {!inbound && (
                                   <div className="flex items-center gap-0.5">
                                      <CheckCheck className={`size-3 ${message.status === 'read' ? 'text-rose-500' : 'text-slate-700'}`} />
                                   </div>
                                )}
                             </div>
                          </div>
                          {(message.status === 'failed' || message.status === 'undelivered') && (
                             <p className="text-[8px] text-rose-500 font-bold uppercase tracking-widest text-right">
                                {message.error_code === 63016 ? '24h Window Closed' : `Failed: ${message.error_code}`}
                             </p>
                          )}
                       </div>
                    </div>
                  );
                })
              )}
              <div ref={messageEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-5 border-t border-white/5 bg-white/5">
               {isNewChatMode && (
                  <div className="mb-4 animate-slide-up">
                     <div className="flex items-center justify-between mb-2 px-1">
                        <Label className="text-[9px] font-black uppercase tracking-[0.2em] text-rose-500">Recipient</Label>
                        {manualTo.trim() && (
                          <span className="text-[9px] font-mono text-slate-600">Formatted: {normalizedManualTo}</span>
                        )}
                     </div>
                     <Input 
                       value={manualTo}
                       onChange={(e) => setManualTo(e.target.value)}
                       placeholder="e.g. 9821012345"
                       className="h-11 bg-slate-950/80 border-rose-500/20 rounded-2xl font-mono text-xs focus:ring-rose-500/10 transition-all"
                     />
                  </div>
               )}
               <div className="flex items-end gap-3">
                  <div className="flex-1 relative">
                     <Textarea 
                       value={composerText}
                       onChange={(e) => setComposerText(e.target.value)}
                       placeholder={activeThread ? `Reply...` : "Type a message..."}
                       className="min-h-[52px] max-h-[150px] py-4 pr-12 bg-slate-950/80 border-white/5 rounded-[26px] text-sm custom-scrollbar focus:ring-0 focus:border-white/10"
                     />
                     <button 
                        onClick={() => fileInputRef.current?.click()} 
                        disabled={!firebaseEnabled}
                        className="absolute right-4 bottom-3.5 p-2 rounded-xl text-slate-600 hover:text-rose-400 transition-all disabled:opacity-30"
                      >
                        <Paperclip className="size-4" />
                     </button>
                  </div>
                  <Button 
                    disabled={!canSend}
                    onClick={() => void onSend()}
                    className="h-[52px] w-[52px] rounded-full bg-rose-600 hover:bg-rose-500 shadow-xl shadow-rose-950/20 p-0 flex items-center justify-center transition-all active:scale-90"
                  >
                    {sending ? <Loader2 className="size-6 animate-spin text-white" /> : <Send className="size-6 text-white" />}
                  </Button>
               </div>
               
               {attachmentFile && (
                  <div className="mt-4 p-3 px-5 rounded-2xl bg-rose-500/5 border border-rose-500/10 flex items-center justify-between animate-fade-in">
                     <div className="flex items-center gap-3 overflow-hidden">
                        <Paperclip className="size-4 text-rose-500 shrink-0" />
                        <span className="text-[10px] font-bold text-rose-200 truncate">{attachmentFile.name}</span>
                     </div>
                     <button onClick={removeAttachment} className="text-[10px] font-black text-rose-500 hover:text-rose-400 ml-4">REMOVE</button>
                  </div>
               )}
               
               {sendInfo && (
                  <p className={`mt-3 text-[10px] font-bold uppercase tracking-widest text-center ${sendInfo.toLowerCase().includes('success') ? 'text-emerald-500' : 'text-rose-400'}`}>
                    {sendInfo}
                  </p>
               )}
            </div>
          </div>

        </div>
      </div>
      <input 
        ref={fileInputRef} 
        type="file" 
        className="hidden" 
        onChange={(e) => {
          const file = e.target.files?.[0] || null;
          setAttachmentFile(file);
          if (file) setAttachmentPreviewUrl(URL.createObjectURL(file));
        }} 
      />
    </div>
  );
}
