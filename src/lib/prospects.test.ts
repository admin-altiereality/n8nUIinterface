import { describe, expect, it } from 'vitest';
import { EMPTY_COHORT, buildCohort, cohortCsv, fitOf, matchesCohort, optionsOf, prospectStatus } from './prospects';

const NOW = Date.parse('2026-11-07T09:30:00Z');
const school = (extra: Record<string, string> = {}) => ({
  'School Name': 'Test School',
  'Email ID': 'office@school.test',
  City: 'Jaipur',
  Status: 'new',
  Stage: 'New',
  ...extra,
});

describe('prospectStatus', () => {
  it('explains why a school was or was not contacted', () => {
    expect(prospectStatus(school())).toBe('not_contacted');
    expect(prospectStatus(school({ 'Email ID': 'logo@2x.png' }))).toBe('no_email');
    expect(prospectStatus(school({ Status: 'first_email_sent', Stage: 'Contacted' }))).toBe('emailed');
    expect(prospectStatus(school({ Stage: 'Contacted', Bounced_status: 'true' }))).toBe('bounced');
    expect(prospectStatus(school({ Reply_Status: 'Replied' }))).toBe('replied');
    expect(prospectStatus(school({ Do_not_contact: 'unsubscribed:x', Reply_Status: 'Replied' }))).toBe('do_not_contact');
  });

  it('keeps a paying school Won even if it left the mailing list', () => {
    expect(prospectStatus(school({ Stage: 'Won', Do_not_contact: 'unsubscribed:x' }))).toBe('won');
  });
});

describe('fitOf', () => {
  it('tells no score from a low score', () => {
    expect(fitOf(school())).toBeNull();
    expect(fitOf(school({ Fit_score: '0' }))).toBe(0);
    expect(fitOf(school({ Fit_score: 'n/a' }))).toBeNull();
  });
});

describe('cohorts', () => {
  it('combines filters and drops duplicates', () => {
    const c = { ...EMPTY_COHORT, city: 'jaipur', board: 'CBSE', minFit: 40 };
    expect(matchesCohort(school({ Board: 'CBSE', Fit_score: '42' }), c, NOW)).toBe(true);
    expect(matchesCohort(school({ Board: 'CBSE', Fit_score: '30' }), c, NOW)).toBe(false);
    expect(matchesCohort(school({ Board: 'CBSE' }), c, NOW)).toBe(false);
    expect(matchesCohort(school({ is_duplicate: 'true' }), EMPTY_COHORT, NOW)).toBe(false);
  });

  it('can leave out schools with a lab and keep only interested ones', () => {
    expect(matchesCohort(school({ XR_status: 'Already Has Lab' }), { ...EMPTY_COHORT, noLab: true }, NOW)).toBe(false);
    expect(matchesCohort(school(), { ...EMPTY_COHORT, interested: true }, NOW)).toBe(false);
    expect(matchesCohort(school({ Clicked_Demo: 'true' }), { ...EMPTY_COHORT, interested: true }, NOW)).toBe(true);
  });

  it('sorts best fit first and unscored last', () => {
    const rows = [school({ Lead_id: 'none' }), school({ Lead_id: 'low', Fit_score: '25' }), school({ Lead_id: 'high', Fit_score: '57' })];
    expect(buildCohort(rows, EMPTY_COHORT, NOW).map((r) => r.Lead_id)).toEqual(['high', 'low', 'none']);
  });

  it('lists options once whatever the casing', () => {
    expect(optionsOf([school(), school({ City: 'JAIPUR' }), school({ City: 'Ajmer' }), school({ City: '' })], 'City')).toEqual(['Ajmer', 'Jaipur']);
  });
});

describe('cohortCsv', () => {
  it('quotes cells and stops scraped text running as a formula', () => {
    const csv = cohortCsv([school({ 'School Name': '=HYPERLINK("http://x.test")', City: 'Jai"pur' })]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x.test"")"`);
    expect(csv).toContain('"Jai""pur"');
    expect(csv.split('\r\n')).toHaveLength(2);
  });
});
