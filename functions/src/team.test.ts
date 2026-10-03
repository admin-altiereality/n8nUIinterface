import { describe, expect, it } from 'vitest';
import { businessMs, leaderboard, slaAlert, slaBreaches, weeklyDigest } from './team';

const HOUR = 3_600_000;
// Times written in IST for readability.
const ist = (s: string) => Date.parse(`${s}+05:30`);

describe('businessMs', () => {
  it('counts only Mon–Sat 10:00–19:00 IST', () => {
    // Fri 2 Oct 2026 18:00 → Sat 3 Oct 11:00 = 1 h Friday + 1 h Saturday
    expect(businessMs(ist('2026-10-02T18:00:00'), ist('2026-10-03T11:00:00'))).toBe(2 * HOUR);
    // Sat 18:30 → Mon 10:30 skips Sunday: 0.5 h + 0.5 h
    expect(businessMs(ist('2026-10-03T18:30:00'), ist('2026-10-05T10:30:00'))).toBe(HOUR);
    // Night only
    expect(businessMs(ist('2026-10-02T20:00:00'), ist('2026-10-02T23:00:00'))).toBe(0);
    expect(businessMs(ist('2026-10-02T12:00:00'), ist('2026-10-02T11:00:00'))).toBe(0);
  });
});

describe('slaBreaches', () => {
  const now = ist('2026-10-02T16:00:00');
  it('reminds the owner after 1 h and the manager after 4 h, skipping touched, closed and test leads', () => {
    const rows = [
      { Lead_id: 'a', 'School Name': 'A', Owner: 'Bda@x.com', Hot_at: '2026-10-02T14:30:00+05:30' },
      { Lead_id: 'b', 'School Name': 'B', Hot_at: '2026-10-02T10:30:00+05:30' },
      { Lead_id: 'c', 'School Name': 'C', Hot_at: '2026-10-02T15:30:00+05:30' },
      { Lead_id: 'd', 'School Name': 'D', Hot_at: '2026-10-02T10:00:00+05:30', First_touch_at: '2026-10-02T11:00:00+05:30' },
      { Lead_id: 'e', 'School Name': 'E', Hot_at: '2026-10-02T10:00:00+05:30', Stage: 'Lost' },
      { Lead_id: 'f', 'School Name': 'ZZ Test', Hot_at: '2026-10-02T10:00:00+05:30' },
      { Lead_id: 'g', 'School Name': 'G', Hot_at: '2026-10-02T10:00:00+05:30', Do_not_contact: 'unsubscribed:2026-10-02' },
    ];
    const breaches = slaBreaches(rows, now);
    expect(breaches.map((b) => [b.leadId, b.level])).toEqual([
      ['b', 'manager'],
      ['a', 'owner'],
    ]);
    expect(breaches[1].owner).toBe('bda@x.com');
    expect(slaAlert(breaches).title).toBe('2 hot lead(s) not contacted yet (1 over 4 h)');
  });
});

describe('leaderboard', () => {
  it('credits owners for deals and actors for touches in the window', () => {
    const from = ist('2026-09-28T00:00:00');
    const to = ist('2026-10-05T00:00:00');
    const rows = [
      { Owner: 'bda@x.com', Stage: 'Demo booked', Demo_booked_at: '2026-10-01T10:00:00+05:30', Hot_at: '2026-10-01T10:00:00+05:30', First_touch_at: '2026-10-01T10:30:00+05:30' },
      { Owner: 'bda@x.com', Stage: 'Won', Won_at: '2026-10-02T10:00:00+05:30', Paid_amount: '40000' },
      { Owner: 'sales@x.com', Stage: 'Engaged' },
    ];
    const audit = [
      { action: 'lead.call', actorEmail: 'bda@x.com', createdAt: '2026-10-01T10:30:00+05:30' },
      { action: 'lead.note', actorEmail: 'bda@x.com', createdAt: '2026-10-01T10:31:00+05:30', details: { text: 'Called' } },
      { action: 'lead.note', actorEmail: 'sales@x.com', createdAt: '2026-10-01T12:00:00+05:30', details: { text: 'Sent brochure' } },
      { action: 'lead.update', actorEmail: 'sales@x.com', createdAt: '2026-09-01T12:00:00+05:30' },
      { action: 'settings.update', actorEmail: 'admin@x.com', createdAt: '2026-10-01T12:00:00+05:30' },
    ];
    const board = leaderboard(rows, audit, { from, to });
    expect(board[0]).toMatchObject({ rep: 'bda@x.com', calls: 2, touches: 2, demos: 1, won: 1, wonInr: 40000, speedMedianMs: 30 * 60_000 });
    expect(board[1]).toMatchObject({ rep: 'sales@x.com', openDeals: 1, notes: 1, touches: 1, calls: 0 });
    expect(board.map((r) => r.rep)).not.toContain('admin@x.com');
  });
});

describe('weeklyDigest', () => {
  it('summarises the week by source and lists overdue deals', () => {
    const now = ist('2026-10-05T09:00:00');
    const { title, text } = weeklyDigest(
      [
        { 'School Name': 'A', Lead_source: 'instagram_ad', Time: '2026-10-02T10:00:00+05:30', Hot_at: '2026-10-02T10:00:00+05:30', First_touch_at: '2026-10-02T10:10:00+05:30' },
        { 'School Name': 'B', Stage: 'Proposal', Owner: 'bda@x.com', Next_step: 'Chase the quote', Next_step_due: '2026-10-01T10:00:00+05:30' },
        { 'School Name': 'ZZ Test', Lead_source: 'instagram_ad', Time: '2026-10-02T10:00:00+05:30' },
      ],
      [],
      now
    );
    expect(title).toBe('Weekly sales digest — 1 leads, 0 demos, ₹0 won');
    expect(text).toContain('- Instagram ads: 1 leads, 1 hot, 0 demos, 0 won');
    expect(text).toContain('- B (Proposal, bda): Chase the quote');
  });
});
