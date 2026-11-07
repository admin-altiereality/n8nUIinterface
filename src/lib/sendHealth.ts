/**
 * Is cold email healthy? Fourteen-day activity and bounce, open and reply rates from the sheet, per mailbox.
 * Bounces have no timestamp in the sheet, so rates cover schools first emailed in the last 30 days.
 */
import type { SchoolLeadRow } from '../api/sheetsClient';
import { hasReplied, isBounced } from './leadInsights';
import { DAY_MS, createdAt, field, istDayStart, timeOf } from './pipeline';

export type DayCount = { day: number; found: number; sent: number; replies: number };

export function dailyActivity(rows: SchoolLeadRow[], now = Date.now(), days = 14): DayCount[] {
  const first = istDayStart(now) - (days - 1) * DAY_MS;
  const out: DayCount[] = Array.from({ length: days }, (_, i) => ({ day: first + i * DAY_MS, found: 0, sent: 0, replies: 0 }));
  const add = (t: number | null, key: 'found' | 'sent' | 'replies') => {
    if (t === null || t < first) return;
    const bucket = out[Math.floor((t - first) / DAY_MS)];
    if (bucket) bucket[key] += 1;
  };
  for (const row of rows) {
    add(createdAt(row), 'found');
    add(timeOf(row, 'Email_sent_at'), 'sent');
    const followUp = timeOf(row, 'Last_Follow_up');
    if (followUp !== timeOf(row, 'Email_sent_at')) add(followUp, 'sent');
    add(timeOf(row, 'Replied_at'), 'replies');
  }
  return out;
}

export type HealthVerdict = 'good' | 'watch' | 'stop' | 'too_few';

export type MailboxHealth = {
  mailbox: string;
  sent: number;
  bounced: number;
  opened: number;
  replied: number;
  bounceRate: number;
  openRate: number;
  replyRate: number;
  verdict: HealthVerdict;
};

/** Mailbox providers start filtering around 2% bounces; at 5% stop and clean the list. */
export const BOUNCE_WATCH = 0.02;
export const BOUNCE_STOP = 0.05;
export const MIN_SENDS = 20;
const WINDOW_DAYS = 30;

const yes = (row: SchoolLeadRow, key: string) => /^(true|yes|1)$/i.test(field(row, key));

function verdictOf(sent: number, bounceRate: number): HealthVerdict {
  if (sent < MIN_SENDS) return 'too_few';
  if (bounceRate >= BOUNCE_STOP) return 'stop';
  return bounceRate >= BOUNCE_WATCH ? 'watch' : 'good';
}

/** All mailboxes together first, then each mailbox by volume (only when there's more than one). */
export function sendHealth(rows: SchoolLeadRow[], now = Date.now()): MailboxHealth[] {
  const from = now - WINDOW_DAYS * DAY_MS;
  const by = new Map<string, { sent: number; bounced: number; opened: number; replied: number }>();
  const tally = (mailbox: string, row: SchoolLeadRow) => {
    const m = by.get(mailbox) || { sent: 0, bounced: 0, opened: 0, replied: 0 };
    m.sent += 1;
    if (isBounced(row)) m.bounced += 1;
    if (yes(row, 'Opened_status')) m.opened += 1;
    if (hasReplied(row)) m.replied += 1;
    by.set(mailbox, m);
  };
  for (const row of rows) {
    const sentAt = timeOf(row, 'Email_sent_at');
    if (sentAt === null || sentAt < from) continue;
    tally('All mailboxes', row);
    tally(field(row, 'Mailbox') || 'Not recorded', row);
  }
  const list = [...by.entries()].map(([mailbox, m]) => {
    const bounceRate = m.sent ? m.bounced / m.sent : 0;
    return {
      mailbox,
      ...m,
      bounceRate,
      openRate: m.sent ? m.opened / m.sent : 0,
      replyRate: m.sent ? m.replied / m.sent : 0,
      verdict: verdictOf(m.sent, bounceRate),
    };
  });
  const [all, ...each] = list.sort((a, b) => Number(b.mailbox === 'All mailboxes') - Number(a.mailbox === 'All mailboxes') || b.sent - a.sent);
  if (!all) return [];
  return each.length > 1 ? [all, ...each] : [all];
}

/** The most common bounce reasons in the window, for fixing the list rather than just seeing the rate. */
export function topBounceReasons(rows: SchoolLeadRow[], now = Date.now(), limit = 3): Array<{ reason: string; count: number }> {
  const from = now - WINDOW_DAYS * DAY_MS;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const sentAt = timeOf(row, 'Email_sent_at');
    if (!isBounced(row) || sentAt === null || sentAt < from) continue;
    const reason = field(row, 'Bounce_reason').slice(0, 80) || 'No reason recorded';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
