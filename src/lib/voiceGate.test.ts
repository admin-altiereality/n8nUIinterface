import { describe, expect, it } from 'vitest';
import type { SchoolLeadRow } from '../api/sheetsClient';
import { e164, inCallingHours, voiceDecision, type VoiceGateSettings } from './voiceGate';

// Tuesday 20 Oct 2026, 11:30 IST
const NOW = Date.parse('2026-10-20T06:00:00Z');
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const settings: VoiceGateSettings = {
  voiceMode: 'live',
  voiceDailyCallCap: 30,
  voiceMonthlyMinuteBudget: 2000,
  voiceHours: { start: 10, end: 18 },
  voiceTestNumbers: ['+918619953434'],
};
const usage = { callsToday: 0, minutesThisMonth: 0 };
const lead = (over: Record<string, string> = {}) => ({ 'Phone number': '98290 12345', Stage: 'Engaged', Consent_at: iso(NOW - DAY), ...over }) as SchoolLeadRow;

describe('e164', () => {
  it('normalises Indian mobiles and rejects the rest', () => {
    expect(e164('98290 12345')).toBe('+919829012345');
    expect(e164('+91 98290-12345')).toBe('+919829012345');
    expect(e164('09829012345')).toBe('+919829012345');
    expect(e164('0141 2345678')).toBeNull();
    expect(e164('')).toBeNull();
  });
});

describe('inCallingHours', () => {
  it('allows Mon–Sat inside the window only', () => {
    expect(inCallingHours(NOW, settings.voiceHours)).toBe(true);
    expect(inCallingHours(Date.parse('2026-10-20T13:00:00Z'), settings.voiceHours)).toBe(false); // 18:30 IST
    expect(inCallingHours(Date.parse('2026-10-18T06:00:00Z'), settings.voiceHours)).toBe(false); // Sunday
  });
});

describe('voiceDecision', () => {
  it('calls a fresh enquiry inside hours', () => {
    expect(voiceDecision(lead(), settings, usage, NOW)).toEqual({ status: 'call', reason: 'New enquiry' });
  });

  it('never calls without consent, after 7 days, after opt-out or for closed deals', () => {
    expect(voiceDecision(lead({ Consent_at: '' }), settings, usage, NOW).reason).toMatch(/No enquiry consent/);
    expect(voiceDecision(lead({ Consent_at: iso(NOW - 8 * DAY) }), settings, usage, NOW).reason).toMatch(/older than 7 days/);
    expect(voiceDecision(lead({ Voice_opt_out: 'yes' }), settings, usage, NOW).status).toBe('skip');
    expect(voiceDecision(lead({ Do_not_contact: 'unsubscribed' }), settings, usage, NOW).status).toBe('skip');
    expect(voiceDecision(lead({ Stage: 'Won' }), settings, usage, NOW).status).toBe('skip');
    expect(voiceDecision(lead({ 'Phone number': '' }), settings, usage, NOW).reason).toBe('No mobile number');
  });

  it('stops after 2 attempts or a final outcome, and spaces retries', () => {
    expect(voiceDecision(lead({ AI_call_attempts: '2' }), settings, usage, NOW).reason).toMatch(/2 attempts/);
    expect(voiceDecision(lead({ AI_call_outcome: 'demo_booked' }), settings, usage, NOW).status).toBe('skip');
    expect(voiceDecision(lead({ AI_call_attempts: '1', Last_AI_call_at: iso(NOW - 3_600_000) }), settings, usage, NOW).status).toBe('wait');
    expect(voiceDecision(lead({ AI_call_attempts: '1', Last_AI_call_at: iso(NOW - 4 * 3_600_000) }), settings, usage, NOW).reason).toBe('Retry');
  });

  it('honours callbacks the lead asked for, even after 7 days', () => {
    const old = { Consent_at: iso(NOW - 20 * DAY), AI_call_attempts: '2' };
    expect(voiceDecision(lead({ ...old, AI_callback_at: iso(NOW + 3_600_000) }), settings, usage, NOW).status).toBe('wait');
    expect(voiceDecision(lead({ ...old, AI_callback_at: iso(NOW - 60_000) }), settings, usage, NOW)).toEqual({ status: 'call', reason: 'Callback due' });
  });

  it('respects mode, test numbers, hours and caps', () => {
    expect(voiceDecision(lead(), { ...settings, voiceMode: 'off' }, usage, NOW).reason).toBe('AI calling is off');
    expect(voiceDecision(lead(), { ...settings, voiceMode: 'test' }, usage, NOW).status).toBe('skip');
    expect(voiceDecision(lead({ 'Phone number': '8619953434' }), { ...settings, voiceMode: 'test' }, usage, NOW).status).toBe('call');
    expect(voiceDecision(lead(), settings, usage, Date.parse('2026-10-20T14:00:00Z')).reason).toBe('Outside calling hours');
    expect(voiceDecision(lead(), settings, { callsToday: 30, minutesThisMonth: 0 }, NOW).reason).toMatch(/Daily call cap/);
    expect(voiceDecision(lead(), settings, { callsToday: 0, minutesThisMonth: 2000 }, NOW).reason).toMatch(/minutes used up/);
  });
});
