import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, applySettingsPatch, changedKeys, summarizeRuns, withDefaults } from './settings';

describe('withDefaults', () => {
  it('returns the defaults for an empty or missing doc', () => {
    expect(withDefaults(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(withDefaults({})).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid stored values and replaces invalid ones', () => {
    const s = withDefaults({ dailyEmailCap: 30, followUpMax: 'x', autoActionsMode: 'live', welcomeMode: 'maybe', channelSpendInr: { website: 500, bogus: 9 } });
    expect(s.dailyEmailCap).toBe(30);
    expect(s.followUpMax).toBe(12);
    expect(s.autoActionsMode).toBe('live');
    expect(s.welcomeMode).toBe('test');
    expect(s.channelSpendInr.website).toBe(500);
    expect(s.channelSpendInr).not.toHaveProperty('bogus');
  });

  it('never lets follow-ups exceed the daily cap', () => {
    expect(withDefaults({ dailyEmailCap: 5, followUpMax: 12 }).followUpMax).toBe(5);
  });
});

describe('applySettingsPatch', () => {
  it('merges a valid partial update', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { monthlyTargetInr: 500000, channelSpendInr: { cold_email: 1200 } });
    expect(next).toMatchObject({ monthlyTargetInr: 500000, dailyEmailCap: 20 });
    expect(typeof next !== 'string' && next.channelSpendInr.cold_email).toBe(1200);
  });

  it('rejects unknown keys, bad modes, too-high caps and bad emails', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { dailyCap: 10 })).toMatch(/Unknown setting/);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { welcomeMode: 'on' })).toMatch(/test" or "live/);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { dailyEmailCap: 5000 })).toMatch(/between 0 and 100/);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { alertRecipients: ['not-an-email'] })).toMatch(/email/);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { channelSpendInr: { tv: 5 } })).toMatch(/Unknown channel/);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { followUpMax: 30 })).toMatch(/more than the daily email cap/);
  });

  it('reports which keys changed', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { dailyEmailCap: 25 });
    expect(typeof next !== 'string' && changedKeys(DEFAULT_SETTINGS, next)).toEqual(['dailyEmailCap']);
  });
});

describe('summarizeRuns', () => {
  it('counts runs and errors in the last 24 hours', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const s = summarizeRuns(
      [
        { id: '3', status: 'success', startedAt: '2026-10-03T11:00:00Z' },
        { id: '2', status: 'error', startedAt: '2026-10-03T05:00:00Z' },
        { id: '1', status: 'error', startedAt: '2026-10-01T05:00:00Z' },
      ],
      now
    );
    expect(s).toEqual({
      lastRunAt: '2026-10-03T11:00:00Z',
      lastStatus: 'success',
      runs24h: 2,
      errors24h: 1,
      lastErrorAt: '2026-10-03T05:00:00Z',
      lastErrorId: '2',
    });
  });

  it('ignores manual test runs from the editor', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const s = summarizeRuns(
      [
        { id: '2', status: 'success', mode: 'webhook', startedAt: '2026-10-03T10:00:00Z' },
        { id: '1', status: 'error', mode: 'manual', startedAt: '2026-10-03T09:00:00Z' },
      ],
      now
    );
    expect(s).toMatchObject({ runs24h: 1, errors24h: 0, lastErrorId: null });
  });

  it('handles a workflow that never ran', () => {
    expect(summarizeRuns([])).toMatchObject({ lastRunAt: null, runs24h: 0, errors24h: 0 });
  });
});
