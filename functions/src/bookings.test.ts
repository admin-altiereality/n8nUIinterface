import { describe, expect, it } from 'vitest';
import { dueMessage, isCalVideo, messageVariables, parseBookingEvent, parseOutcomeEvent, type DemoBooking } from './bookings';

const NOW = Date.parse('2026-11-13T15:18:14Z');
const event = (triggerEvent: string, extra: Record<string, unknown> = {}) => ({
  triggerEvent,
  payload: {
    uid: 'wEn2uAWseYDfQnRPQRpyep',
    title: '30 Min Meeting between Altie Reality and Ravi',
    startTime: '2026-11-16T05:30:00.000Z',
    endTime: '2026-11-16T06:00:00.000Z',
    attendees: [{ name: 'Ravi Mehta', email: 'Ravi@School.in' }],
    metadata: { videoCallUrl: 'https://meet.google.com/pbd-mvut-juj', leadId: 'lx20miwg8rbmp' },
    ...extra,
  },
});

describe('parseBookingEvent', () => {
  it('stores a new booking with its lead, attendee and Meet link', () => {
    expect(parseBookingEvent(event('BOOKING_CREATED'), NOW)).toEqual({
      booking: {
        uid: 'wEn2uAWseYDfQnRPQRpyep', status: 'booked', startTime: '2026-11-16T05:30:00.000Z', endTime: '2026-11-16T06:00:00.000Z',
        name: 'Ravi Mehta', email: 'ravi@school.in', leadId: 'lx20miwg8rbmp', meetUrl: 'https://meet.google.com/pbd-mvut-juj',
        title: '30 Min Meeting between Altie Reality and Ravi', updatedAt: '2026-11-13T15:18:14.000Z', phone: '',
      },
      replaces: '',
    });
  });

  it('marks cancels and points a reschedule at the booking it replaces', () => {
    expect(parseBookingEvent(event('BOOKING_CANCELLED'), NOW)).toMatchObject({ booking: { status: 'cancelled' } });
    expect(parseBookingEvent(event('BOOKING_RESCHEDULED', { rescheduleUid: 'oldUid12345' }), NOW)).toMatchObject({ booking: { status: 'booked' }, replaces: 'oldUid12345' });
  });

  it('ignores other events and rejects bad bodies', () => {
    expect(parseBookingEvent({ triggerEvent: 'PING', payload: {} })).toBeNull();
    expect(parseBookingEvent(null)).toBeTypeOf('string');
    expect(parseBookingEvent(event('BOOKING_CREATED', { uid: '../x' }))).toBeTypeOf('string');
  });

  it('drops unsafe links and bad ids', () => {
    const out = parseBookingEvent(event('BOOKING_CREATED', { metadata: { videoCallUrl: 'javascript:alert(1)', leadId: 'a b' }, videoCallData: { url: 'http://x' } }), NOW);
    expect(out).toMatchObject({ booking: { meetUrl: '', leadId: '' } });
  });
});

const HOUR = 3_600_000;
const START = Date.parse('2026-11-16T05:30:00Z'); // Mon 16 Nov, 11:00 IST
const booking = (extra: Partial<DemoBooking> = {}): DemoBooking => ({
  uid: 'abc12345', status: 'booked', startTime: new Date(START).toISOString(), endTime: new Date(START + HOUR / 2).toISOString(),
  name: 'Ravi Mehta', email: 'ravi@school.in', leadId: 'lx1', meetUrl: 'https://app.cal.com/video/abc12345', title: '', updatedAt: '', phone: '+919876543210', ...extra,
});
const sentAt = (t: number) => new Date(t).toISOString();

describe('booking phone', () => {
  it('reads the phone from the form answer or the attendee', () => {
    expect(parseBookingEvent(event('BOOKING_CREATED', { responses: { attendeePhoneNumber: { value: '+91 98765 43210' } } }), NOW)).toMatchObject({ booking: { phone: '+919876543210' } });
    expect(parseBookingEvent(event('BOOKING_CREATED', { attendees: [{ name: 'R', email: 'r@x.in', phoneNumber: '12' }] }), NOW)).toMatchObject({ booking: { phone: '' } });
  });
});

describe('parseOutcomeEvent', () => {
  it('reads the flat meeting-ended event and the nested no-show event', () => {
    expect(parseOutcomeEvent({ triggerEvent: 'MEETING_ENDED', uid: 'abc12345' })).toEqual({ uid: 'abc12345', kind: 'ended' });
    expect(parseOutcomeEvent({ triggerEvent: 'AFTER_GUESTS_CAL_VIDEO_NO_SHOW', payload: { bookingUid: 'abc12345' } })).toEqual({ uid: 'abc12345', kind: 'no_show' });
    expect(parseOutcomeEvent({ triggerEvent: 'BOOKING_CREATED', payload: { uid: 'abc12345' } })).toBeNull();
    expect(parseOutcomeEvent({ triggerEvent: 'MEETING_ENDED' })).toBeNull();
  });
});

describe('dueMessage', () => {
  it('confirms first, then reminds a day and 15 minutes before', () => {
    expect(dueMessage(booking(), START - 48 * HOUR)).toBe('confirm');
    const confirmed = { confirm: sentAt(START - 48 * HOUR) };
    expect(dueMessage(booking({ notified: confirmed }), START - 30 * HOUR)).toBeNull();
    expect(dueMessage(booking({ notified: confirmed }), START - 23 * HOUR)).toBe('day');
    expect(dueMessage(booking({ notified: { ...confirmed, day: 'x' } }), START - 15 * 60_000)).toBe('min15');
    expect(dueMessage(booking({ notified: { ...confirmed, day: 'x', min15: 'x' } }), START - 10 * 60_000)).toBeNull();
  });

  it('does not stack the day reminder on a fresh confirmation, or confirm a meeting about to start', () => {
    expect(dueMessage(booking({ notified: { confirm: sentAt(START - 23 * HOUR) } }), START - 22.5 * HOUR)).toBeNull();
    expect(dueMessage(booking({ notified: { confirm: sentAt(START - 23 * HOUR) } }), START - 20.5 * HOUR)).toBe('day');
    expect(dueMessage(booking(), START - 10 * 60_000)).toBe('min15');
  });

  it('nudges a no-show at once and once more next working morning, unless they rebooked', () => {
    const noShow = booking({ outcome: 'no_show' });
    expect(dueMessage(noShow, START + 6 * 60_000)).toBe('noshow1');
    expect(dueMessage(noShow, START + 6 * 60_000, true)).toBeNull();
    const nudged = booking({ outcome: 'no_show', notified: { noshow1: sentAt(START + 6 * 60_000) } });
    expect(dueMessage(nudged, START + 3 * HOUR)).toBeNull();
    expect(dueMessage(nudged, START + 24 * HOUR)).toBe('noshow2'); // Tue 11:00 IST
    expect(dueMessage(nudged, START + 15 * HOUR)).toBeNull(); // 02:00 IST
    expect(dueMessage(booking({ outcome: 'no_show', notified: { noshow1: 'x', noshow2: 'x' } }), START + 24 * HOUR)).toBeNull();
  });

  it('follows up a finished demo once, and leaves cancelled or old bookings alone', () => {
    expect(dueMessage(booking({ outcome: 'done' }), START + HOUR)).toBe('followup');
    expect(dueMessage(booking({ outcome: 'done', notified: { followup: 'x' } }), START + HOUR)).toBeNull();
    expect(dueMessage(booking({ outcome: 'done' }), START + 72 * HOUR)).toBeNull();
    expect(dueMessage(booking({ status: 'cancelled' }), START - 23 * HOUR)).toBeNull();
  });
});

describe('message helpers', () => {
  it('fills name, IST time and the right link', () => {
    expect(messageVariables('min15', booking())).toEqual({ 1: 'Ravi', 2: 'Mon, 16 Nov, 11:00 am IST', 3: 'https://app.cal.com/video/abc12345' });
    expect(messageVariables('noshow1', booking({ name: '' }))).toMatchObject({ 1: 'there', 3: 'https://cal.com/altie-reality/30min?metadata%5BleadId%5D=lx1' });
  });

  it('knows a Cal Video link from a Google Meet one', () => {
    expect(isCalVideo(booking())).toBe(true);
    expect(isCalVideo(booking({ meetUrl: 'https://meet.google.com/pbd-mvut-juj' }))).toBe(false);
  });
});
