import React, { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Flame, RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { LeadDrawer } from '../components/sales/LeadDrawer';
import { useAuth } from '../context/AuthContext';
import type { SchoolLeadRow } from '../api/sheetsClient';
import {
  SOURCES,
  SOURCE_LABELS,
  dealValue,
  field,
  formatInr,
  formatWhen,
  leadSource,
  ownerLabel,
  pipelineByStage,
  timeOf,
  type LeadSource,
  type Stage,
} from '../lib/pipeline';
import { useSheetLeads } from '../lib/useSheetLeads';

const COLLAPSED_STAGES: readonly Stage[] = ['Won', 'Lost'];
const CARDS_PER_COLUMN = 60;
const SEARCH_COLUMNS = ['School Name', 'City', 'Email ID', 'Phone number', 'Owner', 'Next_step'];

export default function PipelinePage() {
  const { user } = useAuth();
  const me = (user?.email || '').toLowerCase();
  const [searchParams, setSearchParams] = useSearchParams();
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<LeadSource | 'all'>((searchParams.get('source') as LeadSource) || 'all');
  const [showAll, setShowAll] = useState<Partial<Record<Stage, boolean>>>({});
  const { leads, loading, error, reload, replaceLead } = useSheetLeads({ refreshMs: 60_000 });

  const now = useMemo(() => Date.now(), [leads]);
  const columns = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = leads.filter(
      (row) =>
        (scope === 'all' || field(row, 'Owner').toLowerCase() === me) &&
        (source === 'all' || leadSource(row) === source) &&
        (!q || SEARCH_COLUMNS.some((key) => field(row, key).toLowerCase().includes(q)))
    );
    return pipelineByStage(visible);
  }, [leads, scope, me, query, source]);

  const leadParam = searchParams.get('lead');
  const openLead = useMemo(
    () => (leadParam ? leads.find((row) => field(row, 'Lead_id') === leadParam) || null : null),
    [leads, leadParam]
  );
  const openDrawer = (row: SchoolLeadRow) => {
    const id = field(row, 'Lead_id');
    if (id) setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('lead', id);
      return next;
    });
  };
  const closeDrawer = useCallback(
    () =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('lead');
        return next;
      }),
    [setSearchParams]
  );

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Pipeline" subtitle="Every school by stage. Open a card to update it.">
        <div className="flex items-center gap-2">
          <Input
            placeholder="Search school, city, owner…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-48 text-xs"
          />
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as LeadSource | 'all')}
            className="h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-100"
            aria-label="Lead source"
          >
            <option value="all">All sources</option>
            {SOURCES.map((key) => (
              <option key={key} value={key}>{SOURCE_LABELS[key]}</option>
            ))}
          </select>
          <div className="flex rounded-lg border border-zinc-700 p-0.5">
            {(['all', 'mine'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={`rounded-md px-3 py-1 text-[11px] font-medium ${
                  scope === s ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {s === 'all' ? 'All' : 'Mine'}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </PageHeader>

      {error && (
        <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error}</div>
      )}

      {loading && !leads.length && (
        <div className="surface-card mb-4 p-6 text-center text-xs text-zinc-500">Loading leads…</div>
      )}

      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map((column) => {
          const collapsed = COLLAPSED_STAGES.includes(column.stage) && !showAll[column.stage];
          const limit = showAll[column.stage] ? column.rows.length : CARDS_PER_COLUMN;
          const cards = collapsed ? [] : column.rows.slice(0, limit);
          return (
            <div key={column.stage} className="flex w-64 flex-shrink-0 flex-col">
              <div className="mb-2 flex items-baseline justify-between px-1">
                <h3 className="text-xs font-semibold text-zinc-200">
                  {column.stage} <span className="text-zinc-500">{column.rows.length}</span>
                </h3>
                {column.value > 0 && <span className="text-[10px] text-zinc-400">{formatInr(column.value)}</span>}
              </div>
              <div className="space-y-2">
                {cards.map((row) => {
                  const due = timeOf(row, 'Next_step_due');
                  const owner = field(row, 'Owner').toLowerCase();
                  return (
                    <button
                      key={field(row, 'Lead_id') || field(row, 'School Name')}
                      type="button"
                      onClick={() => openDrawer(row)}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-800/40 p-3 text-left hover:border-zinc-700"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="line-clamp-2 text-xs font-medium text-zinc-100">{field(row, 'School Name') || 'Unknown school'}</p>
                        {timeOf(row, 'Hot_at') !== null && <Flame className="h-3.5 w-3.5 flex-shrink-0 text-orange-400" />}
                      </div>
                      <p className="mt-0.5 truncate text-[10px] text-zinc-500">
                        {field(row, 'City') || '—'}
                        {owner && ` · ${owner === me ? 'you' : ownerLabel(owner)}`}
                        {dealValue(row) > 0 && ` · ${formatInr(dealValue(row))}`}
                        {leadSource(row) !== 'cold_email' && ` · ${SOURCE_LABELS[leadSource(row)]}`}
                      </p>
                      {field(row, 'Next_step') && (
                        <p className="mt-1.5 truncate text-[10px] text-zinc-300">
                          {due !== null && (
                            <span className={due < now ? 'text-red-400' : 'text-zinc-500'}>{formatWhen(due, now)} · </span>
                          )}
                          {field(row, 'Next_step')}
                        </p>
                      )}
                    </button>
                  );
                })}
                {(collapsed || column.rows.length > limit) && column.rows.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowAll({ ...showAll, [column.stage]: true })}
                    className="w-full rounded-lg border border-dashed border-zinc-800 py-2 text-[10px] text-zinc-500 hover:text-zinc-300"
                  >
                    Show {collapsed ? '' : 'all '}
                    {column.rows.length}
                  </button>
                )}
                {!column.rows.length && <p className="px-1 text-[10px] text-zinc-700">None</p>}
              </div>
            </div>
          );
        })}
      </div>

      {openLead && <LeadDrawer lead={openLead} onClose={closeDrawer} onChange={replaceLead} />}
    </div>
  );
}
