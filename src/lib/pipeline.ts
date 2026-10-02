/**
 * Pipeline helpers over the `school data` sheet: stages, the Today queue and revenue KPIs.
 * Days and months are judged in India time (UTC+5:30, no DST), where the sales team works.
 */
import type { SchoolLeadRow } from '../api/sheetsClient';

export const STAGES = ['New', 'Contacted', 'Engaged', 'Demo booked', 'Demo done', 'Proposal', 'Won', 'Lost'] as const;
export type Stage = (typeof STAGES)[number];

/** Mirrors LOST_REASONS in functions/src/index.ts. */
export const LOST_REASONS = [
  'Not interested',
  'No budget',
  'Chose another vendor',
  'No response',
  'Wrong contact',
  'Unsubscribed',
  'Duplicate',
  'Other',
];

/** Stages where a deal is being worked; their deal values make up the open pipeline. */
export const OPEN_STAGES: readonly Stage[] = ['Engaged', 'Demo booked', 'Demo done', 'Proposal'];

/** Set these to show progress against target and cost per demo on Sales Home (0 hides them). */
export const MONTHLY_TARGET_INR = 0;
export const MONTHLY_SPEND_INR = 0;

export const BOOKING_URL = 'https://cal.com/altie-reality/30min';

const IST_OFFSET_MS = 5.5 * 3_600_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** WhatsApp only allows free-form replies within 24 hours of the school's last message. */
export const WHATSAPP_WINDOW_MS = DAY_MS;

export function field(row: SchoolLeadRow, key: string): string {
  const v = row[key];
  return v == null ? '' : String(v).trim();
}

export function timeOf(row: SchoolLeadRow, key: string): number | null {
  const raw = field(row, key).replace(/^"|"$/g, '');
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function amount(row: SchoolLeadRow, key: string): number {
  const n = Number(field(row, key).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function stageOf(row: SchoolLeadRow): Stage {
  const s = field(row, 'Stage');
  return (STAGES as readonly string[]).includes(s) ? (s as Stage) : 'New';
}

export function dealValue(row: SchoolLeadRow): number {
  return amount(row, 'Deal_value');
}

export function isDoNotContact(row: SchoolLeadRow): boolean {
  return Boolean(field(row, 'Do_not_contact'));
}

/** Midnight IST that starts the day containing `t`, as a UTC timestamp. */
export function istDayStart(t: number): number {
  return Math.floor((t + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** Midnight IST that starts the month containing `t`, as a UTC timestamp. */
export function istMonthStart(t: number): number {
  const d = new Date(t + IST_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST_OFFSET_MS;
}

/** 10:00 IST on the day after `now`: where a snoozed next step lands. */
export function tomorrowMorning(now: number): number {
  return istDayStart(now) + DAY_MS + 10 * HOUR_MS;
}

export function bookingLink(leadId: string): string {
  return `${BOOKING_URL}?metadata[leadId]=${encodeURIComponent(leadId)}`;
}

/** Time left to answer the school's WhatsApp message free-form, or null when the window is closed. */
export function whatsappWindowLeftMs(row: SchoolLeadRow, now = Date.now()): number | null {
  if (field(row, 'Reply_channel') !== 'whatsapp') return null;
  const replied = timeOf(row, 'Replied_at');
  if (replied === null) return null;
  const left = replied + WHATSAPP_WINDOW_MS - now;
  return left > 0 ? left : null;
}

export type QueueSection = 'demos_today' | 'due' | 'hot_unclaimed' | 'needs_outcome' | 'no_next_step';

export const QUEUE_SECTIONS: Array<{ key: QueueSection; title: string; hint: string }> = [
  { key: 'demos_today', title: 'Demos today', hint: 'Booked for today' },
  { key: 'due', title: 'Due now', hint: 'Next steps due today or overdue' },
  { key: 'hot_unclaimed', title: 'Hot, nobody on it', hint: 'They replied or asked for something. Claim one.' },
  { key: 'needs_outcome', title: 'Demo outcome missing', hint: 'Mark the demo done or a no-show' },
  { key: 'no_next_step', title: 'No next step', hint: 'Active deals without a plan' },
];

export type QueueItem = {
  row: SchoolLeadRow;
  section: QueueSection;
  /** Demo time for demos, otherwise when the next step is due. */
  at: number | null;
  overdue: boolean;
  windowLeftMs: number | null;
};

/**
 * Today's work, one section per lead (first match wins, in QUEUE_SECTIONS order).
 * With `owner`, only that rep's leads are shown, plus unclaimed hot leads to pick up.
 */
export function todayQueue(
  rows: SchoolLeadRow[],
  { now = Date.now(), owner }: { now?: number; owner?: string } = {}
): Record<QueueSection, QueueItem[]> {
  const dayStart = istDayStart(now);
  const dayEnd = dayStart + DAY_MS;
  const me = owner?.toLowerCase();
  const queue = Object.fromEntries(QUEUE_SECTIONS.map((s) => [s.key, [] as QueueItem[]])) as Record<
    QueueSection,
    QueueItem[]
  >;

  for (const row of rows) {
    const stage = stageOf(row);
    if (isDoNotContact(row) || stage === 'Won' || stage === 'Lost') continue;
    const rowOwner = field(row, 'Owner').toLowerCase();
    const mine = !me || rowOwner === me;
    const isOpen = OPEN_STAGES.includes(stage);
    const due = timeOf(row, 'Next_step_due');
    const demoAt = timeOf(row, 'Demo_at');
    const hasStep = Boolean(field(row, 'Next_step'));

    let section: QueueSection | null = null;
    let at: number | null = due;
    if (mine && demoAt !== null && demoAt >= dayStart && demoAt < dayEnd) {
      section = 'demos_today';
      at = demoAt;
    } else if (mine && hasStep && due !== null && due < dayEnd) {
      section = 'due';
    } else if (!rowOwner && isOpen && timeOf(row, 'Hot_at') !== null) {
      section = 'hot_unclaimed';
    } else if (mine && stage === 'Demo booked' && demoAt !== null && demoAt < now) {
      section = 'needs_outcome';
      at = demoAt;
    } else if (mine && isOpen && !hasStep) {
      section = 'no_next_step';
    }
    if (!section) continue;
    queue[section].push({
      row,
      section,
      at,
      overdue: section === 'due' && at !== null && at < now,
      windowLeftMs: whatsappWindowLeftMs(row, now),
    });
  }

  const byAt = (a: QueueItem, b: QueueItem) => (a.at ?? Infinity) - (b.at ?? Infinity);
  const byHot = (a: QueueItem, b: QueueItem) => (timeOf(b.row, 'Hot_at') ?? 0) - (timeOf(a.row, 'Hot_at') ?? 0);
  queue.demos_today.sort(byAt);
  queue.due.sort(byAt);
  queue.hot_unclaimed.sort(byHot);
  queue.needs_outcome.sort(byAt);
  queue.no_next_step.sort(byHot);
  return queue;
}

export type SalesKpis = {
  openValue: number;
  openCount: number;
  wonValue: number;
  wonCount: number;
  demosBooked: number;
  /** Median time from a lead turning hot to the first logged touch. */
  speedMedianMs: number | null;
  speedUnderHourShare: number | null;
  speedSample: number;
  costPerDemo: number | null;
  targetShare: number | null;
};

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function salesKpis(
  rows: SchoolLeadRow[],
  { now = Date.now(), targetInr = MONTHLY_TARGET_INR, spendInr = MONTHLY_SPEND_INR } = {}
): SalesKpis {
  const monthStart = istMonthStart(now);
  let openValue = 0;
  let openCount = 0;
  let wonValue = 0;
  let wonCount = 0;
  let demosBooked = 0;
  const speeds: number[] = [];

  for (const row of rows) {
    const stage = stageOf(row);
    if (OPEN_STAGES.includes(stage)) {
      openCount += 1;
      openValue += dealValue(row);
    }
    const wonAt = timeOf(row, 'Won_at');
    if (stage === 'Won' && wonAt !== null && wonAt >= monthStart) {
      wonCount += 1;
      wonValue += amount(row, 'Paid_amount') || dealValue(row);
    }
    const bookedAt = timeOf(row, 'Demo_booked_at');
    if (bookedAt !== null && bookedAt >= monthStart) demosBooked += 1;
    const hotAt = timeOf(row, 'Hot_at');
    const touchAt = timeOf(row, 'First_touch_at');
    if (hotAt !== null && touchAt !== null && touchAt >= hotAt) speeds.push(touchAt - hotAt);
  }

  return {
    openValue,
    openCount,
    wonValue,
    wonCount,
    demosBooked,
    speedMedianMs: median(speeds),
    speedUnderHourShare: speeds.length ? speeds.filter((ms) => ms < HOUR_MS).length / speeds.length : null,
    speedSample: speeds.length,
    costPerDemo: spendInr > 0 && demosBooked > 0 ? spendInr / demosBooked : null,
    targetShare: targetInr > 0 ? wonValue / targetInr : null,
  };
}

/** How many leads ever reached each step, from stage plus the milestone timestamps. */
export function funnelConversion(rows: SchoolLeadRow[]): Array<{ label: string; count: number }> {
  const reached = (row: SchoolLeadRow, from: Stage, milestone?: string) => {
    const stage = stageOf(row);
    const idx = STAGES.indexOf(stage);
    const inRange = stage !== 'Lost' && idx >= STAGES.indexOf(from);
    return inRange || (milestone ? timeOf(row, milestone) !== null : false);
  };
  const steps: Array<{ label: string; test: (row: SchoolLeadRow) => boolean }> = [
    { label: 'Contacted', test: (r) => stageOf(r) !== 'New' },
    { label: 'Engaged', test: (r) => reached(r, 'Engaged', 'Hot_at') },
    { label: 'Demo booked', test: (r) => reached(r, 'Demo booked', 'Demo_booked_at') },
    { label: 'Demo done', test: (r) => reached(r, 'Demo done', 'Demo_done_at') },
    { label: 'Proposal', test: (r) => reached(r, 'Proposal', 'Proposal_sent_at') },
    { label: 'Won', test: (r) => stageOf(r) === 'Won' },
  ];
  return steps.map((s) => ({ label: s.label, count: rows.filter(s.test).length }));
}

export type StageColumn = { stage: Stage; rows: SchoolLeadRow[]; value: number };

/** Leads grouped by stage, soonest next step first, then most recently hot. */
export function pipelineByStage(rows: SchoolLeadRow[]): StageColumn[] {
  const columns = new Map<Stage, StageColumn>(STAGES.map((stage) => [stage, { stage, rows: [], value: 0 }]));
  for (const row of rows) {
    const column = columns.get(stageOf(row))!;
    column.rows.push(row);
    column.value += dealValue(row);
  }
  for (const column of columns.values()) {
    column.rows.sort(
      (a, b) =>
        (timeOf(a, 'Next_step_due') ?? Infinity) - (timeOf(b, 'Next_step_due') ?? Infinity) ||
        (timeOf(b, 'Hot_at') ?? 0) - (timeOf(a, 'Hot_at') ?? 0)
    );
  }
  return [...columns.values()];
}

export function ownerLabel(email: string): string {
  return email ? email.split('@')[0] : '';
}

export function formatInr(value: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value);
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.round(hours / 24)}d`;
}

/** "Today 3:00 pm", "Tomorrow 10:00 am", "Yesterday 6:15 pm" or "2 Oct", in IST. */
export function formatWhen(t: number, now = Date.now()): string {
  const dayDiff = Math.round((istDayStart(t) - istDayStart(now)) / DAY_MS);
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(t);
  if (dayDiff === 0) return `Today ${time}`;
  if (dayDiff === 1) return `Tomorrow ${time}`;
  if (dayDiff === -1) return `Yesterday ${time}`;
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(t);
}
