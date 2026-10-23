import { describe, expect, it } from 'vitest';
import { auditEvents, messageEvents, rowEvents, schoolSummary, sortTimeline, toE164 } from './schools';

describe('toE164', () => {
  it('normalises Indian mobiles written different ways', () => {
    expect(toE164('9876543210')).toBe('+919876543210');
    expect(toE164('09876543210')).toBe('+919876543210');
    expect(toE164('919876543210')).toBe('+919876543210');
    expect(toE164('whatsapp:+919876543210')).toBe('+919876543210');
    expect(toE164('255 1234')).toBe('');
    expect(toE164('')).toBe('');
  });
});

describe('rowEvents', () => {
  it('turns funnel milestones into events', () => {
    const events = rowEvents({
      Lead_id: 'lx1',
      'Principal Name': 'Asha',
      Lead_source: 'instagram_ad',
      Lead_campaign: 'Indore principals',
      Time: '2026-10-01T10:00:00Z',
      Hot_at: '2026-10-01T10:00:00Z',
      Demo_booked_at: '2026-10-02T09:00:00Z',
      Demo_at: '2026-10-05T09:00:00Z',
      Won_at: '2026-10-20T09:00:00Z',
      Paid_amount: '50000',
      Do_not_contact: 'unsubscribed:2026-10-21T09:00:00Z',
    });
    expect(events.map((e) => e.title)).toEqual([
      'Instagram lead form submitted',
      'Marked hot',
      'Demo booked',
      'Won',
      'Do not contact',
    ]);
    expect(events[0]).toMatchObject({ kind: 'form', detail: 'Asha · Indore principals', leadId: 'lx1' });
    expect(events[3].detail).toBe('Paid ₹50000');
    expect(events[4].detail).toBe('unsubscribed');
  });

  it('labels city-run leads and skips empty or bad dates', () => {
    const events = rowEvents({ Lead_id: 'lx2', Time: '2026-10-01T10:00:00Z', Email_sent_at: 'not a date', Follow_up_count: '2', Last_Follow_up: '2026-10-04T10:00:00Z' });
    expect(events.map((e) => e.title)).toEqual(['Found by city run', 'Follow-up 2 sent']);
  });
});

describe('auditEvents', () => {
  it('keeps lead actions with readable details', () => {
    const events = auditEvents([
      { action: 'lead.note', createdAt: '2026-10-02T10:00:00Z', targetId: 'lx1', actorEmail: 'bda@x.com', details: { text: 'Call back Monday' } },
      { action: 'lead.update', createdAt: '2026-10-02T11:00:00Z', targetId: 'lx1', details: { fields: { Stage: 'Engaged', Owner: 'me' } } },
      { action: 'twilio.inbound.persisted', createdAt: '2026-10-02T11:00:00Z' },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'note', title: 'Note', detail: 'Call back Monday', actor: 'bda@x.com' });
    expect(events[1]).toMatchObject({ kind: 'system', title: 'Lead updated', detail: 'Stage, Owner' });
  });
});

describe('messageEvents', () => {
  it('shows both directions, flags failed sends and drops duplicates', () => {
    const events = messageEvents([
      { sid: 'SM1', direction: 'inbound', body: 'Send pricing', date_sent: 'Fri, 02 Oct 2026 10:00:00 +0000' },
      { sid: 'SM2', direction: 'outbound-api', body: 'Here it is', status: 'undelivered', date_sent: 'Fri, 02 Oct 2026 10:05:00 +0000' },
      { sid: 'SM1', direction: 'inbound', body: 'Send pricing', date_sent: 'Fri, 02 Oct 2026 10:00:00 +0000' },
    ]);
    expect(events.map((e) => e.title)).toEqual(['WhatsApp from school', 'WhatsApp sent (undelivered)']);
  });
});

describe('sortTimeline and schoolSummary', () => {
  it('puts the newest event first', () => {
    const sorted = sortTimeline([
      { at: '2026-10-01T00:00:00.000Z', kind: 'lead', title: 'a' },
      { at: '2026-10-03T00:00:00.000Z', kind: 'lead', title: 'b' },
    ]);
    expect(sorted.map((e) => e.title)).toEqual(['b', 'a']);
  });

  it('summarises a school with several contacts', () => {
    const s = schoolSummary([
      { Lead_id: 'lx1', 'School Name': 'DPS Indore', City: 'Indore', 'Principal Name': 'Asha', 'Phone number': '9876543210', Stage: 'Engaged' },
      { Lead_id: 'lx2', 'School Name': '', 'Principal Name': 'Ravi', Status: 'website_lead' },
    ]);
    expect(s).toMatchObject({ name: 'DPS Indore', city: 'Indore' });
    expect(s.contacts).toEqual([
      expect.objectContaining({ leadId: 'lx1', phone: '+919876543210', stage: 'Engaged', source: 'cold_email' }),
      expect.objectContaining({ leadId: 'lx2', stage: 'New', source: 'website' }),
    ]);
  });
});
