/**
 * Small per-run summaries the sales workflows post (X-Altie-Key) after each city run and follow-up run.
 * The Usage & cost and Activity pages read them; n8n's own execution data is several MB a run.
 */
export type RunKind = "city_run" | "follow_ups";

export interface RunLogEntry {
  kind: RunKind;
  executionId: string;
  at: string;
  city: string;
  /** k12 | coaching | college | partner for city runs, "" for follow-up runs. */
  segment: string;
  preset: string;
  mode: string;
  found: number;
  unique: number;
  added: number;
  emailed: number;
  emailFailed: number;
  followUps: number;
  followUpsFailed: number;
  reengaged: number;
  reoonChecked: number;
  reoonVerified: number;
  reoonCatchAll: number;
  /** 7-day bounce rate in percent, when the run measured it. */
  bounceRate: number | null;
  /** Places dropped before or after reading, by reason. */
  skipped: Record<string, number>;
  error: string;
}

const SEGMENTS = new Set(["k12", "coaching", "college", "partner"]);
const REOON_KEYS = ["reoon_checked", "reoon_verified", "reoon_catch_all", "reoon_failed"];

const num = (value: unknown, max = 100_000): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : 0;
};

// eslint-disable-next-line no-control-regex
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");

/** Validates a posted summary; returns the entry to store or an error message. */
export function parseRunLog(body: unknown, now = Date.now()): RunLogEntry | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body must be an object.";
  const b = body as Record<string, unknown>;
  const kind: RunKind | null = b.kind === "city_run" || b.kind === "follow_ups" ? b.kind : null;
  if (!kind) return "kind must be city_run or follow_ups.";
  const executionId = text(String(b.executionId ?? ""), 20);
  if (!/^\d{1,20}$/.test(executionId)) return "executionId must be an n8n execution id.";

  let rawSkipped: Record<string, unknown> = {};
  if (typeof b.skipped === "string") {
    try {
      rawSkipped = JSON.parse(b.skipped) as Record<string, unknown>;
    } catch {
      rawSkipped = {};
    }
  } else if (b.skipped && typeof b.skipped === "object") {
    rawSkipped = b.skipped as Record<string, unknown>;
  }
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawSkipped || {}).slice(0, 40)) {
    if (/^[a-z_]{1,30}$/.test(key)) counts[key] = num(value);
  }
  const skipped: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts)) if (!REOON_KEYS.includes(key)) skipped[key] = value;

  const rate = b.bounceRate === null || b.bounceRate === undefined || b.bounceRate === "" ? NaN : Number(b.bounceRate);
  const segment = String(b.segment ?? "");
  return {
    kind,
    executionId,
    at: new Date(now).toISOString(),
    city: text(b.city, 60),
    segment: kind === "follow_ups" ? "" : SEGMENTS.has(segment) ? segment : "k12",
    preset: text(b.preset, 20),
    mode: text(b.mode, 10),
    found: num(b.found),
    unique: num(b.unique),
    added: num(b.added),
    emailed: num(b.emailed),
    emailFailed: num(b.emailFailed),
    followUps: num(b.followUps),
    followUpsFailed: num(b.followUpsFailed),
    reengaged: num(b.reengaged),
    reoonChecked: counts.reoon_checked ?? 0,
    reoonVerified: counts.reoon_verified ?? 0,
    reoonCatchAll: counts.reoon_catch_all ?? 0,
    bounceRate: Number.isFinite(rate) && rate >= 0 && rate <= 100 ? Math.round(rate * 10) / 10 : null,
    skipped,
    error: text(b.error, 200),
  };
}
