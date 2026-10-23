import { describe, expect, it } from 'vitest';
import { customerHealth, defaultRenewalAt, formSpamReason, hostOf, renewalReminderDue, suggestProductSchools } from './customers';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-03T12:00:00Z');

describe('suggestProductSchools', () => {
  const schools = [
    { id: 's1', name: 'Delhi Public School Indore', city: 'Indore', website: 'https://www.dpsindore.org/', phone: '' },
    { id: 's2', name: 'Kendriya Vidyalaya', city: 'Bhopal', website: '', phone: '+91 98765 43210' },
    { id: 's3', name: 'Sunrise Academy', city: 'Pune', website: '', phone: '' },
  ];
  it('ranks by website, phone, name and city', () => {
    const out = suggestProductSchools(
      [{ 'School Name': 'Delhi Public School, Indore', City: 'Indore', Website: 'dpsindore.org', 'Email ID': 'principal@dpsindore.org' }],
      schools
    );
    expect(out[0]).toMatchObject({ id: 's1', reasons: ['same website', 'similar name', 'same city'] });
    expect(out.map((s) => s.id)).not.toContain('s3');
  });
  it('matches on phone', () => {
    expect(suggestProductSchools([{ 'School Name': 'KV No 2', 'Phone number': '09876543210' }], schools)[0].id).toBe('s2');
  });
  it('normalises hosts', () => {
    expect(hostOf('HTTPS://WWW.Example.org/path?q=1')).toBe('example.org');
  });
});

describe('customerHealth', () => {
  const at = (daysAgo: number | null) => (daysAgo === null ? null : NOW - daysAgo * DAY);
  it('weighs active teachers over students', () => {
    const h = customerHealth({
      now: NOW,
      users: [
        { uid: 't1', role: 'teacher', lastActiveAt: at(2) },
        { uid: 't2', role: 'teacher', lastActiveAt: at(45) },
        { uid: 's1', role: 'student', lastActiveAt: at(1) },
        { uid: 's2', role: 'student', lastActiveAt: null },
      ],
    });
    expect(h).toMatchObject({ teachers: 2, activeTeachers: 1, students: 2, activeStudents: 1, score: 50, band: 'watch' });
  });
  it('flags weak usage close to renewal as at risk, and empty schools as not started', () => {
    const users = [{ uid: 't1', role: 'teacher', lastActiveAt: at(2) }, { uid: 't2', role: 'teacher', lastActiveAt: null }];
    expect(customerHealth({ now: NOW, users, renewalAt: NOW + 20 * DAY }).band).toBe('at risk');
    expect(customerHealth({ now: NOW, users: [] }).band).toBe('not started');
    expect(customerHealth({ now: NOW, users: [{ uid: 't1', role: 'teacher', lastActiveAt: at(1) }] })).toMatchObject({ score: 60, band: 'healthy' });
  });
});

describe('renewals', () => {
  it('defaults to a year after the deal was won', () => {
    expect(defaultRenewalAt([{ Won_at: '2026-01-10T00:00:00Z' }])).toBe(Date.parse('2026-01-10T00:00:00Z') + 365 * DAY);
    expect(defaultRenewalAt([{}])).toBeNull();
  });
  it('picks the 60, 30 or 7-day reminder', () => {
    expect(renewalReminderDue(NOW + 90 * DAY, NOW)).toBeNull();
    expect(renewalReminderDue(NOW + 45 * DAY, NOW)).toBe(60);
    expect(renewalReminderDue(NOW + 20 * DAY, NOW)).toBe(30);
    expect(renewalReminderDue(NOW + 3 * DAY, NOW)).toBe(7);
    expect(renewalReminderDue(NOW - DAY, NOW)).toBeNull();
  });
});

describe('formSpamReason', () => {
  it('keeps real enquiries', () => {
    expect(formSpamReason({ name: 'Asha Rao', email: 'asha@dps.org', subject: 'Question about your services', message: 'Do you support CBSE class 8?' })).toBeNull();
  });
  it('drops pitches, gibberish, tests and junk', () => {
    expect(formSpamReason({ name: 'Mike', email: 'mike@seo.biz', subject: 'Have any writing needs?', message: '' })).toBe('sales pitch');
    expect(formSpamReason({ name: 'GALKFLKA', email: 'x@y.co', subject: 'GALKFLKA', message: 'GALKFLKA' })).toBe('gibberish');
    expect(formSpamReason({ name: 'Me', email: 'me@altiereality.com', subject: 'Form works end to end' })).toBe('internal test');
    expect(formSpamReason({ name: 'A', email: 'not-an-email', subject: 'Hi' })).toBe('no valid email');
    expect(formSpamReason({ name: 'A', email: 'a@b.com', subject: 'Hello there', message: 'see http://a.com and http://b.com' })).toBe('links');
    expect(formSpamReason({ name: 'A', email: 'a@b.com', subject: 'Bh', message: 'gugh' })).toBe('too short');
    expect(formSpamReason({ name: 'A', email: 'a@b.com', subject: 'pwcheck-113447', message: 'x' })).toBe('internal test');
  });
});
