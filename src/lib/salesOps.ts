import type { SchoolLeadRow } from '../api/sheetsClient';
import { field } from './pipeline';

/** Who a lead is: the all-India city runs search four kinds of organisation (sheet column Segment). */
export const SEGMENTS = { k12: 'K-12 school', coaching: 'Coaching centre', college: 'College', partner: 'Channel partner' } as const;
export type Segment = keyof typeof SEGMENTS;

export function segmentOf(row: SchoolLeadRow): Segment {
  const s = field(row, 'Segment').toLowerCase();
  return s in SEGMENTS ? (s as Segment) : 'k12';
}

const DAY = 86_400_000;
const IST = 5.5 * 3_600_000;
const timeOf = (value: string): number | null => {
  const t = Date.parse(String(value || '').trim().replace(/^"|"$/g, ''));
  return Number.isFinite(t) ? t : null;
};
const truthy = (value: string) => ['true', 'yes', '1'].includes(value.trim().toLowerCase());
export const istDay = (t: number) => new Date(t + IST).toISOString().slice(0, 10);

// ---- Outbox: every cold email sent, newest first, with what happened to it ----

export type SentKind = 'first' | 'follow_up_1' | 'follow_up_2' | 'follow_up_3' | 're_engage';
export const SENT_KINDS: Record<SentKind, string> = {
  first: 'First email',
  follow_up_1: 'Follow-up 1',
  follow_up_2: 'Follow-up 2',
  follow_up_3: 'Follow-up 3',
  re_engage: 'Re-engagement',
};
export type Outcome = 'replied' | 'bounced' | 'clicked' | 'opened' | 'delivered' | 'sent';
export const OUTCOMES: Record<Outcome, string> = {
  replied: 'Replied',
  bounced: 'Bounced',
  clicked: 'Clicked',
  opened: 'Opened',
  delivered: 'Delivered',
  sent: 'Sent',
};

export interface OutboxEntry {
  leadId: string;
  org: string;
  city: string;
  segment: Segment;
  to: string;
  verify: VerifyStatus;
  kind: SentKind;
  sentAt: number;
  /** The lead's latest state, so it is the same for every email to that lead. */
  outcome: Outcome;
}

export function outcomeOf(row: SchoolLeadRow): Outcome {
  if (field(row, 'Replied_at') || /replied/i.test(field(row, 'Reply_Status'))) return 'replied';
  if (truthy(field(row, 'Bounced_status'))) return 'bounced';
  if (Number(field(row, 'Click_count')) > 0) return 'clicked';
  if (truthy(field(row, 'Opened_status'))) return 'opened';
  if (truthy(field(row, 'Delivered_status'))) return 'delivered';
  return 'sent';
}

/** The sheet keeps the first send and the latest follow-up per lead; earlier follow-ups aren't stored. */
export function buildOutbox(rows: SchoolLeadRow[], now: number, days = 14): OutboxEntry[] {
  const from = now - days * DAY;
  const out: OutboxEntry[] = [];
  for (const row of rows) {
    const to = field(row, 'Email ID');
    if (!to) continue;
    const base = {
      leadId: field(row, 'Lead_id'),
      org: field(row, 'School Name') || 'Unknown',
      city: field(row, 'City'),
      segment: segmentOf(row),
      to,
      verify: verifyOf(row),
      outcome: outcomeOf(row),
    };
    const first = timeOf(field(row, 'Email_sent_at'));
    if (first !== null && first >= from) out.push({ ...base, kind: 'first', sentAt: first });
    const last = timeOf(field(row, 'Last_Follow_up'));
    // The first email also stamps Last_Follow_up; only a later time is a follow-up.
    if (last !== null && last >= from && (first === null || last - first > 60_000)) {
      const count = Number(field(row, 'Follow_up_count')) || 0;
      const kind: SentKind = count >= 4 || field(row, 'Status') === 'reengaged' ? 're_engage' : count === 3 ? 'follow_up_3' : count === 2 ? 'follow_up_2' : 'follow_up_1';
      out.push({ ...base, kind, sentAt: last });
    }
  }
  return out.sort((a, b) => b.sentAt - a.sentAt);
}

// ---- Contacts: every person found per organisation, with how sure we are of the address ----

export type VerifyStatus = 'verified' | 'catch_all' | 'site' | 'unverified' | 'none';
export const VERIFY_LABELS: Record<VerifyStatus, string> = {
  verified: 'Verified (Reoon)',
  catch_all: 'Catch-all (risky)',
  site: 'Printed on website',
  unverified: 'Older run, not checked',
  none: 'No email',
};

export function verifyOf(row: SchoolLeadRow): VerifyStatus {
  const v = field(row, 'Email_verify');
  if (v === 'verified' || v === 'catch_all' || v === 'site') return v;
  return field(row, 'Email ID') ? 'unverified' : 'none';
}

export interface ContactEntry {
  leadId: string;
  org: string;
  city: string;
  segment: Segment;
  name: string;
  role: string;
  email: string;
  verify: VerifyStatus;
  phone: string;
}

export function buildContacts(rows: SchoolLeadRow[]): ContactEntry[] {
  const out: ContactEntry[] = [];
  for (const row of rows) {
    const base = { leadId: field(row, 'Lead_id'), org: field(row, 'School Name') || 'Unknown', city: field(row, 'City'), segment: segmentOf(row) };
    const name = field(row, 'Principal Name');
    const email = field(row, 'Email ID');
    if (name || email) {
      out.push({ ...base, name, role: base.segment === 'k12' ? 'Principal / head' : 'Head', email, verify: verifyOf(row), phone: field(row, 'Phone number') });
    }
    const second = field(row, 'Contact_2_name');
    if (second) {
      const secondEmail = field(row, 'Contact_2_email');
      out.push({ ...base, name: second, role: field(row, 'Contact_2_role'), email: secondEmail, verify: secondEmail ? 'site' : 'none', phone: '' });
    }
  }
  return out;
}

// ---- Cold-email cap (same rule as Sales • Outbound) ----

export const RAMP_START = Date.parse('2026-11-13T00:00:00+05:30');

/** 50/day from 13 Nov 2026, +25 per full week, at most 500; 50 while the 7-day bounce rate is 3%+, 0 at 5%+. */
export function rampCap(rows: SchoolLeadRow[], now: number): { cap: number; bounceRate: number | null; sent7d: number } {
  const since = now - 7 * DAY;
  const recent = rows.filter((row) => (timeOf(field(row, 'Email_sent_at')) ?? 0) >= since || (timeOf(field(row, 'Last_Follow_up')) ?? 0) >= since);
  const bounced = recent.filter((row) => truthy(field(row, 'Bounced_status'))).length;
  const rate = recent.length >= 20 ? bounced / recent.length : null;
  const weeks = Math.max(0, Math.floor((now - RAMP_START) / (7 * DAY)));
  const cap = rate !== null && rate >= 0.05 ? 0 : rate !== null && rate >= 0.03 ? 50 : Math.min(500, 50 + 25 * weeks);
  return { cap, bounceRate: rate === null ? null : Math.round(rate * 1000) / 10, sent7d: recent.length };
}

// ---- Usage & cost, from the run log the workflows post ----

export interface RunLogEntry {
  kind: 'city_run' | 'follow_ups';
  executionId: string;
  at: string;
  city: string;
  segment: string;
  found: number;
  unique: number;
  added: number;
  emailed: number;
  emailFailed: number;
  followUps: number;
  followUpsFailed: number;
  reengaged: number;
  reoonChecked: number;
  reoonVerified: number;
  reoonCatchAll: number;
  bounceRate: number | null;
  skipped: Record<string, number>;
  error: string;
}

/** Rough per-unit costs in rupees; change them here when prices change. */
export const COST_INR = {
  /** Google Places Text Search with phone and website fields, about $35 per 1,000 requests. */
  placesRequest: 2.9,
  /** One Gemini Flash-Lite read of a site's pages (about 15k tokens). */
  siteRead: 0.13,
  /** One Gemini Flash email draft. */
  aiDraft: 0.1,
  /** One Reoon check from paid credits ($11.90 per 10,000); the first 20 a day are free. */
  reoonCheck: 0.1,
  /** One ZeptoMail send. */
  email: 0.02,
};
const SKIPPED_BEFORE_READING = ['closed', 'no_contact', 'preschool', 'coaching', 'higher_ed', 'off_target', 'known', 'over_cap'];

export interface UsageDay {
  day: string;
  cityRuns: number;
  placesRequests: number;
  sitesRead: number;
  added: number;
  reoonChecked: number;
  reoonVerified: number;
  emails: number;
  failed: number;
  costInr: number;
}

export function usageByDay(entries: RunLogEntry[], now: number, days = 14): UsageDay[] {
  const out = new Map<string, UsageDay>();
  for (let i = days - 1; i >= 0; i--) {
    const day = istDay(now - i * DAY);
    out.set(day, { day, cityRuns: 0, placesRequests: 0, sitesRead: 0, added: 0, reoonChecked: 0, reoonVerified: 0, emails: 0, failed: 0, costInr: 0 });
  }
  for (const e of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    const t = timeOf(e.at);
    const d = t === null ? undefined : out.get(istDay(t));
    if (!d) continue;
    if (e.kind === 'city_run') {
      d.cityRuns++;
      d.placesRequests += Math.max(1, Math.ceil((e.found || 0) / 20));
      const dropped = SKIPPED_BEFORE_READING.reduce((n, k) => n + (e.skipped?.[k] || 0), 0);
      d.sitesRead += Math.max(0, (e.unique || 0) - dropped);
      d.added += e.added || 0;
      d.reoonChecked += e.reoonChecked || 0;
      d.reoonVerified += e.reoonVerified || 0;
      d.emails += e.emailed || 0;
      d.failed += e.emailFailed || 0;
    } else {
      d.emails += e.followUps || 0;
      d.failed += e.followUpsFailed || 0;
    }
  }
  for (const d of out.values()) {
    const paidReoon = Math.max(0, d.reoonChecked - 20);
    d.costInr = Math.round(
      (d.placesRequests * COST_INR.placesRequest + d.sitesRead * COST_INR.siteRead + d.emails * (COST_INR.aiDraft + COST_INR.email) + paidReoon * COST_INR.reoonCheck) * 100
    ) / 100;
  }
  return [...out.values()];
}

// ---- Activity: what the automation did, and what came back, newest first ----

export type ActivityType = 'city_run' | 'follow_ups' | 'reply' | 'bounce' | 'demo' | 'won';
export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  city_run: 'City run',
  follow_ups: 'Follow-ups',
  reply: 'Reply',
  bounce: 'Bounce',
  demo: 'Demo booked',
  won: 'Won',
};

export interface ActivityItem {
  at: number;
  type: ActivityType;
  title: string;
  detail: string;
  leadId?: string;
}

export function buildActivity(rows: SchoolLeadRow[], entries: RunLogEntry[], now: number, days = 7): ActivityItem[] {
  const from = now - days * DAY;
  const out: ActivityItem[] = [];
  for (const e of entries) {
    const at = timeOf(e.at);
    if (at === null || at < from) continue;
    if (e.kind === 'city_run') {
      const verified = e.reoonChecked ? ` · ${e.reoonVerified} of ${e.reoonChecked} guessed emails verified` : '';
      out.push({
        at,
        type: 'city_run',
        title: `${e.city} · ${SEGMENTS[(e.segment as Segment) in SEGMENTS ? (e.segment as Segment) : 'k12']}`,
        detail: `${e.added} added of ${e.unique} found · ${e.emailed} first emails${e.emailFailed ? ` (${e.emailFailed} failed)` : ''}${verified}${e.error ? ` · error: ${e.error}` : ''}`,
      });
    } else {
      out.push({
        at,
        type: 'follow_ups',
        title: 'Daily follow-ups',
        detail: `${e.followUps} sent${e.reengaged ? `, ${e.reengaged} re-engagements` : ''}${e.followUpsFailed ? ` · ${e.followUpsFailed} failed` : ''}${e.bounceRate !== null ? ` · 7-day bounce ${e.bounceRate}%` : ''}`,
      });
    }
  }
  for (const row of rows) {
    const org = field(row, 'School Name') || 'Unknown';
    const leadId = field(row, 'Lead_id');
    const replied = timeOf(field(row, 'Replied_at'));
    if (replied !== null && replied >= from) {
      out.push({ at: replied, type: 'reply', title: org, detail: [field(row, 'Reply_intent'), field(row, 'Reply_snippet').slice(0, 140)].filter(Boolean).join(' · '), leadId });
    }
    if (truthy(field(row, 'Bounced_status'))) {
      // No bounce time is stored; the last send is the closest.
      const sent = timeOf(field(row, 'Last_Follow_up')) ?? timeOf(field(row, 'Email_sent_at'));
      if (sent !== null && sent >= from) out.push({ at: sent, type: 'bounce', title: org, detail: `${field(row, 'Email ID')}${field(row, 'Bounce_reason') ? ` · ${field(row, 'Bounce_reason')}` : ''}`, leadId });
    }
    const demo = timeOf(field(row, 'Demo_booked_at'));
    if (demo !== null && demo >= from) out.push({ at: demo, type: 'demo', title: org, detail: field(row, 'City'), leadId });
    const won = timeOf(field(row, 'Won_at'));
    if (won !== null && won >= from) out.push({ at: won, type: 'won', title: org, detail: field(row, 'Deal_value') ? `₹${field(row, 'Deal_value')}` : '', leadId });
  }
  return out.sort((a, b) => b.at - a.at);
}
