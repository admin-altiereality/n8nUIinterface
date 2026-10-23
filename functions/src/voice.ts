/**
 * AI calls placed by "Sales • Voice Agent" (n8n → Bolna). n8n posts each call's Bolna execution here; we keep a
 * trimmed record in Firestore `voiceCalls/{executionId}` for the /calls page and the lead timeline.
 */

export const VOICE_CALLS = "voiceCalls";

/** Bolna statuses after which no more webhook deliveries come for a call. */
const TERMINAL = new Set(["completed", "no-answer", "busy", "failed", "canceled", "stopped", "error", "balance-low"]);

export const OUTCOMES = [
  "demo_booked",
  "interested",
  "callback",
  "not_interested",
  "wrong_person",
  "opted_out",
  "no_conversation",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type VoiceCall = {
  id: string;
  leadId: string;
  orgName: string;
  audience: "school" | "partner";
  /** Last 4 digits only; the full number lives on the lead row. */
  toLast4: string;
  status: string;
  terminal: boolean;
  outcome: Outcome;
  interest: number | null;
  summary: string;
  extracted: Record<string, unknown>;
  transcript: string;
  seconds: number;
  costInr: number | null;
  /** Synthesizer provider, for the ElevenLabs vs Sarvam comparison. */
  voice: string;
  hangupReason: string;
  hasRecording: boolean;
  createdAt: string;
  updatedAt: string;
};

const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Bolna nests a summary under General > Call Summary when no extraction prompt matched; flatten what we use. */
function extractedFields(raw: unknown): Record<string, unknown> {
  const e = obj(raw);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === "General") continue;
    if (v === null || ["string", "number", "boolean"].includes(typeof v) || Array.isArray(v)) out[k] = v;
  }
  return out;
}

/**
 * Builds our record from a Bolna execution payload plus what n8n knows about the lead. Pure, so it's tested.
 * A call counts as a conversation only if it lasted and the caller spoke (Bolna marks rejected calls "completed").
 */
export function voiceCallFromExecution(
  execution: unknown,
  meta: { leadId?: unknown; orgName?: unknown; audience?: unknown }
): VoiceCall | string {
  const e = obj(execution);
  const id = str(e.id, 80);
  if (!/^[\w-]{8,80}$/.test(id)) return "Execution id missing.";
  const leadId = str(meta.leadId, 80);
  if (!leadId) return "leadId missing.";
  const status = str(e.status, 30).toLowerCase();
  const telephony = obj(e.telephony_data);
  const transcript = str(e.transcript, 20_000);
  const seconds = Math.max(0, Math.round(Number(e.conversation_duration ?? telephony.duration ?? 0) || 0));
  const callerSpoke = transcript.split("\n").some((line) => line.trim().toLowerCase().startsWith("user:"));
  const extracted = extractedFields(e.extracted_data);
  const claimed = str(extracted.outcome, 30) as Outcome;
  const conversation = seconds > 0 && callerSpoke;
  const outcome: Outcome = !conversation ? "no_conversation" : (OUTCOMES as readonly string[]).includes(claimed) ? claimed : "interested";
  const interestRaw = Number(extracted.interest);
  const cost = Number(e.total_cost);
  const usage = obj(e.usage_breakdown);
  const to = str(e.user_number || telephony.to_number, 20).replace(/\D/g, "");
  const summary = str(extracted.summary || e.summary || obj(obj(obj(e.extracted_data).General)["Call Summary"]).subjective, 1000);
  return {
    id,
    leadId,
    orgName: str(meta.orgName, 120),
    audience: meta.audience === "partner" ? "partner" : "school",
    toLast4: to.slice(-4),
    status,
    terminal: TERMINAL.has(status),
    outcome,
    interest: Number.isFinite(interestRaw) && interestRaw >= 1 && interestRaw <= 5 ? Math.round(interestRaw) : null,
    summary,
    extracted,
    transcript,
    seconds,
    // Bolna reports cost in US cents.
    costInr: Number.isFinite(cost) ? Math.round(cost * 0.85 * 100) / 100 : null,
    voice: str(usage.synthesizer_provider, 30),
    hangupReason: str(telephony.hangup_reason, 80),
    hasRecording: Boolean(str(telephony.recording_url, 500)),
    createdAt: str(e.created_at, 40) || new Date().toISOString(),
    updatedAt: str(e.updated_at, 40) || new Date().toISOString(),
  };
}

export type VoiceTotals = {
  calls: number;
  conversations: number;
  demosBooked: number;
  optedOut: number;
  minutes: number;
  costInr: number;
  byVoice: Record<string, { calls: number; conversations: number; demosBooked: number }>;
};

/** Month totals for the /calls page, and the n8n budget gate. */
export function voiceTotals(calls: VoiceCall[]): VoiceTotals {
  const t: VoiceTotals = { calls: 0, conversations: 0, demosBooked: 0, optedOut: 0, minutes: 0, costInr: 0, byVoice: {} };
  for (const c of calls) {
    t.calls += 1;
    const talked = c.outcome !== "no_conversation";
    if (talked) t.conversations += 1;
    if (c.outcome === "demo_booked") t.demosBooked += 1;
    if (c.outcome === "opted_out") t.optedOut += 1;
    t.minutes += Math.ceil(c.seconds / 60);
    t.costInr += c.costInr || 0;
    const v = (t.byVoice[c.voice || "unknown"] ||= { calls: 0, conversations: 0, demosBooked: 0 });
    v.calls += 1;
    if (talked) v.conversations += 1;
    if (c.outcome === "demo_booked") v.demosBooked += 1;
  }
  t.costInr = Math.round(t.costInr);
  return t;
}
