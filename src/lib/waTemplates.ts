import type { TwilioTemplate } from '../api/twilioClient';
import type { Stage } from './pipeline';

/** Who the open chat is with: decides which templates are offered. */
export type Audience = 'partner' | 'school' | 'all';

/** A template's step without its language: lxr_partner_step2_product_kit_en → lxr_partner_step2_product_kit. */
export function templateKey(name: string): string {
  return name.replace(/_(en|hi)$/, '');
}

function templateLang(name: string): 'en' | 'hi' | '' {
  return name.endsWith('_hi') ? 'hi' : name.endsWith('_en') ? 'en' : '';
}

/** Partners get partner templates; schools get school templates and the older ones; unknown numbers get all. */
export function templatesFor(templates: TwilioTemplate[], audience: Audience): TwilioTemplate[] {
  if (audience === 'partner') return templates.filter((t) => t.name.startsWith('lxr_partner_'));
  if (audience === 'school') return templates.filter((t) => !t.name.startsWith('lxr_partner_'));
  return templates;
}

/** Matches a sent message against a template body: the fixed text in order, anything where {{n}} was. */
export function templateRegex(body: string): RegExp {
  const pieces = body
    .trim()
    .split(/\{\{\d+\}\}/)
    .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return new RegExp(`^${pieces.join('[\\s\\S]*?')}`);
}

/** The older school replies and their newer versions with a call line: sending either counts as sent. */
const REPLACED_BY: Record<string, string> = {
  positive_reply: 'lxr_school_reply_positive',
  demo_reply: 'lxr_school_reply_demo',
  pricing_reply: 'lxr_school_reply_pricing',
  neutral_reply: 'lxr_school_reply_neutral',
  negative_reply: 'lxr_school_reply_negative',
};

/**
 * Which templates (by key, any language) appear among the messages we sent, oldest first, and the language
 * of the last one.
 */
export function sentTemplates(
  templates: TwilioTemplate[],
  sentBodies: string[]
): { keys: Set<string>; lastLang: 'en' | 'hi' | '' } {
  // A template that is mostly variables (agent_reply is just {{1}}) would match any message, so it's skipped;
  // when several match, the one with the most fixed text wins.
  const fixedLength = (body: string) => body.replace(/\{\{\d+\}\}/g, '').replace(/\s+/g, '').length;
  const matchers = templates
    .filter((t) => fixedLength(t.body || '') >= 20)
    .sort((a, b) => fixedLength(b.body || '') - fixedLength(a.body || ''))
    .map((t) => ({ t, re: templateRegex(t.body || '') }));
  const keys = new Set<string>();
  let lastLang: 'en' | 'hi' | '' = '';
  for (const body of sentBodies) {
    const text = body.trim();
    const hit = matchers.find(({ re }) => re.test(text));
    if (!hit) continue;
    keys.add(templateKey(hit.t.name));
    const replacement = REPLACED_BY[hit.t.name];
    if (replacement) keys.add(replacement);
    lastLang = templateLang(hit.t.name) || lastLang;
  }
  return { keys, lastLang };
}

const PARTNER_FIRST = ['lxr_partner_form', 'lxr_partner_book_call'];
const AFTER_DEMO: readonly Stage[] = ['Demo done', 'Proposal', 'Won'];
const REPLY_FOR_INTENT: Record<string, string> = {
  demo: 'demo',
  pricing: 'pricing',
  positive: 'positive',
  question: 'neutral',
  neutral: 'neutral',
  negative: 'negative',
  not_interested: 'negative',
};

/** The step after the last one sent, skipping steps without an approved template. */
function nextStep(available: Set<string>, sent: Set<string>, prefix: string): string[] {
  const steps = [...available].filter((key) => key.startsWith(prefix)).sort((a, b) => stepNo(a) - stepNo(b));
  const last = steps.reduce((idx, key, i) => (sent.has(key) ? i : idx), -1);
  const next = steps.slice(last + 1).find((key) => !sent.has(key));
  return next ? [next] : [];
}

function stepNo(key: string): number {
  return Number(/_step(\d+)/.exec(key)?.[1] || 0);
}

/** The template keys to suggest next for this contact, given what was already sent. */
export function suggestedKeys(
  templates: TwilioTemplate[],
  audience: Audience,
  sent: Set<string>,
  lead: { stage: Stage; replyIntent: string }
): string[] {
  const available = new Set(templates.map((t) => templateKey(t.name)));
  if (audience === 'partner') {
    if (!PARTNER_FIRST.some((key) => sent.has(key)) && ![...sent].some((key) => key.startsWith('lxr_partner_step'))) {
      return PARTNER_FIRST.filter((key) => available.has(key));
    }
    return nextStep(available, sent, 'lxr_partner_step');
  }
  if (audience === 'school') {
    if (AFTER_DEMO.includes(lead.stage)) return nextStep(available, sent, 'lxr_school_step');
    const reply = `lxr_school_reply_${REPLY_FOR_INTENT[lead.replyIntent.toLowerCase()] || 'positive'}`;
    return available.has(reply) && !sent.has(reply) ? [reply] : [];
  }
  return [];
}

/** Splits the offered templates into suggested (preferred language first), the rest, and already sent. */
export function arrangeTemplates(
  templates: TwilioTemplate[],
  suggested: string[],
  sent: Set<string>,
  lastLang: 'en' | 'hi' | ''
): { suggested: TwilioTemplate[]; rest: TwilioTemplate[]; sent: TwilioTemplate[] } {
  const langRank = (t: TwilioTemplate) => (templateLang(t.name) === (lastLang || 'en') ? 0 : 1);
  return {
    suggested: suggested.flatMap((key) =>
      templates.filter((t) => templateKey(t.name) === key).sort((a, b) => langRank(a) - langRank(b))
    ),
    rest: templates.filter((t) => !suggested.includes(templateKey(t.name)) && !sent.has(templateKey(t.name))),
    sent: templates.filter((t) => sent.has(templateKey(t.name))),
  };
}
