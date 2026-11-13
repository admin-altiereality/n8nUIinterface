/**
 * cal.com demo bookings, forwarded raw by n8n "Sales • Demo Bookings" (X-Altie-Key) and kept one doc per booking
 * so the Meetings page can list them, including bookings made straight on cal.com without a lead ID.
 */
export const DEMO_BOOKINGS = "demoBookings";

export type BookingStatus = "booked" | "cancelled" | "rescheduled";

export interface DemoBooking {
  uid: string;
  status: BookingStatus;
  startTime: string;
  endTime: string;
  name: string;
  email: string;
  leadId: string;
  meetUrl: string;
  title: string;
  updatedAt: string;
  /** Attendee's phone from the booking form, digits with country code; "" when they gave none. */
  phone: string;
  /** How the meeting went; set by cal.com events (Cal Video only) or the buttons on the Meetings page. */
  outcome?: "" | "done" | "no_show";
  /** Message key -> ISO time it was sent, or the reason it was skipped. */
  notified?: Record<string, string>;
}

const text = (value: unknown, max: number): string =>
  // eslint-disable-next-line no-control-regex
  (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");
const iso = (value: unknown): string => {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
};
const uidOf = (value: unknown): string => {
  const uid = text(value, 64);
  return /^[A-Za-z0-9_-]{6,64}$/.test(uid) ? uid : "";
};

/**
 * The booking to store, the uid of a booking it replaces (reschedule), null for events we ignore, or an error.
 */
export function parseBookingEvent(
  body: unknown,
  now = Date.now()
): { booking: DemoBooking; replaces: string } | null | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Body must be an object.";
  const b = body as Record<string, unknown>;
  const event = String(b.triggerEvent || "");
  const status: BookingStatus | null =
    event === "BOOKING_CREATED" || event === "BOOKING_RESCHEDULED" ? "booked" : event === "BOOKING_CANCELLED" ? "cancelled" : null;
  if (!status) return null;
  const p = (b.payload && typeof b.payload === "object" ? b.payload : {}) as Record<string, unknown>;
  const uid = uidOf(p.uid);
  if (!uid) return "payload.uid is missing or invalid.";
  const who = (Array.isArray(p.attendees) ? p.attendees[0] : {}) as Record<string, unknown>;
  const metadata = (p.metadata && typeof p.metadata === "object" ? p.metadata : {}) as Record<string, unknown>;
  const video = (p.videoCallData && typeof p.videoCallData === "object" ? p.videoCallData : {}) as Record<string, unknown>;
  const meetUrl = text(metadata.videoCallUrl, 300) || text(video.url, 300);
  const email = text(who.email, 200).toLowerCase();
  const responses = (p.responses && typeof p.responses === "object" ? p.responses : {}) as Record<string, unknown>;
  const phoneField = (responses.attendeePhoneNumber && typeof responses.attendeePhoneNumber === "object" ? responses.attendeePhoneNumber : {}) as Record<string, unknown>;
  const phone = (text(phoneField.value, 30) || text(who.phoneNumber, 30)).replace(/[^\d+]/g, "");
  return {
    booking: {
      uid,
      status,
      startTime: iso(p.startTime),
      endTime: iso(p.endTime),
      name: text(who.name, 120),
      email: /^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(email) ? email : "",
      leadId: /^[A-Za-z0-9_-]{1,40}$/.test(text(metadata.leadId, 40)) ? text(metadata.leadId, 40) : "",
      meetUrl: /^https:\/\//.test(meetUrl) ? meetUrl : "",
      title: text(p.title, 200),
      updatedAt: new Date(now).toISOString(),
      phone: /^\+?\d{10,15}$/.test(phone) ? phone : "",
    },
    replaces: event === "BOOKING_RESCHEDULED" ? uidOf(p.rescheduleUid) || uidOf(p.fromReschedule) : "",
  };
}

/** cal.com events about how a meeting went: it ended, or the guest never joined (Cal Video only). */
export function parseOutcomeEvent(body: unknown): { uid: string; kind: "ended" | "no_show" } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const event = String(b.triggerEvent || "");
  const kind = event === "MEETING_ENDED" ? "ended" : event === "AFTER_GUESTS_CAL_VIDEO_NO_SHOW" ? "no_show" : null;
  if (!kind) return null;
  // MEETING_ENDED is flat (no payload wrapper); the no-show event nests the booking under payload.
  const p = (b.payload && typeof b.payload === "object" ? b.payload : b) as Record<string, unknown>;
  const uid = uidOf(p.uid) || uidOf(p.bookingUid) || uidOf(b.uid);
  return uid ? { uid, kind } : null;
}

/** Only a Cal Video meeting can tell us the guest was there, so only those are marked done automatically. */
export const isCalVideo = (b: Pick<DemoBooking, "meetUrl">): boolean => /\/\/(app\.)?cal\.(com|app)\/video\//.test(b.meetUrl || "");

export type MessageKey = "confirm" | "day" | "min15" | "noshow1" | "noshow2" | "followup";
export const MESSAGE_TEMPLATES: Record<MessageKey, string> = {
  confirm: "lxr_demo_confirm_en",
  day: "lxr_demo_reminder_day_en",
  min15: "lxr_demo_reminder_15m_en",
  noshow1: "lxr_demo_noshow_en",
  noshow2: "lxr_demo_noshow_en",
  followup: "lxr_demo_followup_en",
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const istHour = (t: number) => new Date(t + 5.5 * HOUR).getUTCHours();

/**
 * The one WhatsApp message this booking is due now, if any. Called every 5 minutes.
 * `rebooked` = the same person already has a later booking, so no-show nudges stop.
 */
export function dueMessage(b: DemoBooking, now: number, rebooked = false): MessageKey | null {
  const start = Date.parse(b.startTime);
  if (!Number.isFinite(start)) return null;
  const sent = b.notified || {};
  const at = (key: string) => Date.parse(sent[key] || "") || 0;
  if (b.status === "booked" && !b.outcome) {
    const until = start - now;
    if (!sent.confirm && until > 30 * MIN) return "confirm";
    // Not right on top of the confirmation: someone who books 21 hours ahead gets the reminder a little later.
    if (!sent.day && until <= 24 * HOUR && until >= 20 * HOUR && now - at("confirm") >= 2 * HOUR) return "day";
    if (!sent.min15 && until <= 20 * MIN && until >= 3 * MIN) return "min15";
    return null;
  }
  if (now - start > 48 * HOUR) return null;
  if (b.status === "booked" && b.outcome === "no_show" && !rebooked) {
    if (!sent.noshow1) return "noshow1";
    // One more nudge the next working morning, then stop.
    if (!sent.noshow2 && now - at("noshow1") >= 18 * HOUR && istHour(now) >= 10 && istHour(now) < 19) return "noshow2";
  }
  if (b.status === "booked" && b.outcome === "done" && !sent.followup) return "followup";
  return null;
}

/** Template variables: {{1}} first name, {{2}} when (IST), {{3}} link. */
export function messageVariables(key: MessageKey, b: DemoBooking): Record<string, string> {
  const first = (b.name || "").trim().split(/\s+/)[0] || "";
  const when = b.startTime
    ? new Date(b.startTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + " IST"
    : "";
  const rebook = "https://cal.com/altie-reality/30min" + (b.leadId ? `?metadata%5BleadId%5D=${encodeURIComponent(b.leadId)}` : "");
  const link = key === "noshow1" || key === "noshow2" ? rebook : b.meetUrl || rebook;
  return { 1: /^[A-Za-z]{2,}$/.test(first) ? first : "there", 2: when, 3: link };
}
