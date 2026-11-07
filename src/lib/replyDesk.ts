/**
 * The Reply Desk: every reply a school has sent, what to do about it, and a draft to start from.
 * A draft is only a starting point: a rep reads it and sends it from their own mail or Messaging.
 */
import type { SchoolLeadRow } from '../api/sheetsClient';
import { hasReplied } from './leadInsights';
import { OPEN_STAGES, bookingLink, field, isDoNotContact, stageOf, timeOf, whatsappWindowLeftMs } from './pipeline';

/** answer: draft ready. read: a person decides. close: they said no. opt_out: never reply. auto: nothing to do. */
export type ReplyAction = 'answer' | 'read' | 'close' | 'opt_out' | 'auto';
export type ReplyChannel = 'email' | 'whatsapp';

export type ReplyItem = {
  row: SchoolLeadRow;
  channel: ReplyChannel;
  text: string;
  intent: string;
  confidence: number | null;
  at: number | null;
  action: ReplyAction;
  reason: string;
  /** Still waiting on us. */
  open: boolean;
  windowLeftMs: number | null;
};

/** Below this the classifier is guessing, so a person reads the reply first. */
export const MIN_CONFIDENCE = 0.6;

const OPT_OUT = /\b(stop|unsubscribe|opt[\s-]?out|remove me|do not (contact|message|email|call))\b/i;
const ESCALATE = /\b(lawyer|legal notice|legal action|harass\w*|complaint|report(ing)? (you|this)|spam)\b/i;
const OPT_OUT_INTENT = /stop|unsub|opt.?out|dnc/;
const NO_INTENT = /negative|not.?interested|reject|no.?thanks/;
const AUTO_INTENT = /auto.?reply|out.?of.?office|ooo/;
const ACTION_ORDER: ReplyAction[] = ['read', 'answer', 'opt_out', 'close', 'auto'];

function confidenceOf(row: SchoolLeadRow): number | null {
  const raw = field(row, 'Reply_confidence');
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

export function classifyReply(text: string, intent: string, confidence: number | null): { action: ReplyAction; reason: string } {
  // The words win over the label: a missed opt-out or legal threat costs far more than a second look.
  if (OPT_OUT.test(text) || OPT_OUT_INTENT.test(intent)) return { action: 'opt_out', reason: 'They asked to stop. Never reply.' };
  if (ESCALATE.test(text)) return { action: 'read', reason: 'Complaint or legal wording. Read it yourself.' };
  if (AUTO_INTENT.test(intent)) return { action: 'auto', reason: 'Automatic reply' };
  if (NO_INTENT.test(intent)) return { action: 'close', reason: 'They said no. Thank them or close it, and do not pitch again.' };
  if (!text) return { action: 'read', reason: 'The reply text was not saved. Open the thread.' };
  if (confidence !== null && confidence < MIN_CONFIDENCE) return { action: 'read', reason: 'The classifier is unsure. Read it yourself.' };
  return { action: 'answer', reason: intent ? `Intent: ${intent.replace(/_/g, ' ')}` : 'No intent recorded' };
}

function isAnswered(row: SchoolLeadRow, at: number | null): boolean {
  const touched = Math.max(timeOf(row, 'First_touch_at') ?? 0, timeOf(row, 'Warm_reply_at') ?? 0);
  const stage = stageOf(row);
  return (
    (at !== null && touched >= at) ||
    /warm reply sent/i.test(field(row, 'Reply_Status')) ||
    Boolean(field(row, 'Next_step')) ||
    (OPEN_STAGES.includes(stage) && stage !== 'Engaged')
  );
}

export function toReplyItem(row: SchoolLeadRow, now = Date.now()): ReplyItem {
  const whatsapp = field(row, 'Reply_channel') === 'whatsapp' || (!field(row, 'Reply_channel') && Boolean(field(row, 'whatsapp_reply_message')));
  const text = field(row, 'Reply_snippet') || field(row, 'whatsapp_reply_message');
  const intent = (field(row, 'Reply_intent') || field(row, 'whatsapp_reply_category')).toLowerCase();
  const confidence = confidenceOf(row);
  const at = timeOf(row, 'Replied_at');
  const { action, reason } = classifyReply(text, intent, confidence);
  const stage = stageOf(row);
  const closed = isDoNotContact(row) || stage === 'Won' || stage === 'Lost';
  return {
    row,
    channel: whatsapp ? 'whatsapp' : 'email',
    text,
    intent,
    confidence,
    at,
    action,
    reason,
    open: !closed && action !== 'auto' && (action === 'opt_out' || !isAnswered(row, at)),
    windowLeftMs: whatsappWindowLeftMs(row, now),
  };
}

/** Open replies first, the ones needing judgement at the top of those, then newest. */
export function listReplies(rows: SchoolLeadRow[], now = Date.now()): ReplyItem[] {
  return rows
    .filter(hasReplied)
    .map((row) => toReplyItem(row, now))
    .sort(
      (a, b) =>
        Number(b.open) - Number(a.open) ||
        ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) ||
        (b.at ?? 0) - (a.at ?? 0)
    );
}

export function draftReply(item: ReplyItem, sender: string): string {
  if (item.action !== 'answer') return '';
  const name = field(item.row, 'Principal Name');
  const link = bookingLink(field(item.row, 'Lead_id'));
  const hello = name ? `Hello ${name},` : 'Hello,';
  const close = item.channel === 'email' ? `\n\nRegards,\n${sender}\nLearnXR, Altie Reality` : '';
  let body: string;
  if (/demo/.test(item.intent)) {
    body = `Thanks for your reply. You can pick a time for the demo here: ${link}\n\nIf another day suits you better, tell me and I'll arrange it.`;
  } else if (/pric|cost|quote/.test(item.intent)) {
    body = `Thanks for asking. It depends on your student numbers and the package that fits, so I'd rather give you an exact figure than a guess.\n\nHow many students would use it? You can also pick a time for a short call: ${link}`;
  } else if (/positive|interested/.test(item.intent)) {
    body = `Glad this looks useful. The best next step is a short demo so you can see a lesson yourself. You can pick a time here: ${link}`;
  } else {
    // Never guess an answer about the product: the rep writes this part.
    body = `Thanks for your message.\n\n[Write your answer here]`;
  }
  return `${hello}\n\n${body}${close}`;
}

export type DraftIssue = { level: 'block' | 'warn'; message: string };

const URL_RE = /https?:\/\/\S+/gi;
const FILLER = /\b(just checking in|just following up|hope this (email )?finds you well|circle back|touch base)\b/i;
const PRICE_WORDS = /₹|\bpric(e|es|ed|ing)\b|\bmargins?\b|\bcommissions?\b|\b(rs\.?|inr)\s*\d/i;
const MAX_WORDS = 120;

/** Rule checks on a draft before it leaves. Same pricing and placeholder rules as n8n "Sales • Warm Reply". */
export function checkDraft(text: string): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const links = text.match(URL_RE) || [];
  const words = text.replace(URL_RE, ' ');
  if (!text.trim()) issues.push({ level: 'block', message: 'The draft is empty.' });
  // Links are removed first: the booking link has [leadId] in it.
  const placeholder = words.match(/\{[^}]*\}|\[[^\]]*\]/);
  if (placeholder) issues.push({ level: 'block', message: `Fill in ${placeholder[0]} first.` });
  if (PRICE_WORDS.test(words)) issues.push({ level: 'warn', message: 'Mentions pricing or terms: check these are approved.' });
  const filler = words.match(FILLER);
  if (filler) issues.push({ level: 'warn', message: `Cut the filler: "${filler[0]}".` });
  if (links.length > 1) issues.push({ level: 'warn', message: `${links.length} links. One is enough.` });
  const count = words.trim().split(/\s+/).filter(Boolean).length;
  if (count > MAX_WORDS) issues.push({ level: 'warn', message: `${count} words. Keep it under ${MAX_WORDS}.` });
  return issues;
}
