import { describe, expect, it } from 'vitest';
import { parseBookingEvent } from './bookings';

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
        title: '30 Min Meeting between Altie Reality and Ravi', updatedAt: '2026-11-13T15:18:14.000Z',
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
