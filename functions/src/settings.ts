/**
 * App settings that used to be constants in code and n8n Code nodes. Stored in Firestore `settings/app`;
 * superadmins edit them on the Admin page, n8n reads them through a keyed endpoint.
 */

export const SETTINGS_DOC = "settings/app";

/** Sources a lead can come from; also the keys of the per-channel monthly spend. */
export const LEAD_SOURCES = ["cold_email", "website", "instagram_ad", "facebook_ad", "whatsapp", "other"] as const;
export type LeadSourceKey = (typeof LEAD_SOURCES)[number];

export type Mode = "test" | "live";

/** AI calling: off, test (only voiceTestNumbers), live (opted-in leads). */
export type VoiceMode = "off" | "test" | "live";

export type AppSettings = {
  /** ₹ won per month we aim for; 0 hides the target. */
  monthlyTargetInr: number;
  /** ₹ spent per month on each channel that Meta doesn't report (tools, email, data). */
  channelSpendInr: Record<LeadSourceKey, number>;
  /** Cold emails per IST day, first emails and follow-ups together. */
  dailyEmailCap: number;
  /** How many of the daily cap follow-ups may use. */
  followUpMax: number;
  /** Sales • Inbound automatic WhatsApp replies. */
  autoActionsMode: Mode;
  /** WhatsApp welcome to new website/Meta form leads. */
  welcomeMode: Mode;
  /** Highest daily budget the Social page may set on one Meta ad set. */
  metaMaxDailyBudgetInr: number;
  /** Who gets hot-lead and failure alerts. */
  alertRecipients: string[];
  /** Canned replies reps can insert in Messaging and the lead drawer. */
  replyTemplates: Array<{ title: string; body: string }>;
  /** AI calling agent (Sales • Voice Agent in n8n). */
  voiceMode: VoiceMode;
  /** AI calls placed per IST day, retries included. */
  voiceDailyCallCap: number;
  /** Call minutes per calendar month; calls stop when it's used up. */
  voiceMonthlyMinuteBudget: number;
  /** IST hours calls may start, Monday to Saturday; TRAI allows 9 to 21 at most. */
  voiceHours: { start: number; end: number };
  /** In test mode, the only numbers the agent may call (E.164). */
  voiceTestNumbers: string[];
  /** Bolna agent ids for each audience. */
  voiceAgents: { school: string; partner: string };
};

export const DEFAULT_SETTINGS: AppSettings = {
  monthlyTargetInr: 0,
  channelSpendInr: { cold_email: 0, website: 0, instagram_ad: 0, facebook_ad: 0, whatsapp: 0, other: 0 },
  dailyEmailCap: 20,
  followUpMax: 12,
  autoActionsMode: "test",
  welcomeMode: "test",
  metaMaxDailyBudgetInr: 2000,
  alertRecipients: ["gaurav@altiereality.com"],
  replyTemplates: [],
  voiceMode: "off",
  voiceDailyCallCap: 30,
  voiceMonthlyMinuteBudget: 2000,
  voiceHours: { start: 10, end: 18 },
  voiceTestNumbers: [],
  voiceAgents: { school: "", partner: "" },
};

/** Hard ceilings so a typo can't, say, send 2,000 cold emails in a day. */
const LIMITS = {
  dailyEmailCap: 100,
  monthlyTargetInr: 100_000_000,
  spend: 10_000_000,
  metaMaxDailyBudgetInr: 50_000,
  voiceDailyCallCap: 200,
  voiceMonthlyMinuteBudget: 20_000,
};

const E164 = /^\+[1-9]\d{7,14}$/;
const AGENT_ID = /^[0-9a-f-]{36}$/i;

/** Valid E.164 numbers, deduplicated, at most 10; null if any entry is invalid. */
function cleanNumbers(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.map((n) => String(n).replace(/[\s-]/g, "")).filter(Boolean);
  if (list.some((n) => !E164.test(n))) return null;
  return [...new Set(list)].slice(0, 10);
}

/** Calling window inside TRAI's 9:00–21:00, at least an hour long; null if invalid. */
function cleanHours(value: unknown): { start: number; end: number } | null {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const start = Number(v.start);
  const end = Number(v.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 9 || end > 21 || end - start < 1) return null;
  return { start, end };
}

/** Bolna agent ids (UUIDs) or empty; null if one is malformed. */
function cleanAgents(value: unknown): { school: string; partner: string } | null {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const school = String(v.school ?? "").trim();
  const partner = String(v.partner ?? "").trim();
  if ((school && !AGENT_ID.test(school)) || (partner && !AGENT_ID.test(partner))) return null;
  return { school, partner };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Up to 20 templates; titles up to 60 characters, bodies up to 1,000. Null when the input isn't valid. */
function cleanTemplates(value: unknown): Array<{ title: string; body: string }> | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const out: Array<{ title: string; body: string }> = [];
  for (const t of value) {
    const title = String((t as any)?.title ?? "").trim();
    const body = String((t as any)?.body ?? "").trim();
    if (!title || !body || title.length > 60 || body.length > 1000) return null;
    out.push({ title, body });
  }
  return out;
}

function wholeNumber(value: unknown, max: number): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null;
}

/** Fills any missing or invalid stored values with defaults, so readers always get a complete object. */
export function withDefaults(stored: unknown): AppSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, any>;
  const spend = { ...DEFAULT_SETTINGS.channelSpendInr };
  for (const key of LEAD_SOURCES) {
    const v = wholeNumber(s.channelSpendInr?.[key], LIMITS.spend);
    if (v !== null) spend[key] = v;
  }
  const cap = wholeNumber(s.dailyEmailCap, LIMITS.dailyEmailCap) ?? DEFAULT_SETTINGS.dailyEmailCap;
  const fu = wholeNumber(s.followUpMax, LIMITS.dailyEmailCap) ?? DEFAULT_SETTINGS.followUpMax;
  return {
    monthlyTargetInr: wholeNumber(s.monthlyTargetInr, LIMITS.monthlyTargetInr) ?? DEFAULT_SETTINGS.monthlyTargetInr,
    channelSpendInr: spend,
    dailyEmailCap: cap,
    followUpMax: Math.min(fu, cap),
    autoActionsMode: s.autoActionsMode === "live" ? "live" : "test",
    welcomeMode: s.welcomeMode === "live" ? "live" : "test",
    metaMaxDailyBudgetInr:
      wholeNumber(s.metaMaxDailyBudgetInr, LIMITS.metaMaxDailyBudgetInr) ?? DEFAULT_SETTINGS.metaMaxDailyBudgetInr,
    alertRecipients:
      Array.isArray(s.alertRecipients) && s.alertRecipients.some((e: unknown) => EMAIL.test(String(e)))
        ? s.alertRecipients.map((e: unknown) => String(e).trim().toLowerCase()).filter((e: string) => EMAIL.test(e))
        : DEFAULT_SETTINGS.alertRecipients,
    replyTemplates: cleanTemplates(s.replyTemplates) ?? DEFAULT_SETTINGS.replyTemplates,
    voiceMode: s.voiceMode === "test" || s.voiceMode === "live" ? s.voiceMode : "off",
    voiceDailyCallCap: wholeNumber(s.voiceDailyCallCap, LIMITS.voiceDailyCallCap) ?? DEFAULT_SETTINGS.voiceDailyCallCap,
    voiceMonthlyMinuteBudget:
      wholeNumber(s.voiceMonthlyMinuteBudget, LIMITS.voiceMonthlyMinuteBudget) ?? DEFAULT_SETTINGS.voiceMonthlyMinuteBudget,
    voiceHours: cleanHours(s.voiceHours) ?? DEFAULT_SETTINGS.voiceHours,
    voiceTestNumbers: cleanNumbers(s.voiceTestNumbers) ?? DEFAULT_SETTINGS.voiceTestNumbers,
    voiceAgents: cleanAgents(s.voiceAgents) ?? DEFAULT_SETTINGS.voiceAgents,
  };
}

/**
 * Validates a partial update from the Admin page. Returns the merged settings, or an error message naming the
 * first bad field. Unknown fields are rejected so typos don't silently do nothing.
 */
export function applySettingsPatch(current: AppSettings, patch: unknown): AppSettings | string {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return "Send an object of settings to change.";
  const next: AppSettings = { ...current, channelSpendInr: { ...current.channelSpendInr } };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    switch (key) {
      case "monthlyTargetInr": {
        const v = wholeNumber(value, LIMITS.monthlyTargetInr);
        if (v === null) return "Monthly target must be a number of rupees.";
        next.monthlyTargetInr = v;
        break;
      }
      case "channelSpendInr": {
        if (!value || typeof value !== "object") return "Channel spend must be an object.";
        for (const [channel, amount] of Object.entries(value as Record<string, unknown>)) {
          if (!(LEAD_SOURCES as readonly string[]).includes(channel)) return `Unknown channel "${channel}".`;
          const v = wholeNumber(amount, LIMITS.spend);
          if (v === null) return `Spend for ${channel} must be a number of rupees.`;
          next.channelSpendInr[channel as LeadSourceKey] = v;
        }
        break;
      }
      case "dailyEmailCap": {
        const v = wholeNumber(value, LIMITS.dailyEmailCap);
        if (v === null) return `Daily email cap must be between 0 and ${LIMITS.dailyEmailCap}.`;
        next.dailyEmailCap = v;
        break;
      }
      case "followUpMax": {
        const v = wholeNumber(value, LIMITS.dailyEmailCap);
        if (v === null) return "Follow-up share must be a whole number.";
        next.followUpMax = v;
        break;
      }
      case "autoActionsMode":
      case "welcomeMode":
        if (value !== "test" && value !== "live") return `${key} must be "test" or "live".`;
        next[key] = value;
        break;
      case "metaMaxDailyBudgetInr": {
        const v = wholeNumber(value, LIMITS.metaMaxDailyBudgetInr);
        if (v === null) return `Meta budget ceiling must be between 0 and ${LIMITS.metaMaxDailyBudgetInr}.`;
        next.metaMaxDailyBudgetInr = v;
        break;
      }
      case "alertRecipients": {
        const list = Array.isArray(value) ? value.map((e) => String(e).trim().toLowerCase()).filter(Boolean) : null;
        if (!list || !list.length || list.some((e) => !EMAIL.test(e))) return "Alert recipients must be email addresses.";
        next.alertRecipients = [...new Set(list)].slice(0, 10);
        break;
      }
      case "replyTemplates": {
        const list = cleanTemplates(value);
        if (!list) return "Templates need a title (60 characters max) and text (1,000 max); 20 templates at most.";
        next.replyTemplates = list;
        break;
      }
      case "voiceMode":
        if (value !== "off" && value !== "test" && value !== "live") return 'voiceMode must be "off", "test" or "live".';
        next.voiceMode = value;
        break;
      case "voiceDailyCallCap": {
        const v = wholeNumber(value, LIMITS.voiceDailyCallCap);
        if (v === null) return `Daily AI call cap must be between 0 and ${LIMITS.voiceDailyCallCap}.`;
        next.voiceDailyCallCap = v;
        break;
      }
      case "voiceMonthlyMinuteBudget": {
        const v = wholeNumber(value, LIMITS.voiceMonthlyMinuteBudget);
        if (v === null) return `Monthly call minutes must be between 0 and ${LIMITS.voiceMonthlyMinuteBudget}.`;
        next.voiceMonthlyMinuteBudget = v;
        break;
      }
      case "voiceHours": {
        const v = cleanHours(value);
        if (!v) return "Calling hours must be whole hours between 9 and 21, at least an hour apart.";
        next.voiceHours = v;
        break;
      }
      case "voiceTestNumbers": {
        const v = cleanNumbers(value);
        if (!v) return "Test numbers must be in +91XXXXXXXXXX form.";
        next.voiceTestNumbers = v;
        break;
      }
      case "voiceAgents": {
        const v = cleanAgents(value);
        if (!v) return "Agent ids must be Bolna agent UUIDs.";
        next.voiceAgents = v;
        break;
      }
      default:
        return `Unknown setting "${key}".`;
    }
  }
  if (next.followUpMax > next.dailyEmailCap) return "Follow-up share can't be more than the daily email cap.";
  if (next.voiceMode === "test" && !next.voiceTestNumbers.length) return "Add at least one test number before switching AI calls to test.";
  return next;
}

/** Which top-level settings changed, for the audit log. */
export function changedKeys(before: AppSettings, after: AppSettings): string[] {
  return (Object.keys(after) as Array<keyof AppSettings>).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])
  );
}

export type WorkflowRun = { id: string; status: string; mode?: string; startedAt: string; stoppedAt?: string };

/** One workflow's health from its recent executions (newest first). Manual test runs from the editor don't count. */
export function summarizeRuns(allRuns: WorkflowRun[], now = Date.now()) {
  const runs = allRuns.filter((r) => r.mode !== "manual");
  const dayAgo = now - 86_400_000;
  const recent = runs.filter((r) => Date.parse(r.startedAt) >= dayAgo);
  const last = runs[0];
  const lastError = runs.find((r) => r.status === "error" || r.status === "crashed");
  return {
    lastRunAt: last?.startedAt || null,
    lastStatus: last?.status || null,
    runs24h: recent.length,
    errors24h: recent.filter((r) => r.status === "error" || r.status === "crashed").length,
    lastErrorAt: lastError?.startedAt || null,
    lastErrorId: lastError?.id || null,
  };
}
