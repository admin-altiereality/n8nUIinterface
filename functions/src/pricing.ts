/**
 * The LearnXR price ladder, partner margins and the competitor prices behind them. Stored in Firestore
 * `settings/pricing` (the repo is public, so no figures live in code). Superadmins edit it on /pricing; the sales
 * team reads it; n8n copies it to the "Pricing" sheet tab; the AI calling agent gets only the plans marked
 * shareable, as "starting from" lines.
 */

export const PRICING_DOC = "settings/pricing";

export type PricePlan = {
  id: string;
  name: string;
  includes: string;
  /** Lowest price in ₹, excluding GST. */
  priceInr: number;
  /** Top of the range when the price is a range; 0 when it's a single price. */
  priceMaxInr: number;
  /** What the price is for: "one-time", "per year", "per student per year"… */
  unit: string;
  notes: string;
  /** The AI agent may mention this plan's starting price. */
  agentCanShare: boolean;
};

export type PartnerMargin = { label: string; percent: number; notes: string };

export type CompetitorPrice = { name: string; offer: string; price: string; source: string; asOf: string };

export type Pricing = {
  gstPercent: number;
  plans: PricePlan[];
  partnerMargins: PartnerMargin[];
  competitors: CompetitorPrice[];
  updatedAt: string | null;
  updatedBy: string | null;
};

export const EMPTY_PRICING: Pricing = {
  gstPercent: 18,
  plans: [],
  partnerMargins: [],
  competitors: [],
  updatedAt: null,
  updatedBy: null,
};

const MAX_INR = 100_000_000;
const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const rupees = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_INR ? Math.round(n) : null;
};

/** Validates a whole pricing document from the /pricing page. Returns it cleaned, or an error naming the problem. */
export function cleanPricing(input: unknown): Omit<Pricing, "updatedAt" | "updatedBy"> | string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Send the pricing as an object.";
  const p = input as Record<string, unknown>;
  const gst = Number(p.gstPercent ?? 18);
  if (!Number.isFinite(gst) || gst < 0 || gst > 50) return "GST must be a percentage between 0 and 50.";

  if (!Array.isArray(p.plans) || p.plans.length > 20) return "Plans must be a list of at most 20.";
  const plans: PricePlan[] = [];
  const ids = new Set<string>();
  for (const raw of p.plans as Array<Record<string, unknown>>) {
    const name = text(raw?.name, 80);
    const id = text(raw?.id, 40) || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const price = rupees(raw?.priceInr);
    const max = rupees(raw?.priceMaxInr ?? 0);
    if (!name || !id) return "Every plan needs a name.";
    if (ids.has(id)) return `Two plans share the id "${id}".`;
    if (price === null || max === null) return `Prices for "${name}" must be rupee amounts.`;
    if (max && max < price) return `The top of the range for "${name}" is below its starting price.`;
    ids.add(id);
    plans.push({
      id,
      name,
      includes: text(raw?.includes, 500),
      priceInr: price,
      priceMaxInr: max,
      unit: text(raw?.unit, 40) || "one-time",
      notes: text(raw?.notes, 500),
      agentCanShare: raw?.agentCanShare === true,
    });
  }

  if (!Array.isArray(p.partnerMargins) || p.partnerMargins.length > 20) return "Partner margins must be a list of at most 20.";
  const partnerMargins: PartnerMargin[] = [];
  for (const raw of p.partnerMargins as Array<Record<string, unknown>>) {
    const label = text(raw?.label, 80);
    const percent = Number(raw?.percent);
    if (!label) return "Every partner margin needs a label.";
    if (!Number.isFinite(percent) || percent < 0 || percent > 60) return `Margin for "${label}" must be 0–60%.`;
    partnerMargins.push({ label, percent: Math.round(percent * 10) / 10, notes: text(raw?.notes, 300) });
  }

  if (!Array.isArray(p.competitors) || p.competitors.length > 40) return "Competitors must be a list of at most 40.";
  const competitors: CompetitorPrice[] = [];
  for (const raw of p.competitors as Array<Record<string, unknown>>) {
    const name = text(raw?.name, 60);
    if (!name) return "Every competitor row needs a name.";
    const source = text(raw?.source, 500);
    if (source && !/^https?:\/\//i.test(source)) return `The source for "${name}" must be a link.`;
    competitors.push({ name, offer: text(raw?.offer, 300), price: text(raw?.price, 120), source, asOf: text(raw?.asOf, 20) });
  }

  return { gstPercent: gst, plans, partnerMargins, competitors };
}

/** Stored data with anything missing or invalid replaced, so readers always get a complete object. */
export function withPricingDefaults(stored: unknown): Pricing {
  const cleaned = stored ? cleanPricing(stored) : null;
  const base = cleaned && typeof cleaned !== "string" ? cleaned : EMPTY_PRICING;
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  return {
    ...EMPTY_PRICING,
    ...base,
    updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : null,
    updatedBy: typeof s.updatedBy === "string" ? s.updatedBy : null,
  };
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** "₹5,95,000", "₹1,25,000–₹1,50,000", or "—" for plans priced another way (a % in the unit). */
export function priceText(plan: PricePlan): string {
  if (!plan.priceInr && !plan.priceMaxInr) return "—";
  return plan.priceMaxInr ? `${inr(plan.priceInr)}–${inr(plan.priceMaxInr)}` : inr(plan.priceInr);
}

/**
 * What the calling agent may say about price: one "starting from" line per shareable plan. Partner margins and
 * competitor figures are never included.
 */
export function agentPricingText(pricing: Pricing): string {
  const lines = pricing.plans
    .filter((p) => p.agentCanShare && p.priceInr > 0)
    .map((p) => `- ${p.name}: starting from ${inr(p.priceInr)} ${p.unit}, plus ${pricing.gstPercent}% GST. Includes: ${p.includes}`);
  if (!lines.length) return "No prices are approved for calls. Say the team will share a quote after understanding the school's needs.";
  return [
    "Approved starting prices (never offer discounts or final quotes; the team sends the exact quote):",
    ...lines,
  ].join("\n");
}

/** Rows for the "Pricing" sheet tab: a header, then plans, partner margins and competitors. */
export function pricingSheetRows(pricing: Pricing): string[][] {
  const rows: string[][] = [["Section", "Name", "Price (₹, ex-GST)", "Unit", "Includes / offer", "Notes / source", "As of"]];
  for (const p of pricing.plans) rows.push(["Plan", p.name, priceText(p), p.unit, p.includes, p.notes, ""]);
  for (const m of pricing.partnerMargins) rows.push(["Partner margin", m.label, `${m.percent}%`, "", "", m.notes, ""]);
  for (const c of pricing.competitors) rows.push(["Competitor", c.name, c.price, "", c.offer, c.source, c.asOf]);
  rows.push(["", `GST ${pricing.gstPercent}% extra on all plans`, "", "", "", `Updated ${pricing.updatedAt || "—"}`, ""]);
  return rows;
}
