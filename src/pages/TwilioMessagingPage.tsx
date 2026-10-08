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
import { Link, useSearchParams } from 'react-router-dom';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { Avatar } from '../components/ui/avatar';
import { useAuth } from '../context/AuthContext';
import type { SchoolLeadRow } from '../api/sheetsClient';
import { useSheetLeads } from '../lib/useSheetLeads';
import { useAppSettings } from '../lib/useAppSettings';
import { useLeadUpdate } from '../lib/useLeadUpdate';
import {
  BOOKING_URL,
  WHATSAPP_WINDOW_MS,
  bookingLink,
  field,
  isChannelPartner,
  ownerLabel,
  stageOf,
  whatsappWindowLeftMs,
} from '../lib/pipeline';
import { arrangeTemplates, sentTemplates, suggestedKeys, templatesFor, type Audience } from '../lib/waTemplates';
import {
  fetchTwilioHealth,
  fetchTwilioStatuses,
  getTwilioMessage,
  isTwilioStatusTerminal,
  listTwilioSendDiagnostics,
  listTwilioInboundMessages,
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
const INBOUND_POLL_MS = 12000;
const MAX_WHATSAPP_MEDIA_BYTES = 16 * 1024 * 1024;
const SUPPORTED_ATTACHMENT_TYPES = /^(image\/|video\/|audio\/|application\/pdf$)/i;
/** Per-browser "last opened" time for each chat; unread counts are inbound messages after it. */
const SEEN_STORAGE_KEY = 'twilio_thread_seen_at';
/** Roles that can read the lead sheet, so chats can show the school and its stage. */
const LEAD_ROLES = ['superadmin', 'associate', 'salesperson'];

type TwilioServiceState = 'unknown' | 'ok' | 'suspended';
type SeenAt = Record<string, number>;

function normalizeParty(value: string | undefined): string {
  if (!value) return 'Unknown';
  return value.replace(/^whatsapp:/i, '').trim() || 'Unknown';
}

/** Always a WhatsApp address: a bare +E164 number would otherwise go out as an SMS. */
function normalizeRecipient(value: string): string {
  const val = value.trim().replace(/[\s()-]/g, '');
  if (!val) return '';
  if (val.startsWith('whatsapp:')) return val;
  if (val.startsWith('+')) return `whatsapp:${val}`;
  if (/^\d{10}$/.test(val)) return `whatsapp:+91${val}`;
  if (/^0\d{10}$/.test(val)) return `whatsapp:+91${val.slice(1)}`;
  if (/^\d+$/.test(val)) return `whatsapp:+${val}`;
  return `whatsapp:${val}`;
}

/** E.164 form used to match a chat to a lead (the sheet stores Indian numbers in many formats). */
function e164(value: string): string {
  const raw = value.replace(/^whatsapp:/i, '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return `+${digits}`;
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}

function readSeen(): SeenAt {
  try {
    const seen = JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) || '{}') as SeenAt;
    // The first visit counts everything older as read, so old chats don't all light up.
    if (!seen.__since) seen.__since = Date.now();
    return seen;
  } catch {
    return { __since: Date.now() };
  }
}

function writeSeen(seen: SeenAt) {
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // Private windows can refuse storage; unread counts then reset on reload.
  }
}

function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{(\d+)\}\}/g, (match, key: string) => values[key] || match);
}

/** Our lxr_* templates share one variable convention (see selectTemplate) and an _en / _hi suffix. */
const LXR_TEMPLATE = /^lxr_/;

function templateLabel(t: TwilioTemplate): string {
  const lang = t.name.endsWith('_hi') ? 'हिंदी' : t.name.endsWith('_en') ? 'EN' : '';
  const base = LXR_TEMPLATE.test(t.name) ? t.name.replace(/^lxr_(partner|school)_/, '').replace(/_(en|hi)$/, '').replace(/_/g, ' ') : t.name;
  return lang ? `${base} · ${lang}` : base;
}

/** Channel partner, then school, then everything else; onboarding steps in order, English before Hindi. */
function groupTemplates(templates: TwilioTemplate[]): Array<[string, TwilioTemplate[]]> {
  const groups: Array<[string, RegExp]> = [
    ['Channel partner', /^lxr_partner_/],
    ['School', /^lxr_school_/],
  ];
  const rank = (name: string) => (/_step\d/.test(name) ? 1 : 0) + (name.endsWith('_hi') ? 0.5 : 0);
  const ordered = (items: TwilioTemplate[]) =>
    [...items].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  const result: Array<[string, TwilioTemplate[]]> = groups
    .map(([label, re]): [string, TwilioTemplate[]] => [label, ordered(templates.filter((t) => re.test(t.name)))])
    .filter(([, items]) => items.length > 0);
  const other = templates.filter((t) => !groups.some(([, re]) => re.test(t.name)));
  if (other.length) result.push(['Other', other]);
  return result;
}

function templateOption(t: TwilioTemplate, suffix = '') {
  return (
    <option key={t.sid} value={t.sid}>
      {templateLabel(t)}
      {t.category ? ` · ${t.category.toLowerCase()}` : ''}
      {suffix}
    </option>
  );
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

function buildThreads(messages: TwilioMessage[], seen: SeenAt): Thread[] {
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
    const seenAt = Math.max(seen[key] || 0, seen.__since || 0);
    const unreadCount = sorted.filter((m) => isInbound(m.direction) && messageTime(m) > seenAt).length;
    const lastTextRaw = (last && last.body) || (last && Array.isArray(last.media) && last.media.length > 0 ? 'Attachment' : '(No text)');
    threads.push({ id: key, contact: key, sendTo: preferredAddress, lastText: String(lastTextRaw).slice(0, 72), lastAt: messageTime(last), unreadCount, messages: sorted });
  }
  threads.sort((a, b) => b.lastAt - a.lastAt);
  return threads;
}

function mergeMessages(current: TwilioMessage[], incoming: TwilioMessage[]): TwilioMessage[] {
  const map = new Map<string, TwilioMessage>();
  for (const message of current) {
    if (message.sid) map.set(message.sid, message);
  }
  for (const message of incoming) {
    if (!message.sid) continue;
    map.set(message.sid, { ...(map.get(message.sid) || {}), ...message });
  }
  return [...map.values()].sort((a, b) => messageTime(a) - messageTime(b));
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
  const appSettings = useAppSettings();
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
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [deepLinkContact, setDeepLinkContact] = useState<string | null>(null);
  const [seen, setSeen] = useState<SeenAt>(readSeen);
  const [templateSid, setTemplateSid] = useState('');
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  // Within the 24-hour window the composer is free text; this switches it to the template picker.
  const [forceTemplate, setForceTemplate] = useState(false);

  const { user } = useAuth();
  const me = (user?.email || '').toLowerCase();
  const { leads, replaceLead } = useSheetLeads({ enabled: Boolean(user && LEAD_ROLES.includes(user.role)) });
  const { update: updateLead, busy: leadBusy, error: leadError } = useLeadUpdate(replaceLead);
  const leadByPhone = useMemo(() => {
    const map = new Map<string, SchoolLeadRow>();
    for (const row of leads) {
      for (const key of ['WhatsApp_number', 'Phone number']) {
        const phone = e164(field(row, key));
        if (phone && !map.has(phone)) map.set(phone, row);
      }
    }
    return map;
  }, [leads]);
  const leadFor = useCallback((contact: string) => leadByPhone.get(e164(contact)) || null, [leadByPhone]);

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
      setLoadedOnce(true);
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
    void listTwilioTemplates().then((items) => {
      setTemplates(items);
    }).catch(() => setTemplates([]));
    void listTwilioSendDiagnostics(10).then(setDiagnostics).catch(() => setDiagnostics([]));
  }, [serviceState]);

  useEffect(() => {
    if (serviceState === 'suspended') return;
    let cancelled = false;
    const refreshInbound = async () => {
      try {
        const inbound = await listTwilioInboundMessages(100);
        if (!cancelled && inbound.length) setMessages((prev) => mergeMessages(prev, inbound));
      } catch {
        // keep the Twilio list as fallback when Firestore inbound polling is transiently unavailable
      }
    };
    void refreshInbound();
    const id = setInterval(() => void refreshInbound(), INBOUND_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [serviceState]);

  // Deep link from leads and alerts: /twilio-messaging?contact=+91...
  useEffect(() => {
    const contact = searchParams.get('contact');
    if (contact) setDeepLinkContact(e164(contact) || normalizeParty(contact));
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
  const threads = useMemo(() => buildThreads(messages, seen), [messages, seen]);
  const filteredThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter((thread) => {
      if (thread.contact.toLowerCase().includes(q)) return true;
      const lead = leadFor(thread.contact);
      if (lead && field(lead, 'School Name').toLowerCase().includes(q)) return true;
      return thread.messages.some((m) => String(m.body || '').toLowerCase().includes(q));
    });
  }, [threads, search, leadFor]);

  // Once the first page has loaded, open the linked chat, or a new chat when there is no history with that number.
  useEffect(() => {
    if (!deepLinkContact || !loadedOnce) return;
    if (threads.some((t) => t.id === deepLinkContact)) {
      setSelectedThreadId(deepLinkContact);
      setIsNewChatMode(false);
    } else {
      setSelectedThreadId(null);
      setIsNewChatMode(true);
      setManualTo(deepLinkContact);
    }
    setDeepLinkContact(null);
  }, [deepLinkContact, loadedOnce, threads]);

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
  const activeContact = isNewChatMode ? normalizedManualTo : activeThread?.contact || '';
  const activeLead = activeContact ? leadFor(activeContact) : null;
  const activeLeadOwner = activeLead ? field(activeLead, 'Owner').toLowerCase() : '';

  // WhatsApp allows free-form messages only within 24 hours of the contact's last message. The sheet's
  // reply time covers chats whose messages aren't in the loaded history.
  const lastInbound = activeThread && !isNewChatMode ? threadLastInbound(activeThread) : null;
  const templateOnly = !(
    (lastInbound && Date.now() - messageTime(lastInbound) < WHATSAPP_WINDOW_MS) ||
    (activeLead && whatsappWindowLeftMs(activeLead) !== null)
  );
  const templateMode = templateOnly || forceTemplate;

  // A partner's chat offers partner templates, a school's chat school ones; the next step is suggested and
  // templates this contact already got (read from our sent messages) go last.
  const audience: Audience = activeLead ? (isChannelPartner(activeLead) ? 'partner' : 'school') : 'all';
  const templateOptions = useMemo(() => {
    const offered = templatesFor(templates, audience);
    const sentBodies = (activeThread && !isNewChatMode ? activeThread.messages : [])
      .filter((m) => !isInbound(m.direction) && !['failed', 'undelivered'].includes(String(m.status || '').toLowerCase()))
      .sort((a, b) => messageTime(a) - messageTime(b))
      .map((m) => m.body || '');
    const sent = sentTemplates(offered, sentBodies);
    const suggested = suggestedKeys(offered, audience, sent.keys, {
      stage: activeLead ? stageOf(activeLead) : 'New',
      replyIntent: activeLead ? field(activeLead, 'Reply_intent') : '',
    });
    return { offered, ...arrangeTemplates(offered, suggested, sent.keys, sent.lastLang) };
  }, [templates, audience, activeThread, isNewChatMode, activeLead]);
  const selectedTemplate = templates.find((t) => t.sid === templateSid) || null;
  const missingTemplateVars = (selectedTemplate?.variableKeys || []).filter((key) => !templateVars[key]?.trim());
  const cannedReplies = [
    {
      label: 'Booking link',
      text: `You can pick a time for a 30-minute LearnXR demo here: ${
        activeLead && field(activeLead, 'Lead_id') ? bookingLink(field(activeLead, 'Lead_id')) : BOOKING_URL
      }`,
    },
    { label: 'Ask for a call time', text: 'Thanks for your interest in LearnXR! When is a good time for a quick call?' },
    // Team templates from Admin → Settings; {{name}} and {{school}} are filled from the lead.
    ...(appSettings?.replyTemplates || []).map((t) => ({
      label: t.title,
      text: t.body
        .replace(/\{\{\s*name\s*\}\}/gi, (activeLead && field(activeLead, 'Principal Name')) || 'there')
        .replace(/\{\{\s*school\s*\}\}/gi, (activeLead && field(activeLead, 'School Name')) || 'your school'),
    })),
  ];

  const selectTemplate = (sid: string) => {
    setTemplateSid(sid);
    const template = templates.find((t) => t.sid === sid);
    if (template && LXR_TEMPLATE.test(template.name)) {
      // {{1}} = recipient's first name, {{2}} = sender's name; {{3}} (a link or date) is typed per send.
      const firstName = (s: string) => s.trim().split(/\s+/)[0] || '';
      const vars: Record<string, string> = {};
      for (const key of template.variableKeys || []) {
        if (key === '1') vars[key] = activeLead ? firstName(field(activeLead, 'Principal Name')) : '';
        else if (key === '2') vars[key] = firstName(user?.name || '');
        else vars[key] = '';
      }
      setTemplateVars(vars);
      return;
    }
    setTemplateVars({ ...(template?.variables || {}) });
  };

  // Opening a chat marks it read in this browser.
  const activeThreadKey = isNewChatMode ? undefined : activeThread?.id;
  // Another chat may be offered other templates.
  useEffect(() => {
    setForceTemplate(false);
    setTemplateSid('');
    setTemplateVars({});
  }, [activeThreadKey]);
  const activeThreadLastAt = activeThread?.lastAt;
  useEffect(() => {
    if (!activeThreadKey) return;
    setSeen((prev) => {
      const next = { ...prev, [activeThreadKey]: Date.now() };
      writeSeen(next);
      return next;
    });
  }, [activeThreadKey, activeThreadLastAt]);

  // Numbers that belong to a lead are claimed through the lead's Owner; others use chat assignments.
  const hasActiveLead = Boolean(activeLead);
  useEffect(() => {
    const threadId = activeThread?.sendTo || activeThread?.contact;
    if (!threadId || isNewChatMode || hasActiveLead) {
      setAssignment(null);
      return;
    }
    void fetchLeadAssignment(threadId).then(setAssignment).catch(() => setAssignment(null));
  }, [activeThread?.sendTo, activeThread?.contact, isNewChatMode, hasActiveLead]);

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
    if (!to) return;
    if (templateMode ? !selectedTemplate || missingTemplateVars.length > 0 : !text && !attachmentFile) return;
    setSending(true); setSendInfo(null); setSendDiagnostic(null);
    try {
      setAutoScroll(true);
      let mediaUrl: string | undefined;
      let mediaFilename: string | undefined;
      if (!templateMode && attachmentFile) {
        setSendInfo(`Uploading ${attachmentFile.name}…`);
        if (!firebaseEnabled) throw new Error('Firebase is not configured for media uploads.');
        const uploaded = await uploadTwilioMediaToStorage(attachmentFile, { pathPrefix: 'twilio-media' });
        mediaUrl = uploaded.downloadUrl;
        mediaFilename = attachmentFile.name;
        setSendInfo('Media uploaded. Sending to WhatsApp…');
      }
      const bodyToSend = attachmentFile ? (text || `Please review ${attachmentFile.name}.`) : text;
      const sent = await sendTwilioMessage(
        templateMode && selectedTemplate
          ? {
              to,
              body: '',
              templateSid: selectedTemplate.sid,
              templateVariables: Object.fromEntries(
                (selectedTemplate.variableKeys || []).map((key) => [key, templateVars[key].trim()])
              ),
            }
          : { to, body: bodyToSend, mediaUrl, mediaFilename, templateSid: undefined }
      );
      // A WhatsApp sent to a lead counts as its first touch for speed-to-lead (the sheet keeps the first one).
      if (activeLead) void updateLead(activeLead, { touch: 'whatsapp' }, {}, 'touch');
      if (templateMode) {
        setTemplateSid('');
        setTemplateVars({});
        setForceTemplate(false);
      }
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

  const claimOwner = activeLead
    ? activeLeadOwner
    : String(assignment?.assignedToEmail || (assignment?.assignedTo ? 'Claimed' : ''));
  const claimSaving = activeLead ? Boolean(leadBusy) : assignmentSaving;
  const recipient = activeThread ? activeThread.sendTo : manualTo.trim();
  const canSend = Boolean(
    recipient &&
      !sending &&
      !twilioSuspended &&
      (templateMode ? selectedTemplate && !missingTemplateVars.length : composerText.trim() || attachmentFile)
  );

  const removeAttachment = () => {
    if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
    setAttachmentPreviewUrl(null); setAttachmentFile(null);
  };

  const onAssignment = async (action: 'claim' | 'unclaim') => {
    if (activeLead) {
      const claim = action === 'claim';
      await updateLead(activeLead, { fields: { Owner: claim ? 'me' : '' } }, { Owner: claim ? me : '' }, 'claim');
      return;
    }
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
                const lead = leadFor(thread.contact);
                const title = (lead && field(lead, 'School Name')) || thread.contact;
                return (
                  <button key={thread.id} onClick={() => { setSelectedThreadId(thread.id); setIsNewChatMode(false); }} className={`chat-thread-item ${selected ? 'active' : ''}`}>
                    <Avatar name={title} size="md" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <p className="text-[13px] font-medium text-zinc-200 truncate" title={thread.contact}>{title}</p>
                        <span className="text-[10px] text-zinc-600 flex-shrink-0 ml-2">{smartDate(thread.lastAt)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="text-[12px] text-zinc-500 truncate">{thread.lastText || 'Sent media'}</p>
                        <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                          {lead && <span className="text-[9px] text-indigo-300">{stageOf(lead)}</span>}
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
              <Avatar name={activeLead ? field(activeLead, 'School Name') : isNewChatMode ? 'New' : activeThread?.contact} size="md" />
              <div>
                <h3 className="text-sm font-semibold text-zinc-100">
                  {activeLead
                    ? field(activeLead, 'School Name') || normalizeParty(activeContact)
                    : isNewChatMode ? 'New Conversation' : activeThread ? activeThread.contact : 'Select a chat'}
                </h3>
                <p className="text-[11px] text-zinc-500">
                  {activeLead ? (
                    <>
                      {normalizeParty(activeContact)} · {stageOf(activeLead)}
                      {field(activeLead, 'Lead_id') && (
                        <>
                          {' · '}
                          <Link to={`/sales?lead=${encodeURIComponent(field(activeLead, 'Lead_id'))}`} className="text-sky-400 hover:underline">
                            Open lead
                          </Link>
                        </>
                      )}
                    </>
                  ) : isNewChatMode
                    ? 'Enter recipient below'
                    : activeThread
                      ? (() => {
                          const st = followUpState(activeThread).lastOutboundStatus;
                          const badge = outboundStatusBadge(st);
                          return badge ? `WhatsApp · Last outbound: ${badge.label}` : 'WhatsApp';
                        })()
                      : ''}
                </p>
                {leadError && <p className="text-[10px] text-amber-400">{leadError}</p>}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {(activeLead || (activeThread && !isNewChatMode)) && (
                <>
                  {claimOwner ? (
                    <Badge variant="info" className="mr-2 text-[9px]">
                      {claimOwner === me ? 'You' : claimOwner.includes('@') ? ownerLabel(claimOwner) : claimOwner}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="mr-2 text-[9px]">Unassigned</Badge>
                  )}
                  {(!activeLead || !activeLeadOwner || activeLeadOwner === me) && (
                    <button
                      onClick={() => void onAssignment(claimOwner ? 'unclaim' : 'claim')}
                      disabled={claimSaving}
                      className="mr-2 rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 transition-all hover:bg-zinc-800 disabled:opacity-40"
                    >
                      {claimSaving ? 'Saving...' : claimOwner ? 'Unclaim' : 'Claim'}
                    </button>
                  )}
                </>
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
              {!templateMode && (
                <button onClick={() => fileInputRef.current?.click()} disabled={!firebaseEnabled || twilioSuspended} className="p-2.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-all disabled:opacity-30 flex-shrink-0" title="Attach file">
                  <Paperclip className="w-5 h-5" />
                </button>
              )}
              <div className="flex-1 relative">
                {templateMode ? (
                  <div className="space-y-2">
                    {templateOnly ? (
                      <p className="text-[10px] text-amber-300">
                        {lastInbound || (activeLead && field(activeLead, 'Replied_at'))
                          ? 'Their last message was more than 24 hours ago, so WhatsApp only allows an approved template.'
                          : 'WhatsApp only allows an approved template to start a chat.'}
                      </p>
                    ) : (
                      <p className="flex items-center justify-between text-[10px] text-zinc-400">
                        Send an approved template, with its buttons.
                        <button type="button" onClick={() => setForceTemplate(false)} className="text-sky-400 hover:underline">
                          Type a message instead
                        </button>
                      </p>
                    )}
                    {templateOptions.suggested.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] text-zinc-500">Suggested next:</span>
                        {templateOptions.suggested.map((t) => (
                          <button
                            key={t.sid}
                            type="button"
                            onClick={() => selectTemplate(t.sid)}
                            className={`rounded-md border px-2 py-0.5 text-[10px] ${
                              templateSid === t.sid
                                ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200'
                                : 'border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10'
                            }`}
                          >
                            {templateLabel(t)}
                          </button>
                        ))}
                      </div>
                    )}
                    <Select value={templateSid} onChange={(e) => selectTemplate(e.target.value)} disabled={twilioSuspended} className="h-9 text-xs">
                      <option value="">{templateOptions.offered.length ? 'Choose a template…' : 'No approved templates loaded'}</option>
                      {templateOptions.suggested.length > 0 && (
                        <optgroup label="Suggested next">{templateOptions.suggested.map((t) => templateOption(t))}</optgroup>
                      )}
                      {groupTemplates(templateOptions.rest).map(([group, items]) => (
                        <optgroup key={group} label={group}>
                          {items.map((t) => templateOption(t))}
                        </optgroup>
                      ))}
                      {templateOptions.sent.length > 0 && (
                        <optgroup label="Already sent">{templateOptions.sent.map((t) => templateOption(t, ' · sent'))}</optgroup>
                      )}
                    </Select>
                    {selectedTemplate && (
                      <>
                        {(selectedTemplate.variableKeys || []).map((key) => (
                          <Input
                            key={key}
                            value={templateVars[key] || ''}
                            onChange={(e) => setTemplateVars({ ...templateVars, [key]: e.target.value })}
                            placeholder={`Value for {{${key}}}`}
                            className="h-8 text-xs"
                          />
                        ))}
                        <p className="max-h-28 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-[11px] text-zinc-400">
                          {fillTemplate(selectedTemplate.body || '', templateVars)}
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                <>
                {!twilioSuspended && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setForceTemplate(true)}
                      className="rounded-md border border-emerald-500/40 px-2 py-0.5 text-[10px] text-emerald-300 hover:bg-emerald-500/10"
                    >
                      Send a template
                    </button>
                    {cannedReplies.map((reply) => (
                      <button
                        key={reply.label}
                        type="button"
                        onClick={() => setComposerText(reply.text)}
                        className="rounded-md border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
                      >
                        {reply.label}
                      </button>
                    ))}
                  </div>
                )}
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
                </>
                )}
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
