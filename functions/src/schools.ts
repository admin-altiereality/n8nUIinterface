/**
 * School 360°: every sheet row that shares an Org_key, and one timeline of everything that happened with that
 * school — funnel milestones from the sheet, staff actions from the audit log, and WhatsApp messages from Twilio.
 */

export type Row = Record<string, unknown>;

export type TimelineKind = "lead" | "email" | "whatsapp" | "form" | "deal" | "note" | "system";

export type TimelineEvent = {
  at: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  leadId?: string;
  actor?: string;
};

const str = (row: Row, key: string) => String(row[key] ?? "").trim().replace(/^"|"$/g, "");

function iso(value: unknown): string | null {
  const t = Date.parse(String(value ?? "").trim().replace(/^"|"$/g, ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** +91XXXXXXXXXX for Indian mobiles written any common way; "" when it isn't a phone number. */
export function toE164(value: unknown): string {
  const raw = String(value ?? "").replace(/^whatsapp:/i, "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (raw.startsWith("+")) return digits.length >= 8 ? `+${digits}` : "";
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  return "";
}

const SOURCE_TITLES: Record<string, string> = {
  instagram_ad: "Instagram lead form submitted",
  facebook_ad: "Facebook lead form submitted",
  website: "Website enquiry",
  whatsapp: "Wrote in on WhatsApp",
  cold_email: "Found by city run",
};

function sourceOf(row: Row): string {
  const stored = str(row, "Lead_source").toLowerCase();
  if (SOURCE_TITLES[stored]) return stored;
  const kw = str(row, "XR_keywords").toLowerCase();
  if (kw.includes("instagram_lead_ad")) return "instagram_ad";
  if (kw.includes("facebook_lead_ad")) return "facebook_ad";
  if (str(row, "Status").toLowerCase() === "website_lead" || str(row, "XR_status") === "Inbound Website Lead") return "website";
  return "cold_email";
}

/** Milestones the funnel writes onto a sheet row, as timeline events. */
export function rowEvents(row: Row): TimelineEvent[] {
  const leadId = str(row, "Lead_id") || undefined;
  const who = str(row, "Principal Name") || str(row, "Email ID") || str(row, "Phone number");
  const out: TimelineEvent[] = [];
  const add = (key: string, kind: TimelineKind, title: string, detail?: string) => {
    const at = iso(row[key]);
    if (at) out.push({ at, kind, title, detail: detail || undefined, leadId });
  };
  const source = sourceOf(row);
  add("Time", source === "cold_email" ? "lead" : "form", SOURCE_TITLES[source], [who, str(row, "Lead_campaign")].filter(Boolean).join(" · "));
  add("Email_sent_at", "email", "First email sent", str(row, "Email ID"));
  const followUps = Number(str(row, "Follow_up_count")) || 0;
  add("Last_Follow_up", "email", followUps ? `Follow-up ${followUps} sent` : "Follow-up sent");
  add("Opened_at", "email", "Email opened");
  add("Last_Clicked_at", "email", "Clicked a link in the email", str(row, "Last_Clicked_Button"));
  add("Replied_at", str(row, "Reply_channel") === "whatsapp" ? "whatsapp" : "email", "Replied", [str(row, "Reply_intent"), str(row, "Reply_snippet")].filter(Boolean).join(": "));
  add("Hot_at", "lead", "Marked hot");
  add("First_touch_at", "lead", "First call or message from us");
  add("Demo_booked_at", "deal", "Demo booked", iso(row.Demo_at) ? `For ${iso(row.Demo_at)}` : undefined);
  add("Demo_done_at", "deal", "Demo done");
  add("Proposal_sent_at", "deal", "Proposal sent", str(row, "Deal_value") ? `₹${str(row, "Deal_value")}` : undefined);
  add("Won_at", "deal", "Won", str(row, "Paid_amount") ? `Paid ₹${str(row, "Paid_amount")}` : undefined);
  add("Lost_at", "deal", "Lost", str(row, "Lost_reason"));
  const dnc = str(row, "Do_not_contact");
  if (dnc) {
    const [reason, ...rest] = dnc.split(":");
    const at = iso(rest.join(":"));
    if (at) out.push({ at, kind: "system", title: "Do not contact", detail: reason, leadId });
  }
  return out;
}

const AUDIT_TITLES: Record<string, string> = {
  "lead.update": "Lead updated",
  "lead.note": "Note",
  "lead.claim": "Claimed",
  "lead.unclaim": "Released",
  "lead.unsubscribe": "Unsubscribed",
  "lead.call": "Call logged",
};

/** Staff actions from the ops audit log. */
export function auditEvents(entries: Array<Record<string, any>>): TimelineEvent[] {
  return entries.flatMap((e) => {
    const at = iso(e.createdAt);
    if (!at || typeof e.action !== "string" || !e.action.startsWith("lead.")) return [];
    const d = e.details || {};
    let detail: string | undefined;
    if (e.action === "lead.note") detail = String(d.text || "");
    else if (e.action === "lead.call") detail = [d.outcome, d.notes].filter(Boolean).join(" — ");
    else if (d.fields && typeof d.fields === "object") detail = Object.keys(d.fields).join(", ");
    const kind: TimelineKind = e.action === "lead.note" || e.action === "lead.call" ? "note" : "system";
    return [{ at, kind, title: AUDIT_TITLES[e.action] || e.action, detail: detail || undefined, leadId: e.targetId || undefined, actor: e.actorEmail || undefined }];
  });
}

export type TwilioMessage = { sid?: string; direction?: string; body?: string; status?: string; date_sent?: string; date_created?: string };

/** WhatsApp messages from Twilio (both directions). */
export function messageEvents(messages: TwilioMessage[]): TimelineEvent[] {
  const seen = new Set<string>();
  return messages.flatMap((m) => {
    if (m.sid && seen.has(m.sid)) return [];
    if (m.sid) seen.add(m.sid);
    const at = iso(m.date_sent || m.date_created);
    if (!at) return [];
    const inbound = String(m.direction || "").startsWith("inbound");
    const status = !inbound && m.status && !["delivered", "read", "sent"].includes(m.status) ? ` (${m.status})` : "";
    return [{ at, kind: "whatsapp" as const, title: inbound ? "WhatsApp from school" : `WhatsApp sent${status}`, detail: String(m.body || "").slice(0, 300) || undefined }];
  });
}

export function sortTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The school's name, place and contacts, from its rows (the most recently active row wins for shared fields). */
export function schoolSummary(rows: Row[]) {
  const pick = (key: string) => rows.map((r) => str(r, key)).find(Boolean) || "";
  return {
    name: pick("School Name"),
    city: pick("City"),
    website: pick("Website"),
    board: pick("Board"),
    contacts: rows.map((r) => ({
      leadId: str(r, "Lead_id"),
      name: str(r, "Principal Name"),
      email: str(r, "Email ID"),
      phone: toE164(r["Phone number"]) || toE164(r.WhatsApp_number),
      stage: str(r, "Stage") || "New",
      owner: str(r, "Owner"),
      source: sourceOf(r),
    })),
  };
}
