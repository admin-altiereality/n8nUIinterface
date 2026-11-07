import { describe, expect, it } from 'vitest';
import { dailyActivity, sendHealth, topBounceReasons } from './sendHealth';

const NOW = Date.parse('2026-11-07T09:30:00Z');
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const sent = (extra: Record<string, string> = {}) => ({ Email_sent_at: iso(NOW - DAY), Mailbox: 'zepto', ...extra });
const many = (n: number, extra: Record<string, string> = {}) => Array.from({ length: n }, () => sent(extra));

describe('dailyActivity', () => {
  it('buckets by IST day and ignores anything older than the window', () => {
    const rows = [
      { Time: iso(NOW), Email_sent_at: iso(NOW), Replied_at: iso(NOW) },
      { Email_sent_at: iso(NOW - 20 * DAY) },
      { Email_sent_at: iso(NOW - 20 * DAY), Last_Follow_up: iso(NOW - DAY) },
    ];
    const days = dailyActivity(rows, NOW);
    expect(days).toHaveLength(14);
    expect(days[13]).toMatchObject({ found: 1, sent: 1, replies: 1 });
    expect(days[12].sent).toBe(1);
    expect(days.reduce((n, d) => n + d.sent, 0)).toBe(2);
  });

  it('does not count a first email twice when the follow-up column repeats it', () => {
    const at = iso(NOW);
    expect(dailyActivity([{ Email_sent_at: at, Last_Follow_up: at }], NOW)[13].sent).toBe(1);
  });
});

describe('sendHealth', () => {
  it('judges bounce rate only with enough sends', () => {
    expect(sendHealth([...many(5), ...many(5, { Bounced_status: 'true' })], NOW)[0].verdict).toBe('too_few');
    expect(sendHealth(many(30), NOW)[0].verdict).toBe('good');
    expect(sendHealth([...many(97), ...many(3, { Bounced_status: 'true' })], NOW)[0].verdict).toBe('watch');
    expect(sendHealth([...many(90), ...many(10, { Bounced_status: 'true' })], NOW)[0].verdict).toBe('stop');
  });

  it('skips old sends and shows mailboxes only when there are several', () => {
    expect(sendHealth([sent({ Email_sent_at: iso(NOW - 40 * DAY) })], NOW)).toEqual([]);
    expect(sendHealth(many(3), NOW).map((m) => m.mailbox)).toEqual(['All mailboxes']);
    const two = sendHealth([...many(3), ...many(1, { Mailbox: 'zoho' })], NOW);
    expect(two.map((m) => [m.mailbox, m.sent])).toEqual([['All mailboxes', 4], ['zepto', 3], ['zoho', 1]]);
  });

  it('counts opens and replies', () => {
    const [all] = sendHealth([sent({ Opened_status: 'true' }), sent({ Reply_Status: 'Replied' })], NOW);
    expect(all).toMatchObject({ opened: 1, replied: 1, openRate: 0.5, replyRate: 0.5 });
  });
});

describe('topBounceReasons', () => {
  it('ranks reasons and names missing ones', () => {
    const rows = [
      sent({ Bounced_status: 'true', Bounce_reason: 'mailbox not found' }),
      sent({ Bounced_status: 'true', Bounce_reason: 'mailbox not found' }),
      sent({ Bounced_status: 'true' }),
      sent(),
    ];
    expect(topBounceReasons(rows, NOW)).toEqual([
      { reason: 'mailbox not found', count: 2 },
      { reason: 'No reason recorded', count: 1 },
    ]);
  });
});
