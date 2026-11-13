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
    },
    replaces: event === "BOOKING_RESCHEDULED" ? uidOf(p.rescheduleUid) || uidOf(p.fromReschedule) : "",
  };
}
