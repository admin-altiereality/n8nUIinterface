/**
 * Rep tools: call outcomes, speed-to-lead SLA breaches, the weekly leaderboard and the Monday digest.
 * Pure functions over sheet rows and audit-log entries so they can be tested without Firestore or n8n.
 */

export type Row = Record<string, unknown>;
export type AuditEntry = { action?: string; actorEmail?: string | null; targetId?: string | null; createdAt?: string; details?: Record<string, any> };

export const CALL_OUTCOMES = ["Interested", "Call back later", "Not interested", "No answer", "Wrong number"] as const;

const IST_MS = 5.5 * 3_600_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Mon–Sat, 10:00–19:00 India time: when a hot lead should hear from us. */
const OPEN_HOUR = 10;
const CLOSE_HOUR = 19;

const str = (row: Row, key: string) => String(row[key] ?? "").trim().replace(/^"|"$/g, "");
function time(row: Row, key: string): number | null {
  const t = Date.parse(str(row, key));
  return Number.isFinite(t) ? t : null;
}

/** Milliseconds of business time (Mon–Sat 10:00–19:00 IST) between two instants. */
export function businessMs(from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  // Walk IST days; at most ~60 iterations for a two-month gap.
  let dayStart = Math.floor((from + IST_MS) / DAY) * DAY - IST_MS;
  for (; dayStart < to; dayStart += DAY) {
    const weekday = new Date(dayStart + IST_MS).getUTCDay(); // 0 = Sunday
    if (weekday === 0) continue;
    const open = Math.max(from, dayStart + OPEN_HOUR * HOUR);
    const close = Math.min(to, dayStart + CLOSE_HOUR * HOUR);
    if (close > open) total += close - open;
  }
  return total;
}

export type SlaBreach = { leadId: string; school: string; owner: string; level: "owner" | "manager"; waitingMs: number; hotAt: string };

/**
 * Hot leads nobody has called or messaged yet. Past 1 business hour the owner is reminded; past 4 the manager is
 * told. Leads that are Do-not-contact, Lost or Won are left out.
 */
export function slaBreaches(rows: Row[], now = Date.now()): SlaBreach[] {
  const out: SlaBreach[] = [];
  for (const row of rows) {
    const hotAt = time(row, "Hot_at");
    if (hotAt === null || time(row, "First_touch_at") !== null) continue;
    if (str(row, "Do_not_contact") || ["Lost", "Won"].includes(str(row, "Stage"))) continue;
    if (/^zz test/i.test(str(row, "School Name"))) continue;
    const waitingMs = businessMs(hotAt, now);
    if (waitingMs < HOUR) continue;
    out.push({
      leadId: str(row, "Lead_id"),
      school: str(row, "School Name") || "Unknown school",
      owner: str(row, "Owner").toLowerCase(),
      level: waitingMs >= 4 * HOUR ? "manager" : "owner",
      waitingMs,
      hotAt: new Date(hotAt).toISOString(),
    });
  }
  return out.sort((a, b) => b.waitingMs - a.waitingMs);
}

export type RepStats = {
  rep: string;
  openDeals: number;
  touches: number;
  calls: number;
  notes: number;
  demos: number;
  won: number;
  wonInr: number;
  speedMedianMs: number | null;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const OPEN = new Set(["Engaged", "Demo booked", "Demo done", "Proposal"]);

/** Per rep, for activity between `from` and `to`. Reps are owners in the sheet plus anyone who acted on a lead. */
export function leaderboard(rows: Row[], audit: AuditEntry[], { from, to }: { from: number; to: number }): RepStats[] {
  const within = (t: number | null) => t !== null && t >= from && t < to;
  const reps = new Map<string, RepStats & { speeds: number[] }>();
  const get = (rep: string) => {
    const key = rep.toLowerCase();
    if (!reps.has(key)) reps.set(key, { rep: key, openDeals: 0, touches: 0, calls: 0, notes: 0, demos: 0, won: 0, wonInr: 0, speedMedianMs: null, speeds: [] });
    return reps.get(key)!;
  };

  for (const row of rows) {
    const owner = str(row, "Owner").toLowerCase();
    if (!owner) continue;
    const r = get(owner);
    if (OPEN.has(str(row, "Stage"))) r.openDeals += 1;
    if (within(time(row, "Demo_booked_at"))) r.demos += 1;
    if (str(row, "Stage") === "Won" && within(time(row, "Won_at"))) {
      r.won += 1;
      r.wonInr += Number(str(row, "Paid_amount")) || Number(str(row, "Deal_value")) || 0;
    }
    const hot = time(row, "Hot_at");
    const touch = time(row, "First_touch_at");
    if (within(hot) && touch !== null && touch >= hot!) r.speeds.push(touch - hot!);
  }

  for (const e of audit) {
    if (!e.actorEmail || typeof e.action !== "string" || !e.action.startsWith("lead.")) continue;
    if (!within(Date.parse(String(e.createdAt || "")))) continue;
    const r = get(e.actorEmail);
    if (e.action === "lead.call") {
      r.calls += 1;
      r.touches += 1;
    } else if (e.action === "lead.note") {
      // The quick Call button logs a "Called" note.
      if (String(e.details?.text || "").trim() === "Called") r.calls += 1;
      else r.notes += 1;
      r.touches += 1;
    } else if (e.action === "lead.update") {
      r.touches += 1;
    }
  }

  return [...reps.values()]
    .map(({ speeds, ...r }) => ({ ...r, speedMedianMs: median(speeds) }))
    .filter((r) => r.touches || r.openDeals || r.demos || r.won)
    .sort((a, b) => b.wonInr - a.wonInr || b.demos - a.demos || b.touches - a.touches);
}

const SOURCE_LABEL: Record<string, string> = {
  instagram_ad: "Instagram ads",
  facebook_ad: "Facebook ads",
  website: "Website",
  whatsapp: "WhatsApp",
  cold_email: "Cold email",
};

function sourceOf(row: Row): string {
  const stored = str(row, "Lead_source").toLowerCase();
  if (SOURCE_LABEL[stored]) return stored;
  const kw = str(row, "XR_keywords").toLowerCase();
  if (kw.includes("instagram_lead_ad")) return "instagram_ad";
  if (kw.includes("facebook_lead_ad")) return "facebook_ad";
  if (str(row, "Status").toLowerCase() === "website_lead" || str(row, "XR_status") === "Inbound Website Lead") return "website";
  return "cold_email";
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
/** 45 min, 3.5 h, or 12 business days (9-hour days) for long waits. */
const hours = (ms: number) =>
  ms < HOUR ? `${Math.round(ms / 60_000)} min` : ms < 18 * HOUR ? `${(ms / HOUR).toFixed(1)} business hours` : `${Math.round(ms / (9 * HOUR))} business days`;
const name = (email: string) => (email ? email.split("@")[0] : "unclaimed");

/** The Monday email: last 7 days by source, deals that need attention, speed-to-lead and the leaderboard. */
export function weeklyDigest(rows: Row[], audit: AuditEntry[], now = Date.now()): { title: string; text: string } {
  const live = rows.filter((r) => !/^zz test/i.test(str(r, "School Name")));
  const from = now - 7 * DAY;
  const within = (t: number | null) => t !== null && t >= from && t < now;

  const bySource = new Map<string, { leads: number; hot: number; demos: number; won: number; wonInr: number }>();
  for (const row of live) {
    const s = sourceOf(row);
    const b = bySource.get(s) || { leads: 0, hot: 0, demos: 0, won: 0, wonInr: 0 };
    if (within(time(row, "Time") ?? time(row, "Email_sent_at"))) b.leads += 1;
    if (within(time(row, "Hot_at"))) b.hot += 1;
    if (within(time(row, "Demo_booked_at"))) b.demos += 1;
    if (str(row, "Stage") === "Won" && within(time(row, "Won_at"))) {
      b.won += 1;
      b.wonInr += Number(str(row, "Paid_amount")) || Number(str(row, "Deal_value")) || 0;
    }
    bySource.set(s, b);
  }
  const totals = [...bySource.values()].reduce(
    (t, b) => ({ leads: t.leads + b.leads, hot: t.hot + b.hot, demos: t.demos + b.demos, won: t.won + b.won, wonInr: t.wonInr + b.wonInr }),
    { leads: 0, hot: 0, demos: 0, won: 0, wonInr: 0 }
  );

  const stuck = live
    .filter((r) => OPEN.has(str(r, "Stage")) && (time(r, "Next_step_due") ?? Infinity) < now)
    .sort((a, b) => (time(a, "Next_step_due") ?? 0) - (time(b, "Next_step_due") ?? 0))
    .slice(0, 5);
  const breaches = slaBreaches(live, now);
  const board = leaderboard(live, audit, { from, to: now }).slice(0, 5);

  const lines: string[] = [];
  lines.push(`Last 7 days: ${totals.leads} new leads, ${totals.hot} turned hot, ${totals.demos} demos booked, ${totals.won} won (${inr(totals.wonInr)}).`, "");
  lines.push("By source:");
  for (const [s, b] of [...bySource.entries()].sort((x, y) => y[1].leads - x[1].leads)) {
    if (!b.leads && !b.hot && !b.demos && !b.won) continue;
    lines.push(`- ${SOURCE_LABEL[s]}: ${b.leads} leads, ${b.hot} hot, ${b.demos} demos, ${b.won} won`);
  }
  lines.push("", `Deals with an overdue next step (${stuck.length}${stuck.length === 5 ? "+" : ""}):`);
  if (!stuck.length) lines.push("- none");
  for (const r of stuck) lines.push(`- ${str(r, "School Name")} (${str(r, "Stage")}, ${name(str(r, "Owner"))}): ${str(r, "Next_step") || "no next step"}`);
  lines.push("", `Hot leads still waiting for a first call or message: ${breaches.length}`);
  for (const b of breaches.slice(0, 5)) lines.push(`- ${b.school} — waiting ${hours(b.waitingMs)} (${name(b.owner)})`);
  lines.push("", "Team this week:");
  if (!board.length) lines.push("- no logged activity");
  for (const r of board) {
    lines.push(`- ${name(r.rep)}: ${r.calls} calls, ${r.touches} touches, ${r.demos} demos, ${r.won} won${r.speedMedianMs !== null ? `, speed-to-lead ${hours(r.speedMedianMs)}` : ""}`);
  }
  lines.push("", "Open the dashboard: https://agents.altiereality.com/sales");
  return { title: `Weekly sales digest — ${totals.leads} leads, ${totals.demos} demos, ${inr(totals.wonInr)} won`, text: lines.join("\n") };
}

/** The alert email for this round of SLA breaches. */
export function slaAlert(breaches: SlaBreach[]): { title: string; text: string } {
  const managers = breaches.filter((b) => b.level === "manager");
  const lines = breaches.map(
    (b) =>
      `- ${b.school}: waiting ${hours(b.waitingMs)}, ${b.owner ? `owner ${name(b.owner)}` : "unclaimed"}${b.level === "manager" ? " — OVER 4 HOURS" : ""}\n  https://agents.altiereality.com/sales?lead=${encodeURIComponent(b.leadId)}`
  );
  return {
    title: `${breaches.length} hot lead(s) not contacted yet${managers.length ? ` (${managers.length} over 4 h)` : ""}`,
    text: ["These schools showed interest and nobody has called or messaged them yet:", "", ...lines].join("\n"),
  };
}
