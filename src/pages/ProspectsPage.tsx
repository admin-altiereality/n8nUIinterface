import React, { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, RefreshCw, RotateCcw } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { LeadDrawer } from '../components/sales/LeadDrawer';
import { writeOpsAuditEvent } from '../api/opsClient';
import type { SchoolLeadRow } from '../api/sheetsClient';
import { STAGES, field, stageOf, type Stage } from '../lib/pipeline';
import {
  EMPTY_COHORT,
  PROSPECT_STATUSES,
  buildCohort,
  cohortCsv,
  fitOf,
  optionsOf,
  prospectStatus,
  type Cohort,
  type ProspectStatus,
} from '../lib/prospects';
import { useSheetLeads } from '../lib/useSheetLeads';

const ROWS_SHOWN = 200;
const selectClass = 'h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-100';
const CHECKS: Array<{ key: 'interested' | 'hasPhone' | 'hasWebsite' | 'noLab'; label: string }> = [
  { key: 'interested', label: 'Clicked or replied' },
  { key: 'hasPhone', label: 'Has a phone' },
  { key: 'hasWebsite', label: 'Has a website' },
  { key: 'noLab', label: 'No XR/STEM lab yet' },
];

export default function ProspectsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { leads, loading, error, reload, replaceLead } = useSheetLeads();
  const [cohort, setCohort] = useState<Cohort>(EMPTY_COHORT);
  const set = <K extends keyof Cohort>(key: K, value: Cohort[K]) => setCohort((c) => ({ ...c, [key]: value }));

  const now = useMemo(() => Date.now(), [leads]);
  const rows = useMemo(() => buildCohort(leads, cohort, now), [leads, cohort, now]);
  const cities = useMemo(() => optionsOf(leads, 'City'), [leads]);
  const boards = useMemo(() => optionsOf(leads, 'Board'), [leads]);
  const scored = useMemo(() => rows.filter((row) => fitOf(row) !== null).length, [rows]);

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([cohortCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `learnxr-prospects-${new Date(now).toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    // Contact lists leaving the app belong in the audit log; a failed log shouldn't undo the download.
    void writeOpsAuditEvent({ action: 'prospects.export', details: { count: rows.length, cohort } }).catch(() => undefined);
  };

  const leadParam = searchParams.get('lead');
  const openLead = useMemo(
    () => (leadParam ? leads.find((row) => field(row, 'Lead_id') === leadParam) || null : null),
    [leads, leadParam]
  );
  const openDrawer = (row: SchoolLeadRow) => {
    const id = field(row, 'Lead_id');
    if (id) setSearchParams({ lead: id });
  };
  const closeDrawer = useCallback(() => setSearchParams({}), [setSearchParams]);

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Prospects" subtitle="Build a target list from what we know about each school, best fit first.">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button size="sm" onClick={exportCsv} disabled={!rows.length}>
            <Download className="h-3.5 w-3.5" /> Export {rows.length}
          </Button>
        </div>
      </PageHeader>

      {error && <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error}</div>}

      <div className="surface-card mb-4 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="Search school, city, name…"
            value={cohort.query}
            onChange={(e) => set('query', e.target.value)}
            className="h-8 w-52 text-xs"
          />
          <select aria-label="City" className={selectClass} value={cohort.city} onChange={(e) => set('city', e.target.value)}>
            <option value="">All cities</option>
            {cities.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select aria-label="Board" className={selectClass} value={cohort.board} onChange={(e) => set('board', e.target.value)}>
            <option value="">All boards</option>
            {boards.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <select aria-label="Status" className={selectClass} value={cohort.status} onChange={(e) => set('status', e.target.value as ProspectStatus | '')}>
            <option value="">Any status</option>
            {Object.entries(PROSPECT_STATUSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <select aria-label="Stage" className={selectClass} value={cohort.stage} onChange={(e) => set('stage', e.target.value as Stage | '')}>
            <option value="">Any stage</option>
            {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            Fit at least
            <Input
              type="number"
              min={0}
              max={100}
              value={cohort.minFit || ''}
              onChange={(e) => set('minFit', Number(e.target.value) || 0)}
              className="h-8 w-16 text-xs"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {CHECKS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-1.5 text-[11px] text-zinc-300">
              <input type="checkbox" checked={cohort[key]} onChange={(e) => set(key, e.target.checked)} /> {label}
            </label>
          ))}
          <button type="button" onClick={() => setCohort(EMPTY_COHORT)} className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-200">
            <RotateCcw className="h-3 w-3" /> Clear
          </button>
        </div>
        <p className="text-xs text-zinc-300">
          <span className="font-semibold text-zinc-100">{rows.length}</span> of {leads.length} schools match
          <span className="text-zinc-500"> · {scored} have a fit score (only recent city runs do)</span>
        </p>
      </div>

      <div className="surface-card overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[11px]">
          <thead className="text-zinc-500">
            <tr className="border-b border-zinc-800">
              {['School', 'City', 'Board', 'Fit', 'Stage', 'Status'].map((h) => (
                <th key={h} scope="col" className={`px-3 py-2 font-medium ${h === 'Fit' ? 'text-right' : ''}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROWS_SHOWN).map((row, i) => (
              <tr
                key={field(row, 'Lead_id') || `${field(row, 'School Name')}-${i}`}
                onClick={() => openDrawer(row)}
                className="cursor-pointer border-b border-zinc-800/60 text-zinc-300 hover:bg-zinc-800/40"
              >
                <td className="max-w-[280px] truncate px-3 py-2 font-medium text-zinc-100">{field(row, 'School Name') || 'Unknown school'}</td>
                <td className="px-3 py-2">{field(row, 'City') || '—'}</td>
                <td className="px-3 py-2">{field(row, 'Board') || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fitOf(row) ?? '—'}</td>
                <td className="px-3 py-2">{stageOf(row)}</td>
                <td className="px-3 py-2">{PROSPECT_STATUSES[prospectStatus(row)]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="p-6 text-center text-xs text-zinc-500">{loading ? 'Loading schools…' : 'No schools match these filters.'}</p>}
      </div>
      {rows.length > ROWS_SHOWN && <p className="mt-2 text-[10px] text-zinc-600">Showing the top {ROWS_SHOWN}. Export includes all {rows.length}.</p>}

      {openLead && <LeadDrawer lead={openLead} onClose={closeDrawer} onChange={replaceLead} />}
    </div>
  );
}
