import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCheck,
  Loader2,
  MessageCircleMore,
  Paperclip,
  FileText,
  RefreshCw,
  Search,
  Send,
  Smartphone,
  X,
  Plus,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Avatar } from '../components/ui/avatar';
import {
  fetchTwilioHealth,
  fetchTwilioStatuses,
  getTwilioMessage,
  isTwilioStatusTerminal,
  listTwilioSendDiagnostics,
  listTwilioTemplates,
  listTwilioMessages,
  sendTwilioMessage,
  isTwilioAccountUnavailableError,
  type TwilioMessage,
  type TwilioHealth,
  type TwilioSendDiagnostic,
  type TwilioTemplate,
  TwilioApiError,
} from '../api/twilioClient';
import { fetchLeadAssignment, updateLeadAssignment, type LeadAssignment } from '../api/opsClient';
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

type QueueFilter = 'all' | 'needsFollowUp' | 'highRisk' | 'failed' | 'seen';

const STATUS_POLL_MS = 10000;
const DOCUMENT_TEMPLATE_SID = 'HX9fab5aaad062c64423df7a312c84e6af';
const MAX_WHATSAPP_MEDIA_BYTES = 16 * 1024 * 1024;
const SUPPORTED_ATTACHMENT_TYPES = /^(image\/|video\/|audio\/|application\/pdf$)/i;

type TwilioServiceState = 'unknown' | 'ok' | 'suspended';

function normalizeParty(value: string | undefined): string {
  if (!value) return 'Unknown';
  return value.replace(/^whatsapp:/i, '').trim() || 'Unknown';
}

function normalizeRecipient(value: string): string {
  const val = value.trim();
  if (!val) return '';
  if (val.startsWith('whatsapp:') || val.startsWith('+')) return val;
  if (/^\d{10}$/.test(val)) return `whatsapp:+91${val}`;
  if (/^\d+$/.test(val)) return `whatsapp:+${val}`;
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
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(timeMs));
}

function smartDate(timeMs: number): string {
  if (!timeMs) return '';
  const date = new Date(timeMs);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return shortTime(timeMs);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function getContactForThread(message: TwilioMessage): string {
  return isInbound(message.direction) ? normalizeParty(message.from) : normalizeParty(message.to);
}

function buildThreads(messages: TwilioMessage[]): Thread[] {
  const grouped = new Map<string, TwilioMessage[]>();
  for (const message of messages) {
    const key = getContactForThread(message);
    const arr = grouped.get(key);
    if (arr) arr.push(message); else grouped.set(key, [message]);
  }
  const threads: Thread[] = [];
  for (const [key, arr] of grouped.entries()) {
    const sorted = [...arr].sort((a, b) => messageTime(a) - messageTime(b));
    const last = sorted[sorted.length - 1];
    const latest = [...sorted].reverse();
    const preferredAddress = latest.find((m) => isInbound(m.direction))?.from || latest.find((m) => !isInbound(m.direction))?.to || key;
    const unreadCount = sorted.filter((m) => isInbound(m.direction) && String(m.status || '').toLowerCase() !== 'read').length;
    const lastTextRaw = (last && last.body) || (last && Array.isArray(last.media) && last.media.length > 0 ? 'Attachment' : '(No text)');
    threads.push({ id: key, contact: key, sendTo: preferredAddress, lastText: String(lastTextRaw).slice(0, 72), lastAt: messageTime(last), unreadCount, messages: sorted });
  }
  threads.sort((a, b) => b.lastAt - a.lastAt);
  return threads;
}

function threadLastInbound(thread: Thread): TwilioMessage | null {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) { if (isInbound(thread.messages[i].direction)) return thread.messages[i]; }
  return null;
}

function threadLastOutbound(thread: Thread): TwilioMessage | null {
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) { if (!isInbound(thread.messages[i].direction)) return thread.messages[i]; }
  return null;
}

function followUpState(thread: Thread): {
  needsFollowUp: boolean;
  hasFailed: boolean;
  hasRead: boolean;
  lastOutboundStatus: string;
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
  const lastOutboundStatus = String(lastOutbound?.status || '').toLowerCase();
  const hasRead = lastOutboundStatus === 'read';
  let risk: 'low' | 'medium' | 'high' = 'low';
  if (needsFollowUp && waitingMinutes >= 180) risk = 'high';
  else if (needsFollowUp && waitingMinutes >= 45) risk = 'medium';
  return { needsFollowUp, hasFailed, hasRead, lastOutboundStatus, risk, waitingMinutes };
}

function tickClassForStatus(status: string | undefined): string {
  const s = String(status || '').toLowerCase();
  if (s === 'read') return 'text-blue-400';
  if (s === 'delivered') return 'text-zinc-400';
  if (s === 'failed' || s === 'undelivered') return 'text-red-400';
  return 'text-zinc-600';
}

function outboundStatusBadge(status: string | undefined): { label: string; className: string } | null {
  const s = String(status || '').toLowerCase();
  if (s === 'read') return { label: 'Seen', className: 'text-blue-400' };
  if (s === 'delivered') return { label: 'Delivered', className: 'text-zinc-400' };
  if (s === 'failed' || s === 'undelivered') return { label: 'Failed', className: 'text-red-400' };
  if (s === 'sent' || s === 'queued' || s === 'sending' || s === 'accepted') {
    return { label: s, className: 'text-zinc-500' };
  }
  return null;
}

function waitingLabel(waitingMinutes: number): string {
  if (waitingMinutes < 60) return `${waitingMinutes}m`;
  const h = Math.floor(waitingMinutes / 60);
  const m = waitingMinutes % 60;
  return `${h}h ${m}m`;
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function attachmentKind(file: File): string {
  if (file.type.startsWith('image/')) return 'Image';
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) return 'PDF document';
  return file.type || 'Document';
}

export default function TwilioMessagingPage() {
  const [searchParams] = useSearchParams();
  const [health, setHealth] = useState<TwilioHealth>({ ok: false, accountHint: null });
  const [messages, setMessages] = useState<TwilioMessage[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceState, setServiceState] = useState<TwilioServiceState>('unknown');

  const [search, setSearch] = useState('');
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [isNewChatMode, setIsNewChatMode] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [manualTo, setManualTo] = useState('');
  const [sending, setSending] = useState(false);
  const [sendInfo, setSendInfo] = useState<string | null>(null);
  const [sendDiagnostic, setSendDiagnostic] = useState<{
    phase?: string;
    code?: string | number;
    moreInfo?: string;
    diagnosticId?: string;
  } | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [templates, setTemplates] = useState<TwilioTemplate[]>([]);
  const [diagnostics, setDiagnostics] = useState<TwilioSendDiagnostic[]>([]);
  const [assignment, setAssignment] = useState<LeadAssignment | null>(null);
  const [assignmentSaving, setAssignmentSaving] = useState(false);

  const firebaseEnabled = useMemo(() => isFirebaseConfigured(), []);
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const serviceStateRef = useRef<TwilioServiceState>('unknown');

  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  const markSuspended = useCallback((message?: string) => {
    serviceStateRef.current = 'suspended';
    setServiceState('suspended');
    setHealth({ ok: false, accountHint: null });
    setMessages([]);
    setNextPageToken(null);
    setError(message || 'Twilio account appears suspended or the messaging API is unavailable.');
  }, []);

  const loadFirstPage = useCallback(async (opts?: { force?: boolean }) => {
    if (!opts?.force && serviceStateRef.current === 'suspended') return;

    setLoading(true);
    setError(null);
    try {
      const h = await fetchTwilioHealth();
      setHealth(h);
      const result = await listTwilioMessages({ pageSize: 50 });
      setMessages(result.messages);
      setNextPageToken(result.nextPageToken);
      serviceStateRef.current = 'ok';
      setServiceState('ok');
    } catch (e) {
      if (isTwilioAccountUnavailableError(e)) {
        markSuspended(e instanceof Error ? e.message : undefined);
      } else {
        setError(e instanceof Error ? e.message : 'Could not load messages.');
        setMessages([]);
        setNextPageToken(null);
        setHealth({ ok: false, accountHint: null });
        serviceStateRef.current = 'unknown';
        setServiceState('unknown');
      }
    } finally {
      setLoading(false);
    }
  }, [markSuspended]);

  const loadMore = useCallback(async () => {
    if (!nextPageToken || serviceStateRef.current === 'suspended') return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await listTwilioMessages({ pageSize: 50, pageToken: nextPageToken });
      setMessages((prev) => [...prev, ...result.messages]);
      setNextPageToken(result.nextPageToken);
    } catch (e) {
      if (isTwilioAccountUnavailableError(e)) {
        markSuspended(e instanceof Error ? e.message : undefined);
      } else {
        setError(e instanceof Error ? e.message : 'Could not load older messages.');
      }
    } finally {
      setLoadingMore(false);
    }
  }, [nextPageToken, markSuspended]);

  useEffect(() => { void loadFirstPage(); }, [loadFirstPage]);
  useEffect(() => { return () => { if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl); }; }, [attachmentPreviewUrl]);

  useEffect(() => {
    if (serviceState === 'suspended') return;
    void listTwilioTemplates().then(setTemplates).catch(() => setTemplates([]));
    void listTwilioSendDiagnostics(10).then(setDiagnostics).catch(() => setDiagnostics([]));
  }, [serviceState]);

  // Deep-link from Sales Funnel leads: /twilio-messaging?contact=+91...
  useEffect(() => {
    const contact = searchParams.get('contact');
    if (!contact) return;
    const normalized = normalizeParty(contact);
    setSelectedThreadId(normalized);
    setIsNewChatMode(false);
    setSearch(normalized);
  }, [searchParams]);

  // Poll delivery/read status for non-terminal outbound messages
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    if (serviceState === 'suspended') return;
    let cancelled = false;

    const refreshStatuses = async () => {
      const outbound = messagesRef.current.filter(
        (m) => !isInbound(m.direction) && m.sid && !isTwilioStatusTerminal(m.status)
      );
      if (!outbound.length) return;
      try {
        const map = await fetchTwilioStatuses(outbound.map((m) => m.sid));
        if (cancelled || !Object.keys(map).length) return;
        setMessages((prev) =>
          prev.map((m) => {
            const st = map[m.sid];
            if (!st?.status) return m;
            const next = String(st.status).toLowerCase();
            if (next === String(m.status || '').toLowerCase()) return m;
            return {
              ...m,
              status: next,
              error_code: st.errorCode ?? m.error_code,
              error_message: st.errorMessage ?? m.error_message,
            };
          })
        );
      } catch {
        // ignore transient poll errors
      }
    };

    void refreshStatuses();
    const id = setInterval(() => void refreshStatuses(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [serviceState]);

  const twilioSuspended = serviceState === 'suspended';
  const threads = useMemo(() => buildThreads(messages), [messages]);
  const filteredThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((thread) => { if (thread.contact.toLowerCase().includes(q)) return true; return thread.messages.some((m) => String(m.body || '').toLowerCase().includes(q)); });
  }, [threads, search]);

  const queueFilteredThreads = useMemo(() => {
    return filteredThreads.filter((thread) => {
      const state = followUpState(thread);
      if (queueFilter === 'all') return true;
      if (queueFilter === 'needsFollowUp') return state.needsFollowUp;
      if (queueFilter === 'highRisk') return state.risk === 'high';
      if (queueFilter === 'failed') return state.hasFailed;
      if (queueFilter === 'seen') return state.hasRead;
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
      seen: states.filter((s) => s.hasRead).length,
    };
  }, [threads]);

  useEffect(() => {
    if (!selectedThreadId && !isNewChatMode && queueFilteredThreads[0]) setSelectedThreadId(queueFilteredThreads[0].id);
  }, [queueFilteredThreads, selectedThreadId, isNewChatMode]);

  const activeThread = useMemo(() => (isNewChatMode ? null : queueFilteredThreads.find((thread) => thread.id === selectedThreadId) || queueFilteredThreads[0] || null), [queueFilteredThreads, selectedThreadId, isNewChatMode]);
  const activeFollowUp = useMemo(() => (activeThread ? followUpState(activeThread) : null), [activeThread]);
  const normalizedManualTo = useMemo(() => normalizeRecipient(manualTo), [manualTo]);

  useEffect(() => {
    const threadId = activeThread?.sendTo || activeThread?.contact;
    if (!threadId || isNewChatMode) {
      setAssignment(null);
      return;
    }
    void fetchLeadAssignment(threadId).then(setAssignment).catch(() => setAssignment(null));
  }, [activeThread?.sendTo, activeThread?.contact, isNewChatMode]);

  useEffect(() => {
    if (!autoScroll) return;
    requestAnimationFrame(() => { messageEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' }); });
  }, [autoScroll, activeThread?.id, activeThread?.messages.length]);

  const onSend = async () => {
    if (twilioSuspended) {
      setSendInfo('Twilio account is suspended. Messaging is unavailable until the account is reactivated.');
      return;
    }
    const to = isNewChatMode ? normalizedManualTo : activeThread?.sendTo;
    const text = composerText.trim();
    if (!to || (!text && !attachmentFile)) return;
    setSending(true); setSendInfo(null); setSendDiagnostic(null);
    try {
      setAutoScroll(true);
      let mediaUrl: string | undefined;
      let mediaFilename: string | undefined;
      if (attachmentFile) {
        setSendInfo(`Uploading ${attachmentFile.name}…`);
        if (!firebaseEnabled) throw new Error('Firebase is not configured for media uploads.');
        const uploaded = await uploadTwilioMediaToStorage(attachmentFile, { pathPrefix: 'twilio-media' });
        mediaUrl = uploaded.downloadUrl;
        mediaFilename = attachmentFile.name;
        setSendInfo('Media uploaded. Sending to WhatsApp…');
      }
      const bodyToSend = attachmentFile ? (text || `Please review ${attachmentFile.name}.`) : text;
      const sent = await sendTwilioMessage({
        to,
        body: bodyToSend,
        mediaUrl,
        mediaFilename,
        templateSid: attachmentFile ? DOCUMENT_TEMPLATE_SID : undefined,
      });
      setComposerText('');
      if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
      setAttachmentPreviewUrl(null); setAttachmentFile(null);
      try {
        let debug: string | null = null;
        if (mediaUrl && sent.sid) {
          const full = await getTwilioMessage(sent.sid);
          debug = `Twilio status: ${String(full.status || 'n/a')}, mediaItems: ${Array.isArray(full.media) ? full.media.length : 0}`;
          setMessages((prev) => { const idx = prev.findIndex((m) => m.sid === full.sid); if (idx >= 0) { const copy = [...prev]; copy[idx] = full; return copy; } return [...prev, full]; });
        }
        setSendInfo(debug ? `Sent. ${debug}` : 'Sent successfully.');
      } catch { setSendInfo('Sent successfully.'); }
      await loadFirstPage({ force: true });
      if (isNewChatMode) { setIsNewChatMode(false); setManualTo(''); }
    } catch (e) {
      if (isTwilioAccountUnavailableError(e)) {
        markSuspended(e instanceof Error ? e.message : undefined);
        setSendInfo('Twilio account is suspended. Messaging is unavailable until the account is reactivated.');
      } else {
        setSendInfo(e instanceof Error ? e.message : 'Send failed.');
        if (e instanceof TwilioApiError) {
          setSendDiagnostic({
            phase: e.phase,
            code: e.code,
            moreInfo: e.moreInfo,
            diagnosticId: e.diagnosticId,
          });
          void listTwilioSendDiagnostics(10).then(setDiagnostics).catch(() => undefined);
        }
      }
    }
    finally { setSending(false); }
  };

  const recipient = activeThread ? activeThread.sendTo : manualTo.trim();
  const canSend = Boolean(recipient && !sending && !twilioSuspended && (composerText.trim() || attachmentFile));

  const removeAttachment = () => {
    if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
    setAttachmentPreviewUrl(null); setAttachmentFile(null);
  };

  const onAssignment = async (action: 'claim' | 'unclaim') => {
    const threadId = activeThread?.sendTo || activeThread?.contact;
    if (!threadId) return;
    setAssignmentSaving(true);
    setSendInfo(null);
    try {
      setAssignment(await updateLeadAssignment(threadId, action));
    } catch (e) {
      setSendInfo(e instanceof Error ? e.message : 'Assignment update failed.');
    } finally {
      setAssignmentSaving(false);
    }
  };

  const selectAttachment = (file: File | null) => {
    if (!file) {
      removeAttachment();
      return;
    }
    if (!SUPPORTED_ATTACHMENT_TYPES.test(file.type) && !file.name.toLowerCase().endsWith('.pdf')) {
      setSendInfo('Unsupported file type. Attach a PDF, image, audio, or video file.');
      return;
    }
    if (file.size > MAX_WHATSAPP_MEDIA_BYTES) {
      setSendInfo('Attachment is too large for WhatsApp. Use a file under 16 MB.');
      return;
    }
    if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
    setAttachmentFile(file);
    setAttachmentPreviewUrl(URL.createObjectURL(file));
    setSendInfo(null);
    setSendDiagnostic(null);
  };

  return (
    <div className="p-6 h-[calc(100vh)] animate-fade-in">
      {twilioSuspended && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
        >
          <p className="font-semibold text-amber-50">Twilio Account Suspended</p>
          <p className="mt-1 text-xs text-amber-200/90 leading-relaxed">
            Messaging is temporarily unavailable. Automatic retries are paused to avoid console spam.
            Reactivate the Twilio account, then use Refresh to try again.
          </p>
          {error && <p className="mt-2 text-[11px] text-amber-300/80 font-mono">{error}</p>}
        </div>
      )}

      {/* Chat Container */}
      <div className="chat-container h-full">

        {/* Left Panel — Thread List */}
        <div className="chat-sidebar">
          <div className="chat-sidebar-header">
            <h2 className="text-sm font-semibold text-zinc-100 font-heading">Chats</h2>
            <div className="flex items-center gap-1">
              <button onClick={() => { setIsNewChatMode(true); setSelectedThreadId(null); }} disabled={twilioSuspended} className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-all disabled:opacity-40" title="New chat">
                <Plus className="w-4 h-4" />
              </button>
              <button onClick={() => void loadFirstPage({ force: true })} className="p-2 rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-all" title="Refresh">
                <RefreshCw className={`w-4 h-4 ${loading && !loadingMore ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="chat-search">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
              <Input placeholder="Search or start new chat" value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 pl-10 bg-zinc-800/50 border-zinc-700/50 rounded-lg text-xs" />
            </div>
            <div className="flex gap-1.5 mt-2 flex-wrap">
              {([
                { f: 'all' as const, label: 'All' },
                { f: 'needsFollowUp' as const, label: `Follow-up (${queueStats.needsFollowUp})` },
                { f: 'seen' as const, label: `Seen (${queueStats.seen})` },
                { f: 'failed' as const, label: `Failed (${queueStats.failed})` },
              ]).map(({ f, label }) => (
                <button
                  key={f}
                  onClick={() => setQueueFilter(f)}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-all ${
                    queueFilter === f
                      ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
                      : 'bg-zinc-800/50 text-zinc-500 border border-transparent hover:text-zinc-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[9px] text-zinc-600 leading-relaxed">
              Seen = WhatsApp read receipt when the recipient reports it; otherwise status often stops at Delivered.
            </p>
          </div>

          <div className="chat-thread-list">
            {twilioSuspended ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 px-4 text-center">
                <Smartphone className="w-8 h-8 text-amber-500/70" />
                <p className="text-xs text-zinc-400">Messaging paused while Twilio is suspended.</p>
              </div>
            ) : loading && !loadingMore && threads.length === 0 ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="chat-thread-item">
                  <div className="w-10 h-10 rounded-full bg-zinc-800 animate-pulse flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-zinc-800 rounded animate-pulse w-24" />
                    <div className="h-2.5 bg-zinc-800 rounded animate-pulse w-36" />
                  </div>
                </div>
              ))
            ) : threads.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-zinc-600 text-xs">
                {error && !twilioSuspended ? error : 'No conversations'}
              </div>
            ) : (
              queueFilteredThreads.map((thread) => {
                const selected = activeThread?.id === thread.id && !isNewChatMode;
                const state = followUpState(thread);
                const badge = outboundStatusBadge(state.lastOutboundStatus);
                return (
                  <button key={thread.id} onClick={() => { setSelectedThreadId(thread.id); setIsNewChatMode(false); }} className={`chat-thread-item ${selected ? 'active' : ''}`}>
                    <Avatar name={thread.contact} size="md" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <p className="text-[13px] font-medium text-zinc-200 truncate">{thread.contact}</p>
                        <span className="text-[10px] text-zinc-600 flex-shrink-0 ml-2">{smartDate(thread.lastAt)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-[12px] text-zinc-500 truncate">{thread.lastText || 'Sent media'}</p>
                        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                          {badge && (
                            <span className={`text-[9px] font-medium capitalize ${badge.className}`}>{badge.label}</span>
                          )}
                          {thread.unreadCount > 0 && (
                            <span className="flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-emerald-600 text-[9px] font-bold text-white">{thread.unreadCount}</span>
                          )}
                          {state.needsFollowUp && (
                            <span className={`text-[9px] font-medium ${state.risk === 'high' ? 'text-red-400' : 'text-amber-400'}`}>{waitingLabel(state.waitingMinutes)}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
            {nextPageToken && !twilioSuspended && (
              <button onClick={() => void loadMore()} disabled={loadingMore} className="w-full py-3 text-[10px] text-zinc-500 hover:text-zinc-300 transition-all font-medium">
                {loadingMore ? 'Loading...' : 'Load older messages'}
              </button>
            )}
          </div>
        </div>

        {/* Right Panel — Chat Area */}
        <div className="chat-main">

          {/* Header */}
          <div className="chat-main-header">
            <div className="flex items-center gap-3">
              <Avatar name={isNewChatMode ? 'New' : activeThread?.contact} size="md" />
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">{isNewChatMode ? 'New Conversation' : activeThread ? activeThread.contact : 'Select a chat'}</h3>
                <p className="text-[11px] text-zinc-500">
                  {isNewChatMode
                    ? 'Enter recipient below'
                    : activeThread
                      ? (() => {
                          const st = followUpState(activeThread).lastOutboundStatus;
                          const badge = outboundStatusBadge(st);
                          return badge ? `WhatsApp · Last outbound: ${badge.label}` : 'WhatsApp';
                        })()
                      : ''}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {activeThread && !isNewChatMode && (
                <>
                  {assignment?.assignedTo ? (
                    <Badge variant="info" className="mr-2 text-[9px]">
                      {assignment.assignedToEmail || 'Claimed'}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="mr-2 text-[9px]">Unassigned</Badge>
                  )}
                  <button
                    onClick={() => void onAssignment(assignment?.assignedTo ? 'unclaim' : 'claim')}
                    disabled={assignmentSaving}
                    className="mr-2 rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 transition-all hover:bg-zinc-800 disabled:opacity-40"
                  >
                    {assignmentSaving ? 'Saving...' : assignment?.assignedTo ? 'Unclaim' : 'Claim'}
                  </button>
                </>
              )}
              {templates.some((t) => t.sid === DOCUMENT_TEMPLATE_SID) && (
                <Badge variant="outline" className="text-[9px] mr-2">Template ready</Badge>
              )}
              {twilioSuspended ? (
                <Badge variant="warning" className="text-[9px] mr-2">Suspended</Badge>
              ) : health.ok ? (
                <Badge variant="success" className="text-[9px] mr-2">Connected</Badge>
              ) : null}
            </div>
          </div>

          {/* Messages */}
          <div ref={messageScrollRef} className="chat-messages" onScroll={() => {
            const el = messageScrollRef.current;
            if (!el) return;
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            setAutoScroll(distanceFromBottom < 140);
          }}>
            {twilioSuspended ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-sm text-center space-y-3 px-4">
                  <div className="mx-auto h-16 w-16 rounded-full bg-amber-500/10 flex items-center justify-center">
                    <MessageCircleMore className="w-8 h-8 text-amber-500/80" />
                  </div>
                  <p className="text-sm text-zinc-300 font-medium">Twilio Account Suspended</p>
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    WhatsApp messaging will resume after the Twilio account is reactivated.
                  </p>
                </div>
              </div>
            ) : !activeThread && !isNewChatMode ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center space-y-3">
                  <div className="mx-auto h-16 w-16 rounded-full bg-zinc-800/50 flex items-center justify-center">
                    <MessageCircleMore className="w-8 h-8 text-zinc-700" />
                  </div>
                  <p className="text-sm text-zinc-600">Select a chat to start messaging</p>
                </div>
              </div>
            ) : isNewChatMode ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-xs text-center space-y-4">
                  <div className="mx-auto h-16 w-16 rounded-full bg-zinc-800/50 flex items-center justify-center">
                    <Smartphone className="w-8 h-8 text-zinc-700" />
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-zinc-200 mb-1">New Message</h4>
                    <p className="text-xs text-zinc-500 leading-relaxed">Enter a WhatsApp number below to start a conversation.</p>
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
                  <div key={message.sid} className={`flex ${inbound ? 'justify-start' : 'justify-end'}`}>
                    <div className={`chat-bubble ${inbound ? 'inbound' : 'outbound'}`}>
                      {message.body && <p className="whitespace-pre-wrap">{message.body}</p>}
                      {mediaUrl && (
                        <div className="mt-2">
                          {contentType.startsWith('image') ? (
                            <img src={mediaUrl} alt={filename} className="max-w-full rounded-md" />
                          ) : contentType.startsWith('video') ? (
                            <video controls src={mediaUrl} className="max-w-full rounded-md" />
                          ) : (
                            <a href={mediaUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 p-2 rounded-md bg-white/5 text-xs text-zinc-300 hover:bg-white/10 transition-all">
                              <Paperclip className="w-3 h-3" /> {filename}
                            </a>
                          )}
                        </div>
                      )}
                      <div className="chat-bubble-meta">
                        <span>{shortTime(t)}</span>
                        {!inbound && (
                          <span className="inline-flex items-center gap-0.5" title={String(message.status || '')}>
                            <CheckCheck className={`w-3.5 h-3.5 ${tickClassForStatus(message.status)}`} />
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messageEndRef} />
          </div>

          {/* Input Bar */}
          <div className="chat-input-bar">
            {isNewChatMode && !twilioSuspended && (
              <div className="w-full mb-3">
                <Label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5 block">Recipient</Label>
                <Input value={manualTo} onChange={(e) => setManualTo(e.target.value)} placeholder="e.g. 9821012345" className="h-9 bg-zinc-800/80 font-mono text-xs" />
                {manualTo.trim() && <p className="text-[10px] text-zinc-600 mt-1 font-mono">→ {normalizedManualTo}</p>}
              </div>
            )}
            <div className="flex items-end gap-2 w-full">
              <button onClick={() => fileInputRef.current?.click()} disabled={!firebaseEnabled || twilioSuspended} className="p-2.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-all disabled:opacity-30 flex-shrink-0" title="Attach file">
                <Paperclip className="w-5 h-5" />
              </button>
              <div className="flex-1 relative">
                {attachmentFile && (
                  <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-zinc-700/60 bg-zinc-900/80 p-2.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {attachmentPreviewUrl && attachmentFile.type.startsWith('image/') ? (
                        <img src={attachmentPreviewUrl} alt="" className="h-10 w-10 rounded-md object-cover border border-zinc-700/60 flex-shrink-0" />
                      ) : (
                        <div className="h-10 w-10 rounded-md bg-zinc-800 border border-zinc-700/60 flex items-center justify-center flex-shrink-0">
                          <FileText className="h-5 w-5 text-emerald-400" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-zinc-200 truncate">{attachmentFile.name}</p>
                        <p className="text-[10px] text-zinc-500 truncate">{attachmentKind(attachmentFile)} · {formatFileSize(attachmentFile.size)}</p>
                      </div>
                    </div>
                    <button onClick={removeAttachment} className="text-zinc-500 hover:text-zinc-300 p-1 flex-shrink-0" title="Remove attachment"><X className="w-4 h-4" /></button>
                  </div>
                )}
                <textarea
                  value={composerText}
                  onChange={(e) => setComposerText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && canSend) { e.preventDefault(); void onSend(); } }}
                  placeholder={twilioSuspended ? 'Messaging unavailable' : activeThread ? 'Type a message' : 'Type a message...'}
                  disabled={twilioSuspended}
                  className="w-full min-h-[42px] max-h-[120px] py-2.5 px-4 bg-zinc-800/80 border border-zinc-700/50 rounded-lg text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 resize-none disabled:opacity-50"
                  rows={1}
                />
              </div>
              <button disabled={!canSend} onClick={() => void onSend()} className={`p-2.5 rounded-lg transition-all flex-shrink-0 ${canSend ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-zinc-800 text-zinc-600'}`} title="Send">
                {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {/* Send Info */}
          {sendInfo && (
            <div className="px-4 pb-2 bg-[var(--bg-surface)]">
              <p className={`text-[10px] font-medium text-center ${sendInfo.toLowerCase().includes('success') || sendInfo.toLowerCase().includes('sent') ? 'text-emerald-400' : 'text-amber-400'}`}>
                {sendInfo}
              </p>
              {sendDiagnostic && (
                <div className="mx-auto mt-2 max-w-lg rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-100">
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {sendDiagnostic.phase && <span>Phase: {sendDiagnostic.phase}</span>}
                    {sendDiagnostic.code && <span>Code: {sendDiagnostic.code}</span>}
                    {sendDiagnostic.diagnosticId && <span>ID: {sendDiagnostic.diagnosticId}</span>}
                  </div>
                  {sendDiagnostic.moreInfo && <p className="mt-1 text-center text-amber-200/80">{sendDiagnostic.moreInfo}</p>}
                </div>
              )}
              {!sendDiagnostic && diagnostics[0]?.status === 'failed' && (
                <p className="mt-1 text-center text-[10px] text-zinc-500">
                  Latest diagnostic: {diagnostics[0].phase} · {diagnostics[0].twilioMessage || diagnostics[0].mediaFilename || diagnostics[0].id}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => {
        const file = e.target.files?.[0] || null;
        selectAttachment(file);
        e.currentTarget.value = '';
      }} />
    </div>
  );
}
