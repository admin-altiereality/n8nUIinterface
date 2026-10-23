import { describe, expect, it } from 'vitest';
import type { SchoolLeadRow } from '../api/sheetsClient';
import { cityFunnels, hasReplied, scoreLead } from './leadInsights';

const NOW = Date.parse('2026-10-02T09:30:00Z');
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

describe('scoreLead', () => {
  it('reads v3 click sets alongside the v2 click flags', () => {
    const v3 = scoreLead({ Clicked_buttons: 'demo, try', Click_count: '2', Last_Clicked_at: iso(NOW) }, NOW);
    expect(v3.intents).toEqual(['demo', 'try']);
    expect(v3.score).toBe(5 + 3 + 1);

    const v2 = scoreLead({ Clicked_Pricing: 'true', Last_Clicked_Button: 'btn_whatsapp', Click_count: '1', Last_Clicked_at: iso(NOW) }, NOW);
    expect(v2.intents).toEqual(['pricing', 'whatsapp']);
    expect(v2.score).toBe(8);
  });

  it('weights replies by intent and ignores auto-replies', () => {
    const at = { Replied_at: iso(NOW) };
    expect(scoreLead({ ...at, Reply_intent: 'demo' }, NOW).score).toBe(8);
    expect(scoreLead({ ...at, Reply_intent: 'pricing' }, NOW).score).toBe(7);
    expect(scoreLead({ ...at, Reply_intent: 'question' }, NOW).score).toBe(4);
    expect(scoreLead({ ...at, Reply_intent: 'not_now' }, NOW).score).toBe(2);
    expect(scoreLead({ ...at, Reply_intent: 'auto_reply' }, NOW).score).toBe(0);
  });

  it('halves every 14 days since the last engagement', () => {
    expect(scoreLead({ Replied_at: iso(NOW - 14 * DAY), Reply_intent: 'demo' }, NOW).score).toBe(4);
  });

  it('scores bounced, do-not-contact and Lost leads at zero', () => {
    const hot = { Replied_at: iso(NOW), Reply_intent: 'demo' };
    expect(scoreLead({ ...hot, Bounced_status: 'true' }, NOW).score).toBe(0);
    expect(scoreLead({ ...hot, Do_not_contact: 'unsubscribed:2026-10-01' }, NOW).score).toBe(0);
    expect(scoreLead({ ...hot, Stage: 'Lost' }, NOW).score).toBe(0);
    // A legacy "Drop" label no longer hides the lead: it may have been a pricing question.
    expect(scoreLead({ ...hot, Lead_status: 'Drop' }, NOW).score).toBe(8);
  });
});

describe('hasReplied', () => {
  it('counts a recorded reply time as a reply', () => {
    expect(hasReplied({ Replied_at: iso(NOW) })).toBe(true);
    expect(hasReplied({ Reply_Status: 'Awaiting response' })).toBe(false);
  });
});

describe('cityFunnels', () => {
  it('counts pipeline milestones per city', () => {
    const rows: SchoolLeadRow[] = [
      { City: 'Jaipur', Stage: 'New' },
      { City: 'Jaipur', Stage: 'Contacted' },
      { City: 'Jaipur', Stage: 'Engaged', Replied_at: iso(NOW), Reply_intent: 'pricing' },
      { City: 'Jaipur', Stage: 'Lost', Demo_booked_at: iso(NOW - 3 * DAY) },
      { City: 'jaipur', Stage: 'Won' },
      { City: 'Patna', Stage: 'Demo booked' },
    ];
    const [jaipur, patna] = cityFunnels(rows, NOW);
    expect(jaipur).toEqual({ city: 'Jaipur', leads: 5, contacted: 4, replied: 1, demos: 2, won: 1, hot: 1 });
    expect(patna).toMatchObject({ city: 'Patna', leads: 1, contacted: 1, demos: 1, won: 0 });
  });
});
