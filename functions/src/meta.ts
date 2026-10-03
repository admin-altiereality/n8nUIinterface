/**
 * Meta (Facebook/Instagram) ads for the Social Ads page, plus the lead-ads webhook.
 * The dashboard never talks to Meta directly: every call goes through here with the system-user token.
 */
import { createHmac, timingSafeEqual } from "crypto";

export const META_GRAPH_VERSION = "v26.0";
/** "Gaurav Purbia" (INR): the account that runs the LearnXR Instagram ads and promotes the Altie Reality Page. */
export const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || "784451571902986";
/** The Altie Reality Facebook Page; its Instagram account is looked up from it. */
export const META_PAGE_ID = process.env.META_PAGE_ID || "112468273892432";
/** Highest daily budget the dashboard may set on one ad set, in rupees. */
export const META_MAX_DAILY_BUDGET_INR = Number(process.env.META_MAX_DAILY_BUDGET_INR || 2000);
/** Where "visits" boosts send people. */
export const META_BOOST_LINK = process.env.META_BOOST_LINK || "https://learnxr.altiereality.com";

export const META_RANGES = new Set(["today", "yesterday", "last_7d", "last_28d", "last_90d", "this_month", "last_month"]);

/** Action types Meta reports for a lead (form, on-site and pixel). */
const LEAD_ACTIONS = new Set(["lead", "onsite_conversion.lead_grouped", "leadgen_grouped", "offsite_conversion.fb_pixel_lead"]);

export class MetaApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number) {
    super(message);
  }
}

export type MetaCreds = { token: string; appSecret: string };

/** Checks Meta's `X-Hub-Signature-256: sha256=<hex>` header against the raw request body. */
export function verifyMetaSignature(rawBody: Buffer | string | undefined, header: unknown, appSecret: string): boolean {
  if (!rawBody || typeof header !== "string" || !header.startsWith("sha256=") || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function graph(
  creds: MetaCreds,
  path: string,
  init: { method?: "GET" | "POST"; params?: Record<string, unknown> } = {}
): Promise<any> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(init.params || {})) {
    if (value === undefined) continue;
    params.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  params.set("access_token", creds.token);
  // appsecret_proof stops a leaked token from being used without the app secret.
  params.set("appsecret_proof", createHmac("sha256", creds.appSecret).update(creds.token).digest("hex"));
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${path.replace(/^\//, "")}`;
  const method = init.method || "GET";
  const res = await fetch(method === "GET" ? `${url}?${params}` : url, {
    method,
    headers: method === "GET" ? undefined : { "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : params.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const err = data?.error || {};
    throw new MetaApiError(err.error_user_msg || err.message || `Meta API returned ${res.status}`, res.status, err.code);
  }
  return data;
}

type RawInsights = { spend?: string; reach?: string; impressions?: string; clicks?: string; actions?: Array<{ action_type: string; value: string }> };

export function summarizeInsights(row: RawInsights | undefined) {
  const num = (v?: string) => Number(v) || 0;
  const leads = (row?.actions || []).filter((a) => LEAD_ACTIONS.has(a.action_type)).reduce((max, a) => Math.max(max, num(a.value)), 0);
  const spend = num(row?.spend);
  return {
    spend,
    reach: num(row?.reach),
    impressions: num(row?.impressions),
    clicks: num(row?.clicks),
    leads,
    costPerLead: leads ? Math.round((spend / leads) * 100) / 100 : null,
  };
}

const INSIGHT_FIELDS = "spend,reach,impressions,clicks,actions";

export async function getOverview(creds: MetaCreds, range: string) {
  const data = await graph(creds, `act_${META_AD_ACCOUNT_ID}/insights`, { params: { fields: INSIGHT_FIELDS, date_preset: range } });
  return summarizeInsights(data?.data?.[0]);
}

/** Meta budgets are in the account currency's minor unit (paise for INR). */
const toRupees = (minor?: string) => (minor ? Number(minor) / 100 : null);

export async function listCampaigns(creds: MetaCreds, range: string) {
  const data = await graph(creds, `act_${META_AD_ACCOUNT_ID}/campaigns`, {
    params: {
      fields: [
        "id", "name", "objective", "status", "effective_status", "daily_budget", "lifetime_budget", "created_time",
        `insights.date_preset(${range}){${INSIGHT_FIELDS}}`,
        "adsets.limit(25){id,name,status,effective_status,daily_budget}",
      ].join(","),
      limit: 50,
    },
  });
  return (data?.data || []).map((c: any) => ({
    id: c.id,
    name: c.name,
    objective: c.objective,
    status: c.status,
    effectiveStatus: c.effective_status,
    dailyBudget: toRupees(c.daily_budget),
    lifetimeBudget: toRupees(c.lifetime_budget),
    createdAt: c.created_time,
    insights: summarizeInsights(c.insights?.data?.[0]),
    adsets: (c.adsets?.data || []).map((s: any) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      effectiveStatus: s.effective_status,
      dailyBudget: toRupees(s.daily_budget),
    })),
  }));
}

export async function getInstagramAccountId(creds: MetaCreds): Promise<string> {
  if (!META_PAGE_ID) throw new MetaApiError("META_PAGE_ID is not set on the function.", 503);
  const page = await graph(creds, META_PAGE_ID, { params: { fields: "instagram_business_account" } });
  const id = page?.instagram_business_account?.id;
  if (!id) throw new MetaApiError("No Instagram professional account is linked to the Facebook Page.", 503);
  return id;
}

export async function listInstagramMedia(creds: MetaCreds) {
  const igId = await getInstagramAccountId(creds);
  const data = await graph(creds, `${igId}/media`, {
    params: { fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count", limit: 24 },
  });
  return (data?.data || []).map((m: any) => ({
    id: m.id,
    caption: String(m.caption || "").slice(0, 300),
    mediaType: m.media_type,
    imageUrl: m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url,
    permalink: m.permalink,
    timestamp: m.timestamp,
    likes: m.like_count ?? 0,
    comments: m.comments_count ?? 0,
  }));
}

/** Makes sure an id the browser sent is a campaign, ad set or ad in our ad account before changing it. */
export async function assertOwnEntity(creds: MetaCreds, id: string): Promise<void> {
  if (!/^\d{5,25}$/.test(id)) throw new MetaApiError("Invalid id.", 400);
  const data = await graph(creds, id, { params: { fields: "account_id" } }).catch(() => null);
  if (String(data?.account_id || "") !== META_AD_ACCOUNT_ID) throw new MetaApiError("Not an object in the LearnXR ad account.", 404);
}

export type EntityChange = { status?: "ACTIVE" | "PAUSED"; dailyBudget?: number };

export function parseEntityChange(body: any): EntityChange | string {
  const change: EntityChange = {};
  if (body?.status !== undefined) {
    if (body.status !== "ACTIVE" && body.status !== "PAUSED") return "status must be ACTIVE or PAUSED.";
    change.status = body.status;
  }
  if (body?.dailyBudget !== undefined) {
    const budget = Number(body.dailyBudget);
    if (!Number.isFinite(budget) || budget <= 0) return "dailyBudget must be a positive number of rupees.";
    if (budget > META_MAX_DAILY_BUDGET_INR) return `dailyBudget is above the ₹${META_MAX_DAILY_BUDGET_INR}/day limit.`;
    change.dailyBudget = Math.round(budget);
  }
  if (change.status === undefined && change.dailyBudget === undefined) return "Nothing to change.";
  return change;
}

export async function updateEntity(creds: MetaCreds, id: string, change: EntityChange) {
  await assertOwnEntity(creds, id);
  const params: Record<string, unknown> = {};
  if (change.status) params.status = change.status;
  if (change.dailyBudget !== undefined) params.daily_budget = String(change.dailyBudget * 100);
  await graph(creds, id, { method: "POST", params });
  return { id, ...change };
}

export type BoostRequest = {
  igMediaId: string;
  goal: "visits" | "engagement";
  dailyBudget: number;
  days: number;
  cities: string[];
  ageMin: number;
};

export function parseBoostRequest(body: any): BoostRequest | string {
  const igMediaId = String(body?.igMediaId || "");
  if (!/^\d{5,25}$/.test(igMediaId)) return "Pick an Instagram post.";
  const goal = body?.goal === "engagement" ? "engagement" : "visits";
  const dailyBudget = Math.round(Number(body?.dailyBudget));
  if (!Number.isFinite(dailyBudget) || dailyBudget < 100) return "Daily budget must be at least ₹100.";
  if (dailyBudget > META_MAX_DAILY_BUDGET_INR) return `Daily budget is above the ₹${META_MAX_DAILY_BUDGET_INR}/day limit.`;
  const days = Math.round(Number(body?.days));
  if (!Number.isFinite(days) || days < 1 || days > 30) return "Run for 1 to 30 days.";
  const cities = (Array.isArray(body?.cities) ? body.cities : []).map((c: unknown) => String(c).trim()).filter(Boolean).slice(0, 10);
  const ageMin = Math.min(Math.max(Math.round(Number(body?.ageMin) || 25), 18), 65);
  return { igMediaId, goal, dailyBudget, days, cities, ageMin };
}

async function cityKeys(creds: MetaCreds, cities: string[]) {
  const keys: Array<{ key: string; name: string }> = [];
  for (const city of cities) {
    const data = await graph(creds, "search", { params: { type: "adgeolocation", location_types: ["city"], q: city, country_code: "IN", limit: 1 } });
    const hit = data?.data?.[0];
    if (!hit?.key) throw new MetaApiError(`Meta doesn't know the city "${city}".`, 400);
    keys.push({ key: hit.key, name: hit.name });
  }
  return keys;
}

/**
 * Boosts an Instagram post as a new campaign → ad set → ad. The campaign is created PAUSED, so nothing
 * spends until someone presses Activate on the Social Ads page.
 */
export async function boostInstagramPost(creds: MetaCreds, req: BoostRequest, createdBy: string) {
  const igId = await getInstagramAccountId(creds);
  const cities = await cityKeys(creds, req.cities);
  const visits = req.goal === "visits";
  const label = `IG boost ${new Date().toISOString().slice(0, 10)} · ${visits ? "visits" : "engagement"}${cities.length ? ` · ${cities.map((c) => c.name).join(", ")}` : ""}`;

  const campaign = await graph(creds, `act_${META_AD_ACCOUNT_ID}/campaigns`, {
    method: "POST",
    params: {
      name: label,
      objective: visits ? "OUTCOME_TRAFFIC" : "OUTCOME_ENGAGEMENT",
      status: "PAUSED",
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    },
  });
  const start = new Date(Date.now() + 10 * 60_000);
  const end = new Date(start.getTime() + req.days * 86_400_000);
  const adset = await graph(creds, `act_${META_AD_ACCOUNT_ID}/adsets`, {
    method: "POST",
    params: {
      name: label,
      campaign_id: campaign.id,
      status: "ACTIVE",
      daily_budget: String(req.dailyBudget * 100),
      billing_event: "IMPRESSIONS",
      optimization_goal: visits ? "LINK_CLICKS" : "POST_ENGAGEMENT",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      ...(visits ? { destination_type: "WEBSITE" } : {}),
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      targeting: {
        geo_locations: cities.length ? { cities: cities.map((c) => ({ key: c.key })) } : { countries: ["IN"] },
        age_min: req.ageMin,
        publisher_platforms: ["instagram"],
        instagram_positions: ["stream", "story", "explore"],
      },
    },
  });
  const creative = await graph(creds, `act_${META_AD_ACCOUNT_ID}/adcreatives`, {
    method: "POST",
    params: {
      name: label,
      instagram_user_id: igId,
      source_instagram_media_id: req.igMediaId,
      ...(visits ? { call_to_action: { type: "LEARN_MORE", value: { link: META_BOOST_LINK } } } : {}),
    },
  });
  const ad = await graph(creds, `act_${META_AD_ACCOUNT_ID}/ads`, {
    method: "POST",
    params: { name: label, adset_id: adset.id, creative: { creative_id: creative.id }, status: "ACTIVE" },
  });
  const preview = await graph(creds, `${ad.id}/previews`, { params: { ad_format: "INSTAGRAM_STANDARD" } }).catch(() => null);
  return {
    campaignId: campaign.id,
    adsetId: adset.id,
    adId: ad.id,
    name: label,
    createdBy,
    previewHtml: String(preview?.data?.[0]?.body || ""),
  };
}

/** Turns a Meta lead into the website form's body shape, so n8n handles both the same way. */
export function leadToSalesEvent(lead: any) {
  const fields: Record<string, string> = {};
  for (const f of lead?.field_data || []) {
    fields[String(f.name || "").toLowerCase()] = String((f.values || [])[0] || "").trim();
  }
  const pick = (...keys: string[]) => keys.map((k) => fields[k]).find(Boolean) || "";
  const platform = String(lead?.platform || "").toLowerCase() === "ig" ? "instagram" : "facebook";
  return {
    type: "meta_lead",
    leadgenId: String(lead?.id || ""),
    name: pick("full_name", "name", "first_name"),
    organization: pick("school_name", "school", "company_name", "organization", "organisation"),
    email: pick("email", "work_email"),
    phone: pick("phone_number", "phone", "mobile"),
    city: pick("city"),
    role: pick("job_title", "role", "designation"),
    source: `${platform}_lead_ad`,
    interest: String(lead?.campaign_name || lead?.ad_name || ""),
    message: [pick("city") ? `city: ${pick("city")}` : "", lead?.form_id ? `form: ${lead.form_id}` : ""].filter(Boolean).join(" | "),
    utmSource: platform,
    utmCampaign: String(lead?.campaign_name || ""),
    submittedAt: lead?.created_time ? new Date(lead.created_time).toISOString() : new Date().toISOString(),
  };
}

export async function fetchLead(creds: MetaCreds, leadgenId: string) {
  return graph(creds, leadgenId, { params: { fields: "id,created_time,field_data,ad_name,campaign_name,form_id,platform" } });
}
