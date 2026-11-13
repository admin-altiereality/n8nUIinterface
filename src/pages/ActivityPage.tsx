import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/button';
import { fetchRunLog } from '../api/opsClient';
import { useSheetLeads } from '../lib/useSheetLeads';
import { ACTIVITY_LABELS, buildActivity, type ActivityType, type RunLogEntry } from '../lib/salesOps';

const selectClass = 'h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-100';
const when = (t: number) => new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const TONE: Record<ActivityType, string> = {
  city_run: 'bg-sky-500/15 text-sky-300',
  follow_ups: 'bg-zinc-700/40 text-zinc-300',
  reply: 'bg-emerald-500/15 text-emerald-300',
  bounce: 'bg-red-500/15 text-red-300',
  demo: 'bg-violet-500/15 text-violet-300',
  won: 'bg-amber-500/15 text-amber-300',
};

/** One timeline of what the automation did and what came back. */
export default function ActivityPage() {
  const { leads, loading: leadsLoading, error: leadsError, reload: reloadLeads } = useSheetLeads();
  const [entries, setEntries] = useState<RunLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [type, setType] = useState<ActivityType | ''>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchRunLog(30));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the run log.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const now = useMemo(() => Date.now(), [entries, leads]);
  const items = useMemo(() => buildActivity(leads, entries, now, days).filter((i) => !type || i.type === type), [leads, entries, now, days, type]);

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Activity" subtitle="What the automation did each run, and the replies, bounces, demos and wins that came back.">
        <Button variant="outline" size="sm" onClick={() => { void load(); void reloadLeads(); }} disabled={loading || leadsLoading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading || leadsLoading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </PageHeader>

      {(error || leadsError) && <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error || leadsError}</div>}

      <div className="surface-card mb-4 flex flex-wrap items-center gap-2 p-4">
        <select aria-label="Period" className={selectClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 14, 30].map((d) => <option key={d} value={d}>{d === 1 ? 'Last 24 hours' : `Last ${d} days`}</option>)}
        </select>
        <select aria-label="Type" className={selectClass} value={type} onChange={(e) => setType(e.target.value as ActivityType | '')}>
          <option value="">Everything</option>
          {Object.entries(ACTIVITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="text-xs text-zinc-400">{items.length} events</span>
      </div>

      <ol className="surface-card divide-y divide-zinc-800/70">
        {items.slice(0, 400).map((item, i) => (
          <li key={`${item.type}-${item.at}-${i}`} className="flex gap-3 px-4 py-2.5 text-[11px]">
            <span className="w-36 shrink-0 tabular-nums text-zinc-500">{when(item.at)}</span>
            <span className={`h-fit shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${TONE[item.type]}`}>{ACTIVITY_LABELS[item.type]}</span>
            <span className="min-w-0">
              <span className="font-medium text-zinc-100">
                {item.leadId ? <Link to={`/prospects?lead=${encodeURIComponent(item.leadId)}`} className="hover:underline">{item.title}</Link> : item.title}
              </span>
              {item.detail && <span className="block truncate text-zinc-400">{item.detail}</span>}
            </span>
          </li>
        ))}
        {!items.length && <li className="p-6 text-center text-xs text-zinc-500">{loading || leadsLoading ? 'Loading…' : 'Nothing in this period.'}</li>}
      </ol>
      <p className="mt-2 text-[10px] text-zinc-600">City runs and follow-up runs appear here from 13 Nov 2026. Bounce times are the time of the last email sent to that address.</p>
    </div>
  );
}
