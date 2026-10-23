import type { SchoolLeadRow } from '../api/sheetsClient';

/**
 * Who the AI agent may call, and why not. The same rules run in n8n "Sales • Voice Agent" (Gate node); keep them in
 * step. Based on TRAI's rules for automated calls: only people who enquired, within 7 days of the enquiry (or a
 * callback they asked for), never after an opt-out, inside calling hours, at most 2 attempts.
 */

export type VoiceGateSettings = {
  voiceMode: 'off' | 'test' | 'live';
  voiceDailyCallCap: number;
  voiceMonthlyMinuteBudget: number;
  voiceHours: { start: number; end: number };
  voiceTestNumbers: string[];
};

export type VoiceUsage = { callsToday: number; minutesThisMonth: number };

export type VoiceDecision = { status: 'call' | 'wait' | 'skip'; reason: string };

export const CONSENT_DAYS = 7;
export const MAX_ATTEMPTS = 2;
const RETRY_GAP_MS = 3 * 3_600_000;
const DONE_OUTCOMES = ['demo_booked', 'not_interested', 'opted_out', 'wrong_person'];

const get = (row: SchoolLeadRow, key: string) => String(row[key] ?? '').trim();
const time = (row: SchoolLeadRow, key: string) => {
  const t = Date.parse(get(row, key));
  return Number.isNaN(t) ? null : t;
};

/** +91 for 10-digit Indian mobiles; null when it can't be a callable number. */
export function e164(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  const d = digits.replace(/\D/g, '');
  if (/^[6-9]\d{9}$/.test(d)) return `+91${d}`;
  if (/^91[6-9]\d{9}$/.test(d)) return `+${d}`;
  if (/^0[6-9]\d{9}$/.test(d)) return `+91${d.slice(1)}`;
  return null;
}

/** Is `now` inside the calling window: Monday–Saturday, start ≤ IST hour < end. */
export function inCallingHours(now: number, hours: { start: number; end: number }): boolean {
  const ist = new Date(now + 5.5 * 3_600_000);
  const hour = ist.getUTCHours();
  return ist.getUTCDay() !== 0 && hour >= hours.start && hour < hours.end;
}

export function voiceDecision(row: SchoolLeadRow, settings: VoiceGateSettings, usage: VoiceUsage, now = Date.now()): VoiceDecision {
  const phone = e164(get(row, 'Phone number'));
  if (!phone) return { status: 'skip', reason: 'No mobile number' };
  if (get(row, 'Do_not_contact') || /^(y|yes|true)$/i.test(get(row, 'Voice_opt_out'))) return { status: 'skip', reason: 'Opted out' };
  if (['Won', 'Lost'].includes(get(row, 'Stage'))) return { status: 'skip', reason: `Deal ${get(row, 'Stage').toLowerCase()}` };
  if (DONE_OUTCOMES.includes(get(row, 'AI_call_outcome'))) return { status: 'skip', reason: `Last call: ${get(row, 'AI_call_outcome').replace(/_/g, ' ')}` };

  const callbackAt = time(row, 'AI_callback_at');
  const consentAt = time(row, 'Consent_at');
  const attempts = Number(get(row, 'AI_call_attempts')) || 0;
  if (callbackAt === null) {
    if (consentAt === null) return { status: 'skip', reason: 'No enquiry consent on record' };
    if (now - consentAt > CONSENT_DAYS * 86_400_000) return { status: 'skip', reason: `Enquiry older than ${CONSENT_DAYS} days` };
    if (attempts >= MAX_ATTEMPTS) return { status: 'skip', reason: `${MAX_ATTEMPTS} attempts made` };
  } else if (callbackAt > now) {
    return { status: 'wait', reason: 'Callback scheduled' };
  }

  const last = time(row, 'Last_AI_call_at');
  if (last !== null && now - last < RETRY_GAP_MS && callbackAt === null) return { status: 'wait', reason: 'Called in the last 3 hours' };

  if (settings.voiceMode === 'off') return { status: 'wait', reason: 'AI calling is off' };
  if (settings.voiceMode === 'test' && !settings.voiceTestNumbers.includes(phone)) return { status: 'skip', reason: 'Test mode: not a test number' };
  if (!inCallingHours(now, settings.voiceHours)) return { status: 'wait', reason: 'Outside calling hours' };
  if (usage.callsToday >= settings.voiceDailyCallCap) return { status: 'wait', reason: 'Daily call cap reached' };
  if (usage.minutesThisMonth >= settings.voiceMonthlyMinuteBudget) return { status: 'wait', reason: 'Monthly minutes used up' };
  return { status: 'call', reason: callbackAt !== null ? 'Callback due' : attempts ? 'Retry' : 'New enquiry' };
}
