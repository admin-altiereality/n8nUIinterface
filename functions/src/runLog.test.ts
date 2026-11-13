import { describe, expect, it } from 'vitest';
import { parseRunLog } from './runLog';

const NOW = Date.parse('2026-11-13T06:00:00Z');

describe('parseRunLog', () => {
  it('stores a city run, pulling Reoon counts out of the skipped counts', () => {
    const entry = parseRunLog({
      kind: 'city_run', executionId: '25436', city: 'Mumbai', segment: 'coaching', preset: 'coaching', mode: 'live',
      found: '60', unique: 52, added: 9, emailed: 4, emailFailed: 0,
      skipped: '{"known":3,"off_target":7,"reoon_checked":6,"reoon_verified":2,"reoon_catch_all":1}',
    }, NOW);
    expect(entry).toMatchObject({
      kind: 'city_run', executionId: '25436', at: '2026-11-13T06:00:00.000Z', city: 'Mumbai', segment: 'coaching',
      found: 60, unique: 52, added: 9, emailed: 4, reoonChecked: 6, reoonVerified: 2, reoonCatchAll: 1,
      skipped: { known: 3, off_target: 7 }, bounceRate: null,
    });
  });

  it('defaults an unknown segment to K-12 and clears it for follow-up runs', () => {
    expect(parseRunLog({ kind: 'city_run', executionId: '1', segment: 'bogus' }, NOW)).toMatchObject({ segment: 'k12' });
    expect(parseRunLog({ kind: 'follow_ups', executionId: '2', segment: 'k12', followUps: 12, bounceRate: '2.34' }, NOW))
      .toMatchObject({ segment: '', followUps: 12, bounceRate: 2.3 });
  });

  it('rejects bad bodies and ids', () => {
    expect(parseRunLog(null)).toBeTypeOf('string');
    expect(parseRunLog([])).toBeTypeOf('string');
    expect(parseRunLog({ kind: 'other', executionId: '1' })).toBeTypeOf('string');
    expect(parseRunLog({ kind: 'city_run', executionId: '../x' })).toBeTypeOf('string');
  });

  it('clamps numbers, drops odd skip keys and trims text', () => {
    const entry = parseRunLog({
      kind: 'city_run', executionId: 7, found: -5, added: 'x', city: ' Pune\n', error: 'e'.repeat(500),
      skipped: { 'Bad-Key': 3, closed: 2.9 }, bounceRate: 150,
    }, NOW);
    expect(entry).toMatchObject({ executionId: '7', found: 0, added: 0, city: 'Pune', skipped: { closed: 2 }, bounceRate: null });
    expect(typeof entry !== 'string' && entry.error.length).toBe(200);
  });
});
