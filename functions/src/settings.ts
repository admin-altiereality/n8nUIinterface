/**
 * App settings that used to be constants in code and n8n Code nodes. Stored in Firestore `settings/app`;
 * superadmins edit them on the Admin page, n8n reads them through a keyed endpoint.
 */

export const SETTINGS_DOC = "settings/app";

/** Sources a lead can come from; also the keys of the per-channel monthly spend. */
export const LEAD_SOURCES = ["cold_email", "website", "instagram_ad", "facebook_ad", "whatsapp", "other"] as const;
export type LeadSourceKey = (typeof LEAD_SOURCES)[number];

export type Mode = "test" | "live";

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
};

/** Hard ceilings so a typo can't, say, send 2,000 cold emails in a day. */
const LIMITS = { dailyEmailCap: 100, monthlyTargetInr: 100_000_000, spend: 10_000_000, metaMaxDailyBudgetInr: 50_000 };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      default:
        return `Unknown setting "${key}".`;
    }
  }
  if (next.followUpMax > next.dailyEmailCap) return "Follow-up share can't be more than the daily email cap.";
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
