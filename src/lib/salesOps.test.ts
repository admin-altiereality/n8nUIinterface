import { describe, expect, it } from 'vitest';
import { buildActivity, buildContacts, buildOutbox, rampCap, usageByDay, verifyOf, type RunLogEntry } from './salesOps';

const NOW = Date.parse('2026-11-13T09:30:00Z');
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

const run = (extra: Partial<RunLogEntry> = {}): RunLogEntry => ({
  kind: 'city_run', executionId: '1', at: iso(NOW - 3_600_000), city: 'Pune', segment: 'coaching',
  found: 60, unique: 50, added: 8, emailed: 5, emailFailed: 0, followUps: 0, followUpsFailed: 0, reengaged: 0,
  reoonChecked: 6, reoonVerified: 2, reoonCatchAll: 1, bounceRate: null, skipped: { known: 10, off_target: 10 }, error: '',
  ...extra,
});

describe('buildOutbox', () => {
  it('lists a first email and a later follow-up, newest first, with the lead outcome', () => {
    const rows = [{ 'Email ID': 'a@x.in', 'School Name': 'A', Lead_id: 'l1', Email_sent_at: iso(NOW - 5 * DAY), Last_Follow_up: iso(NOW - DAY), Follow_up_count: '2', Opened_status: 'true' }];
    const out = buildOutbox(rows, NOW);
    expect(out.map((e) => e.kind)).toEqual(['follow_up_2', 'first']);
    expect(out[0]).toMatchObject({ outcome: 'opened', verify: 'unverified', segment: 'k12' });
  });

  it('does not count the first email twice and skips old sends', () => {
    const at = iso(NOW - DAY);
    expect(buildOutbox([{ 'Email ID': 'a@x.in', Email_sent_at: at, Last_Follow_up: at }], NOW)).toHaveLength(1);
    expect(buildOutbox([{ 'Email ID': 'a@x.in', Email_sent_at: iso(NOW - 30 * DAY) }], NOW)).toHaveLength(0);
  });

  it('marks re-engagements and puts replies ahead of other outcomes', () => {
    const out = buildOutbox([{ 'Email ID': 'a@x.in', Last_Follow_up: iso(NOW - DAY), Follow_up_count: '4', Bounced_status: 'true', Replied_at: iso(NOW) }], NOW);
    expect(out[0]).toMatchObject({ kind: 're_engage', outcome: 'replied' });
  });
});

describe('contacts', () => {
  it('reads the verify column and falls back for older rows', () => {
    expect(verifyOf({ 'Email ID': 'a@x.in', Email_verify: 'verified' })).toBe('verified');
    expect(verifyOf({ 'Email ID': 'a@x.in' })).toBe('unverified');
    expect(verifyOf({})).toBe('none');
  });

  it('lists the head and a second contact', () => {
    const out = buildContacts([{ 'School Name': 'Prime Classes', Segment: 'coaching', 'Principal Name': 'R Mehta', 'Email ID': 'info@p.in', Email_verify: 'verified', Contact_2_name: 'S Rao', Contact_2_role: 'Academic head' }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: 'Head', verify: 'verified', segment: 'coaching' });
    expect(out[1]).toMatchObject({ name: 'S Rao', role: 'Academic head', verify: 'none' });
  });
});

describe('rampCap', () => {
  const sends = (n: number, bounced: number) => Array.from({ length: n }, (_, i) => ({ Email_sent_at: iso(NOW - DAY), Bounced_status: i < bounced ? 'true' : 'false' }));

  it('starts at 50 and adds 25 per full week', () => {
    expect(rampCap([], NOW).cap).toBe(50);
    expect(rampCap([], NOW + 15 * DAY).cap).toBe(100);
  });

  it('holds at 50 from 3% bounces and stops at 5%', () => {
    expect(rampCap(sends(100, 3), NOW + 15 * DAY)).toMatchObject({ cap: 50, bounceRate: 3 });
    expect(rampCap(sends(100, 5), NOW).cap).toBe(0);
    expect(rampCap(sends(10, 5), NOW)).toMatchObject({ cap: 50, bounceRate: null });
  });
});

describe('usageByDay', () => {
  it('estimates requests, site reads and cost per IST day', () => {
    const days = usageByDay([run(), run({ kind: 'follow_ups', followUps: 10 })], NOW);
    const today = days[days.length - 1];
    expect(days).toHaveLength(14);
    expect(today).toMatchObject({ cityRuns: 1, placesRequests: 3, sitesRead: 30, emails: 15, reoonChecked: 6 });
    expect(today.costInr).toBeCloseTo(3 * 2.9 + 30 * 0.13 + 15 * 0.12, 2);
  });
});

describe('buildActivity', () => {
  it('mixes runs and lead events, newest first', () => {
    const items = buildActivity(
      [{ 'School Name': 'A', Replied_at: iso(NOW - 60_000), Reply_intent: 'demo' }, { 'School Name': 'B', Bounced_status: 'true', Email_sent_at: iso(NOW - 2 * DAY) }],
      [run()],
      NOW
    );
    expect(items.map((i) => i.type)).toEqual(['reply', 'city_run', 'bounce']);
    expect(items[1].title).toBe('Pune · Coaching centre');
  });
});
