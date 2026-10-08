import { describe, expect, it } from 'vitest';
import type { SchoolLeadRow } from '../api/sheetsClient';
import {
  formatDuration,
  formatInr,
  funnelConversion,
  istDayStart,
  istMonthStart,
  pipelineByStage,
  salesKpis,
  todayQueue,
  tomorrowMorning,
  whatsappWindowLeftMs,
  channelRoi,
  leadSource,
  isChannelPartner,
} from './pipeline';

// 2 Oct 2026, 15:00 IST
const NOW = Date.parse('2026-10-02T09:30:00Z');
const iso = (t: number) => new Date(t).toISOString();
const HOUR = 3_600_000;
const lead = (id: string, extra: Partial<SchoolLeadRow>): SchoolLeadRow => ({ Lead_id: id, 'School Name': id, ...extra });

describe('IST boundaries', () => {
  it('starts the day at midnight India time', () => {
    // 01:30 IST on 3 Oct belongs to 3 Oct, not 2 Oct (UTC).
    expect(iso(istDayStart(Date.parse('2026-10-02T20:00:00Z')))).toBe('2026-10-02T18:30:00.000Z');
  });
  it('starts the month at midnight India time', () => {
    expect(iso(istMonthStart(Date.parse('2026-10-31T19:00:00Z')))).toBe('2026-10-31T18:30:00.000Z');
    expect(iso(istMonthStart(NOW))).toBe('2026-09-30T18:30:00.000Z');
  });
  it('snoozes to 10:00 IST tomorrow', () => {
    expect(iso(tomorrowMorning(NOW))).toBe('2026-10-03T04:30:00.000Z');
  });
});

describe('todayQueue', () => {
  const me = 'rep@altiereality.com';
  const rows = [
    lead('demo', { Stage: 'Demo booked', Owner: me, Demo_at: iso(NOW + 2 * HOUR), Next_step: 'Prep', Next_step_due: iso(NOW - HOUR) }),
    lead('overdue', { Stage: 'Engaged', Owner: me, Next_step: 'Call back', Next_step_due: iso(NOW - 26 * HOUR) }),
    lead('later', { Stage: 'Engaged', Owner: me, Next_step: 'Send deck', Next_step_due: iso(NOW + 30 * HOUR) }),
    lead('hot', { Stage: 'Engaged', Hot_at: iso(NOW - HOUR), Reply_channel: 'whatsapp', Replied_at: iso(NOW - 2 * HOUR) }),
    lead('missed', { Stage: 'Demo booked', Owner: me, Demo_at: iso(NOW - 26 * HOUR) }),
    lead('planless', { Stage: 'Proposal', Owner: me }),
    lead('theirs', { Stage: 'Engaged', Owner: 'other@altiereality.com', Next_step: 'Call', Next_step_due: iso(NOW) }),
    lead('lost', { Stage: 'Lost', Owner: me, Next_step: 'x', Next_step_due: iso(NOW) }),
    lead('dnc', { Stage: 'Engaged', Owner: me, Do_not_contact: 'manual:2026-10-01', Next_step: 'x', Next_step_due: iso(NOW) }),
    lead('cold', { Stage: 'Contacted' }),
  ];
  const ids = (items: Array<{ row: SchoolLeadRow }>) => items.map((i) => i.row.Lead_id);

  it('puts each lead in one section, in priority order', () => {
    const q = todayQueue(rows, { now: NOW, owner: me });
    expect(ids(q.demos_today)).toEqual(['demo']);
    expect(ids(q.due)).toEqual(['overdue']);
    expect(q.due[0].overdue).toBe(true);
    expect(ids(q.hot_unclaimed)).toEqual(['hot']);
    expect(ids(q.needs_outcome)).toEqual(['missed']);
    expect(ids(q.no_next_step)).toEqual(['planless']);
  });

  it('shows other reps\' leads only in the All view', () => {
    expect(ids(todayQueue(rows, { now: NOW, owner: me }).due)).not.toContain('theirs');
    expect(ids(todayQueue(rows, { now: NOW }).due)).toEqual(['overdue', 'theirs']);
  });

  it('counts down the WhatsApp reply window', () => {
    const hot = todayQueue(rows, { now: NOW }).hot_unclaimed[0];
    expect(hot.windowLeftMs).toBe(22 * HOUR);
    expect(whatsappWindowLeftMs(lead('old', { Reply_channel: 'whatsapp', Replied_at: iso(NOW - 25 * HOUR) }), NOW)).toBeNull();
    expect(whatsappWindowLeftMs(lead('email', { Reply_channel: 'email', Replied_at: iso(NOW) }), NOW)).toBeNull();
  });
});

describe('salesKpis', () => {
  const rows = [
    lead('a', { Stage: 'Engaged', Deal_value: '50000', Hot_at: iso(NOW - 10 * HOUR), First_touch_at: iso(NOW - 9.5 * HOUR) }),
    lead('b', { Stage: 'Proposal', Deal_value: '₹1,20,000', Demo_booked_at: iso(NOW - 5 * 24 * HOUR), Hot_at: iso(NOW - 20 * HOUR), First_touch_at: iso(NOW - 17 * HOUR) }),
    lead('c', { Stage: 'Won', Deal_value: '90000', Paid_amount: '80000', Won_at: iso(NOW - HOUR), Demo_booked_at: iso(NOW - 24 * HOUR) }),
    lead('d', { Stage: 'Won', Deal_value: '70000', Won_at: '2026-09-29T10:00:00Z' }),
    lead('e', { Stage: 'Lost', Deal_value: '40000', Demo_booked_at: '2026-09-15T10:00:00Z' }),
    lead('f', { Stage: 'Engaged', Hot_at: iso(NOW - HOUR), First_touch_at: iso(NOW - 2 * HOUR) }),
  ];

  it('sums the open pipeline and this month\'s wins and demos', () => {
    const k = salesKpis(rows, { now: NOW, targetInr: 160000, spendInr: 30000 });
    expect([k.openValue, k.openCount]).toEqual([170000, 3]);
    expect([k.wonValue, k.wonCount]).toEqual([80000, 1]);
    expect(k.demosBooked).toBe(1);
    expect(k.targetShare).toBe(0.5);
    expect(k.costPerDemo).toBe(30000);
  });

  it('measures speed to lead from hot to first touch', () => {
    const k = salesKpis(rows, { now: NOW });
    // a: 30m, b: 3h; f touched before it went hot, so it is left out.
    expect(k.speedSample).toBe(2);
    expect(k.speedMedianMs).toBe(1.75 * HOUR);
    expect(k.speedUnderHourShare).toBe(0.5);
    expect(k.costPerDemo).toBeNull();
    expect(k.targetShare).toBeNull();
  });
});

describe('funnelConversion', () => {
  it('counts every lead that reached a step, including lost ones', () => {
    const rows = [
      lead('new', { Stage: 'New' }),
      lead('contacted', { Stage: 'Contacted' }),
      lead('lost-after-demo', { Stage: 'Lost', Hot_at: iso(NOW), Demo_booked_at: iso(NOW) }),
      lead('won', { Stage: 'Won' }),
    ];
    expect(Object.fromEntries(funnelConversion(rows).map((s) => [s.label, s.count]))).toEqual({
      Contacted: 3,
      Engaged: 2,
      'Demo booked': 2,
      'Demo done': 1,
      Proposal: 1,
      Won: 1,
    });
  });
});

describe('pipelineByStage', () => {
  it('groups by stage with soonest next step first and totals deal value', () => {
    const columns = pipelineByStage([
      lead('x', { Stage: 'Engaged', Deal_value: '1000', Next_step_due: iso(NOW + HOUR) }),
      lead('y', { Stage: 'Engaged', Deal_value: '2000', Next_step_due: iso(NOW - HOUR) }),
      lead('z', { Stage: 'Engaged' }),
      lead('legacy', {}),
    ]);
    const engaged = columns.find((c) => c.stage === 'Engaged')!;
    expect(engaged.rows.map((r) => r.Lead_id)).toEqual(['y', 'x', 'z']);
    expect(engaged.value).toBe(3000);
    expect(columns.find((c) => c.stage === 'New')!.rows.map((r) => r.Lead_id)).toEqual(['legacy']);
  });
});

describe('formatting', () => {
  it('formats rupees the Indian way and durations compactly', () => {
    expect(formatInr(123456)).toBe('₹1,23,456');
    expect(formatDuration(42 * 60_000)).toBe('42m');
    expect(formatDuration(3 * HOUR + 5 * 60_000)).toBe('3h 5m');
    expect(formatDuration(72 * HOUR)).toBe('3d');
  });
});

describe('leadSource', () => {
  it('uses Lead_source when set', () => {
    expect(leadSource({ Lead_source: 'instagram_ad' } as SchoolLeadRow)).toBe('instagram_ad');
  });

  it('infers the source of older rows', () => {
    expect(leadSource({ XR_keywords: 'facebook_lead_ad, Indore' } as SchoolLeadRow)).toBe('facebook_ad');
    expect(leadSource({ Status: 'website_lead' } as SchoolLeadRow)).toBe('website');
    expect(leadSource({ XR_status: 'Inbound Website Lead' } as SchoolLeadRow)).toBe('website');
    expect(leadSource({ Status: 'sent' } as SchoolLeadRow)).toBe('cold_email');
    expect(leadSource({ Lead_source: 'tv' } as SchoolLeadRow)).toBe('cold_email');
  });
});

describe('isChannelPartner', () => {
  it('spots partner leads by form, next step or answers', () => {
    expect(isChannelPartner({ Lead_form: 'LearnXR Channel Partner form' } as SchoolLeadRow)).toBe(true);
    expect(isChannelPartner({ Next_step: 'Call channel partner lead' } as SchoolLeadRow)).toBe(true);
    expect(isChannelPartner({ Achievments: 'channel partner enquiry | city: Raipur' } as SchoolLeadRow)).toBe(true);
    expect(isChannelPartner({ Lead_form: 'School lead v2', Next_step: 'Call Facebook ad lead' } as SchoolLeadRow)).toBe(false);
  });
});

describe('channelRoi', () => {
  const from = Date.parse('2026-10-01T00:00:00+05:30');
  const to = Date.parse('2026-11-01T00:00:00+05:30');
  const rows = [
    { Lead_source: 'instagram_ad', Time: '2026-10-02T10:00:00+05:30', Hot_at: '2026-10-02T10:00:00+05:30', Demo_booked_at: '2026-10-05T10:00:00+05:30' },
    { Lead_source: 'instagram_ad', Time: '2026-10-03T10:00:00+05:30', Stage: 'Won', Won_at: '2026-10-20T10:00:00+05:30', Paid_amount: '50000' },
    { Lead_source: 'cold_email', Time: '2026-09-20T10:00:00+05:30', Email_sent_at: '2026-09-20T10:00:00+05:30', Hot_at: '2026-10-04T10:00:00+05:30' },
  ] as SchoolLeadRow[];

  it('counts events in the window per source and divides the spend', () => {
    const roi = channelRoi(rows, { from, to, spendBySource: { instagram_ad: 3000, cold_email: 1000 } });
    const ig = roi.find((r) => r.source === 'instagram_ad')!;
    expect(ig).toMatchObject({ leads: 2, engaged: 1, demos: 1, won: 1, wonInr: 50000, costPerLead: 1500, costPerDemo: 3000, costPerDeal: 3000 });
    const email = roi.find((r) => r.source === 'cold_email')!;
    expect(email).toMatchObject({ leads: 0, engaged: 1, demos: 0, costPerLead: null, costPerDemo: null });
  });

  it('returns every source, even with no activity', () => {
    expect(channelRoi([], { from, to, spendBySource: {} }).map((r) => r.source)).toEqual(['instagram_ad', 'facebook_ad', 'website', 'whatsapp', 'cold_email']);
  });
});

describe('isTestLead', () => {
  it('flags ZZ Test rows only', async () => {
    const { isTestLead } = await import('./useSheetLeads');
    expect(isTestLead({ 'School Name': 'ZZ Test School (social source test)' } as SchoolLeadRow)).toBe(true);
    expect(isTestLead({ 'School Name': 'zz test' } as SchoolLeadRow)).toBe(true);
    expect(isTestLead({ 'School Name': 'DPS Indore' } as SchoolLeadRow)).toBe(false);
  });
});
