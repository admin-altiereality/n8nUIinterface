/**
 * Prospects: pick a target list from what the sheet already knows about each school, see why each school
 * has or hasn't been contacted, and export the list. A list is a filter, so it stays current.
 */
import type { SchoolLeadRow } from '../api/sheetsClient';
import { hasReplied, isBounced, isEmailed, scoreLead } from './leadInsights';
import { field, isDoNotContact, stageOf, type Stage } from './pipeline';

export const PROSPECT_STATUSES = {
  not_contacted: 'Not contacted',
  no_email: 'No email address',
  emailed: 'Emailed, no reply',
  replied: 'Replied',
  bounced: 'Email bounced',
  do_not_contact: 'Do not contact',
  won: 'Won',
  lost: 'Lost',
} as const;
export type ProspectStatus = keyof typeof PROSPECT_STATUSES;

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
/** Scraped image names like logo@2x.png look like addresses; n8n's Daily Send Cap rejects them too. */
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

export function hasEmail(row: SchoolLeadRow): boolean {
  const email = field(row, 'Email ID');
  return EMAIL.test(email) && !IMAGE.test(email);
}

export function prospectStatus(row: SchoolLeadRow): ProspectStatus {
  const stage = stageOf(row);
  if (stage === 'Won') return 'won';
  if (isDoNotContact(row)) return 'do_not_contact';
  if (stage === 'Lost') return 'lost';
  if (isBounced(row)) return 'bounced';
  if (hasReplied(row)) return 'replied';
  if (isEmailed(row) && stage !== 'New') return 'emailed';
  return hasEmail(row) ? 'not_contacted' : 'no_email';
}

/** Fit_score from the city run; older rows have none, which is not the same as a low score. */
export function fitOf(row: SchoolLeadRow): number | null {
  const raw = field(row, 'Fit_score');
  const n = Number(raw);
  return raw && Number.isFinite(n) ? n : null;
}

export type Cohort = {
  query: string;
  city: string;
  board: string;
  status: ProspectStatus | '';
  stage: Stage | '';
  minFit: number;
  /** Interested: clicked or replied, so has a positive interest score. */
  interested: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  noLab: boolean;
};

export const EMPTY_COHORT: Cohort = {
  query: '',
  city: '',
  board: '',
  status: '',
  stage: '',
  minFit: 0,
  interested: false,
  hasPhone: false,
  hasWebsite: false,
  noLab: false,
};

export function matchesCohort(row: SchoolLeadRow, c: Cohort, now = Date.now()): boolean {
  if (/^(true|yes|1)$/i.test(field(row, 'is_duplicate'))) return false;
  const q = c.query.trim().toLowerCase();
  if (q && !['School Name', 'City', 'Principal Name', 'Email ID'].some((key) => field(row, key).toLowerCase().includes(q))) return false;
  if (c.city && field(row, 'City').toLowerCase() !== c.city.toLowerCase()) return false;
  if (c.board && field(row, 'Board') !== c.board) return false;
  if (c.status && prospectStatus(row) !== c.status) return false;
  if (c.stage && stageOf(row) !== c.stage) return false;
  if (c.minFit > 0 && (fitOf(row) ?? -1) < c.minFit) return false;
  if (c.hasPhone && !field(row, 'Phone number')) return false;
  if (c.hasWebsite && !field(row, 'Website')) return false;
  if (c.noLab && field(row, 'XR_status') === 'Already Has Lab') return false;
  if (c.interested && scoreLead(row, now).score <= 0) return false;
  return true;
}

/** Best fit first; unscored schools after scored ones; interest breaks ties. */
export function buildCohort(rows: SchoolLeadRow[], cohort: Cohort, now = Date.now()): SchoolLeadRow[] {
  return rows
    .filter((row) => matchesCohort(row, cohort, now))
    .map((row) => ({ row, fit: fitOf(row) ?? -1, interest: scoreLead(row, now).score }))
    .sort((a, b) => b.fit - a.fit || b.interest - a.interest)
    .map((s) => s.row);
}

/** Distinct non-empty values of a column, spelling as first seen, sorted; for the filter menus. */
export function optionsOf(rows: SchoolLeadRow[], key: string): string[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const value = field(row, key);
    if (value && !seen.has(value.toLowerCase())) seen.set(value.toLowerCase(), value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

const CSV_COLUMNS = ['School Name', 'Principal Name', 'Email ID', 'Phone number', 'City', 'Board', 'Website', 'Fit_score', 'Stage', 'Owner', 'Lead_id'];

/**
 * Quotes every cell, and neutralises anything a spreadsheet would run as a formula (scraped text is untrusted).
 * Plain numbers like +91 98765 43210 are left alone so a dialer can still read them.
 */
function csvCell(value: string): string {
  const formula = /^[=@\t\r]/.test(value) || (/^[+-]/.test(value) && !/^[+-][\d\s().-]*$/.test(value));
  const safe = formula ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function cohortCsv(rows: SchoolLeadRow[]): string {
  const header = [...CSV_COLUMNS, 'Status'].map(csvCell).join(',');
  const lines = rows.map((row) =>
    [...CSV_COLUMNS.map((key) => field(row, key)), PROSPECT_STATUSES[prospectStatus(row)]].map(csvCell).join(',')
  );
  return [header, ...lines].join('\r\n');
}
