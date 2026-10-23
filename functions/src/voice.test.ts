import { describe, expect, it } from 'vitest';
import { voiceCallFromExecution, voiceTotals, type VoiceCall } from './voice';

const execution = (over: Record<string, unknown> = {}) => ({
  id: 'b7140255-af33-4608-8e97-04dd944b8e48',
  status: 'completed',
  conversation_duration: 95,
  transcript: 'assistant: Hello, am I speaking with Asha?\nuser: Yes, tell me.\nassistant: ...',
  user_number: '+919876543210',
  total_cost: 20,
  extracted_data: { outcome: 'demo_booked', interest: '5', summary: 'Principal booked a demo for Friday.', students: 600 },
  telephony_data: { recording_url: 'https://api.bolna.ai/recordings/call/x', hangup_reason: 'Normal Hangup' },
  usage_breakdown: { synthesizer_provider: 'elevenlabs' },
  created_at: '2026-10-20T05:00:00Z',
  updated_at: '2026-10-20T05:02:00Z',
  ...over,
});
const meta = { leadId: 'lx1abc', orgName: 'Vivek Techno School', audience: 'school' };

describe('voiceCallFromExecution', () => {
  it('keeps what the dashboard needs and masks the number', () => {
    const c = voiceCallFromExecution(execution(), meta) as VoiceCall;
    expect(c).toMatchObject({
      leadId: 'lx1abc',
      toLast4: '3210',
      terminal: true,
      outcome: 'demo_booked',
      interest: 5,
      seconds: 95,
      voice: 'elevenlabs',
      hasRecording: true,
      costInr: 17,
      summary: 'Principal booked a demo for Friday.',
    });
    expect(c.extracted.students).toBe(600);
    expect(JSON.stringify(c)).not.toContain('9876543210');
  });

  it('treats a call the person never spoke on as no conversation, whatever the extraction says', () => {
    const silent = voiceCallFromExecution(execution({ transcript: 'assistant: Hello?\nassistant: Are you there?' }), meta) as VoiceCall;
    expect(silent.outcome).toBe('no_conversation');
    const rejected = voiceCallFromExecution(execution({ conversation_duration: 0 }), meta) as VoiceCall;
    expect(rejected.outcome).toBe('no_conversation');
  });

  it('marks non-final statuses and defaults unknown outcomes', () => {
    const ringing = voiceCallFromExecution(execution({ status: 'ringing', extracted_data: { outcome: 'maybe' } }), meta) as VoiceCall;
    expect(ringing.terminal).toBe(false);
    expect(ringing.outcome).toBe('interested');
  });

  it('rejects payloads without ids', () => {
    expect(voiceCallFromExecution({}, meta)).toMatch(/Execution id/);
    expect(voiceCallFromExecution(execution(), {})).toMatch(/leadId/);
  });
});

describe('voiceTotals', () => {
  it('adds up calls, minutes, cost and results per voice', () => {
    const a = voiceCallFromExecution(execution(), meta) as VoiceCall;
    const b = voiceCallFromExecution(execution({ id: 'c1111111-0000', conversation_duration: 0, usage_breakdown: { synthesizer_provider: 'sarvam' } }), meta) as VoiceCall;
    const t = voiceTotals([a, b]);
    expect(t).toMatchObject({ calls: 2, conversations: 1, demosBooked: 1, minutes: 2 });
    expect(t.byVoice.elevenlabs).toEqual({ calls: 1, conversations: 1, demosBooked: 1 });
    expect(t.byVoice.sarvam.conversations).toBe(0);
  });
});
