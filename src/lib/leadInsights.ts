/**
 * Email engagement insights computed from the `school data` sheet rows.
 *
 * Column names mirror the n8n "Sales Funnel (v2)" and "Follow Up (v2)" workflows:
 * click flags are written by the ZeptoMail click webhook (scanner clicks excluded),
 * `Email_template_id` by the first-email template assignment.
 */
import type { SchoolLeadRow } from '../api/sheetsClient';

export type Intent = 'demo' | 'pricing' | 'whatsapp' | 'website' | 'video';

/** Mirrors TEMPLATES in the n8n "Assign Email Template" node. */
export const EMAIL_TEMPLATE_LABELS: Record<string, string> = {
  t01_control: 'Control: outcomes + single WhatsApp CTA',
  t02_chapter: 'Specific CBSE chapter',
  t03_teacher_effort: 'Zero teacher prep',
  t04_short_question: 'Very short question',
  t00_legacy: 'Sent before template tracking',
};

const INTENT_FLAGS: Array<{ intent: Intent; column: string; button: string; weight: number; label: string }> = [
  { intent: 'demo', column: 'Clicked_Demo', button: 'btn_demo', weight: 5, label: 'Demo' },
  { intent: 'pricing', column: 'Clicked_Pricing', button: 'btn_pricing', weight: 4, label: 'Pricing' },
  { intent: 'whatsapp', column: 'Clicked_WhatsApp', button: 'btn_whatsapp', weight: 4, label: 'WhatsApp' },
  { intent: 'website', column: 'Clicked_Website', button: 'btn_website', weight: 3, label: 'Website' },
  { intent: 'video', column: 'Clicked_HowLearnXR', button: 'btn_how_learnxr', weight: 2, label: 'Video' },
];

export const INTENT_LABELS: Record<Intent, string> = Object.fromEntries(
  INTENT_FLAGS.map((f) => [f.intent, f.label])
) as Record<Intent, string>;

const HALF_LIFE_DAYS = 14;

function str(row: SchoolLeadRow, key: string): string {
  const v = row[key];
  return v == null ? '' : String(v).trim();
}

function truthy(row: SchoolLeadRow, key: string): boolean {
  return ['true', '1', 'yes'].includes(str(row, key).toLowerCase());
}

function num(row: SchoolLeadRow, key: string): number {
  const n = Number(str(row, key));
  return Number.isFinite(n) ? n : 0;
}

function time(row: SchoolLeadRow, key: string): number | null {
  const raw = str(row, key).replace(/^"|"$/g, '');
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

export function isBounced(row: SchoolLeadRow): boolean {
  return truthy(row, 'Bounced_status');
}

export function hasReplied(row: SchoolLeadRow): boolean {
  return /replied/i.test(str(row, 'Reply_Status')) || truthy(row, 'whatsapp_replied');
}

export function isEmailed(row: SchoolLeadRow): boolean {
  const status = str(row, 'Status').toLowerCase();
  return Boolean(status) && status !== 'new' && status !== 'website_lead';
}

export interface LeadScore {
  row: SchoolLeadRow;
  score: number;
  intents: Intent[];
  reasons: string[];
  lastClickAt: number | null;
}

/**
 * Interest score: intent weights for every button clicked, +1 per extra click,
 * +6 for a positive/demo/pricing reply, decayed with a 14-day half-life since the
 * last engagement. Bounced, dropped or negative leads score 0.
 */
export function scoreLead(row: SchoolLeadRow, now = Date.now()): LeadScore {
  const intents: Intent[] = [];
  const reasons: string[] = [];
  const lastButton = str(row, 'Last_Clicked_Button');
  let raw = 0;

  for (const flag of INTENT_FLAGS) {
    if (truthy(row, flag.column) || lastButton === flag.button) {
      intents.push(flag.intent);
      raw += flag.weight;
    }
  }
  const clicks = num(row, 'Click_count');
  if (clicks > 1) raw += clicks - 1;
  if (clicks > 0) reasons.push(`${clicks} click${clicks === 1 ? '' : 's'}`);
  if (intents.length) reasons.push(`clicked ${intents.map((i) => INTENT_LABELS[i]).join(', ')}`);

  const replyIntent = str(row, 'Reply_intent').toLowerCase();
  if (['positive', 'demo', 'pricing'].includes(replyIntent)) {
    raw += 6;
    reasons.push(`replied: ${replyIntent}`);
  } else if (hasReplied(row)) {
    raw += 2;
    reasons.push('replied');
  }
  if (str(row, 'XR_status') === 'Already Has Lab') reasons.push('has XR/STEM lab');

  const lastClickAt = time(row, 'Last_Clicked_at');
  const lastActivity = Math.max(lastClickAt ?? 0, time(row, 'Replied_at') ?? 0);
  if (lastActivity > 0) {
    const days = Math.max(0, (now - lastActivity) / 86_400_000);
    raw *= Math.pow(0.5, days / HALF_LIFE_DAYS);
  }

  const dead =
    isBounced(row) ||
    replyIntent === 'negative' ||
    /drop/i.test(str(row, 'Lead_status'));
  return { row, score: dead ? 0 : Math.round(raw * 10) / 10, intents, reasons, lastClickAt };
}

export function hotLeads(rows: SchoolLeadRow[], limit = 15, now = Date.now()): LeadScore[] {
  return rows
    .map((r) => scoreLead(r, now))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (b.lastClickAt ?? 0) - (a.lastClickAt ?? 0))
    .slice(0, limit);
}

/** 90% Wilson score interval for a proportion. */
export function wilson(successes: number, trials: number, z = 1.645): { low: number; high: number } {
  if (!trials) return { low: 0, high: 0 };
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

export interface TemplateStat {
  templateId: string;
  label: string;
  sends: number;
  delivered: number;
  opened: number;
  clicked: number;
  replied: number;
  botClicks: number;
  ctr: number;
  ctrLow: number;
  ctrHigh: number;
  replyRate: number;
  buttons: Record<string, number>;
}

/** Per first-email template: sends → delivered → opened → unique clicks → replies. */
export function templateStats(rows: SchoolLeadRow[]): TemplateStat[] {
  const by = new Map<string, TemplateStat>();
  for (const row of rows) {
    if (!isEmailed(row)) continue;
    const id = str(row, 'Email_template_id') || 't00_legacy';
    let s = by.get(id);
    if (!s) {
      s = {
        templateId: id,
        label: EMAIL_TEMPLATE_LABELS[id] || id,
        sends: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        replied: 0,
        botClicks: 0,
        ctr: 0,
        ctrLow: 0,
        ctrHigh: 0,
        replyRate: 0,
        buttons: {},
      };
      by.set(id, s);
    }
    if (isBounced(row)) continue;
    s.sends += 1;
    if (truthy(row, 'Delivered_status')) s.delivered += 1;
    if (truthy(row, 'Opened_status')) s.opened += 1;
    if (num(row, 'Click_count') > 0) {
      s.clicked += 1;
      const btn = str(row, 'Last_Clicked_Button') || 'other';
      s.buttons[btn] = (s.buttons[btn] || 0) + 1;
    }
    if (hasReplied(row)) s.replied += 1;
    s.botClicks += num(row, 'Suspected_bot_clicks');
  }
  return [...by.values()]
    .map((s) => {
      const ci = wilson(s.clicked, s.sends);
      return {
        ...s,
        ctr: s.sends ? s.clicked / s.sends : 0,
        ctrLow: ci.low,
        ctrHigh: ci.high,
        replyRate: s.sends ? s.replied / s.sends : 0,
      };
    })
    .sort((a, b) => b.ctr - a.ctr || b.sends - a.sends);
}

export interface CityFunnel {
  city: string;
  scraped: number;
  emailed: number;
  opened: number;
  clicked: number;
  replied: number;
  whatsapp: number;
  hot: number;
}

/** Per city: scraped → emailed → opened → clicked → replied, plus WhatsApp sends and hot leads. */
export function cityFunnels(rows: SchoolLeadRow[], now = Date.now()): CityFunnel[] {
  const by = new Map<string, CityFunnel>();
  for (const row of rows) {
    const city = str(row, 'City') || 'Unknown';
    const key = city.toLowerCase();
    let c = by.get(key);
    if (!c) {
      c = { city, scraped: 0, emailed: 0, opened: 0, clicked: 0, replied: 0, whatsapp: 0, hot: 0 };
      by.set(key, c);
    }
    c.scraped += 1;
    if (isEmailed(row)) c.emailed += 1;
    if (truthy(row, 'Opened_status')) c.opened += 1;
    if (num(row, 'Click_count') > 0) c.clicked += 1;
    if (hasReplied(row)) c.replied += 1;
    if (str(row, 'Whatsapp_message_sid').startsWith('SM') || /sent|queued|delivered|read/i.test(str(row, 'Whatsapp_status'))) {
      c.whatsapp += 1;
    }
    if (scoreLead(row, now).score >= 4) c.hot += 1;
  }
  return [...by.values()].sort((a, b) => b.hot - a.hot || b.clicked - a.clicked || b.scraped - a.scraped);
}
