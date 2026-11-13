import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/button';
import { fetchRunLog } from '../api/opsClient';
import { useSheetLeads } from '../lib/useSheetLeads';
import { COST_INR, istDay, rampCap, usageByDay, type RunLogEntry } from '../lib/salesOps';

const inr = (n: number) => '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="surface-card p-4">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-100">{value}</p>
      {hint && <p className="mt-1 text-[10px] text-zinc-500">{hint}</p>}
    </div>
  );
}

/** What the automation used each day (searches, site reads, AI, email checks, sends) and a rough cost. */
export default function UsagePage() {
  const { leads, loading: leadsLoading, reload: reloadLeads } = useSheetLeads();
  const [entries, setEntries] = useState<RunLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const days = useMemo(() => usageByDay(entries, now, 14), [entries, now]);
  const ramp = useMemo(() => rampCap(leads, now), [leads, now]);
  const today = days[days.length - 1];
  const total = days.reduce((n, d) => n + d.costInr, 0);
  const todayKey = istDay(now);

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Usage & cost" subtitle="What the automation used each day and a rough cost. Costs are estimates from list prices.">
        <Button variant="outline" size="sm" onClick={() => { void load(); void reloadLeads(); }} disabled={loading || leadsLoading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </PageHeader>

      {error && <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error}</div>}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Cold-email cap today" value={String(ramp.cap)} hint={ramp.cap === 0 ? 'Stopped: 7-day bounce rate is 5% or more' : 'Ramp: 50/day, +25 each week, max 500'} />
        <Stat label="7-day bounce rate" value={ramp.bounceRate === null ? '—' : `${ramp.bounceRate}%`} hint={`${ramp.sent7d} emails in 7 days · holds at 3%, stops at 5%`} />
        <Stat label="Email checks today" value={String(today?.reoonChecked ?? 0)} hint={`${today?.reoonVerified ?? 0} verified · 20 a day are free`} />
        <Stat label="Estimated cost, 14 days" value={inr(total)} hint={`Today ${inr(today?.costInr ?? 0)}`} />
      </div>

      <div className="surface-card overflow-x-auto">
        <table className="w-full min-w-[820px] text-right text-[11px]">
          <thead className="text-zinc-500">
            <tr className="border-b border-zinc-800">
              {['Day', 'City runs', 'Places searches', 'Sites read', 'Leads added', 'Email checks', 'Verified', 'Emails sent', 'Failed', 'Est. cost'].map((h, i) => (
                <th key={h} scope="col" className={`px-3 py-2 font-medium ${i === 0 ? 'text-left' : ''}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...days].reverse().map((d) => (
              <tr key={d.day} className={`border-b border-zinc-800/60 tabular-nums ${d.day === todayKey ? 'text-zinc-100' : 'text-zinc-300'}`}>
                <td className="px-3 py-2 text-left">{d.day}</td>
                <td className="px-3 py-2">{d.cityRuns}</td>
                <td className="px-3 py-2">{d.placesRequests}</td>
                <td className="px-3 py-2">{d.sitesRead}</td>
                <td className="px-3 py-2">{d.added}</td>
                <td className="px-3 py-2">{d.reoonChecked}</td>
                <td className="px-3 py-2">{d.reoonVerified}</td>
                <td className="px-3 py-2">{d.emails}</td>
                <td className={`px-3 py-2 ${d.failed ? 'text-red-300' : ''}`}>{d.failed}</td>
                <td className="px-3 py-2">{inr(d.costInr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!entries.length && !loading && <p className="p-6 text-center text-xs text-zinc-500">No runs logged yet. Runs log here from 13 Nov 2026.</p>}
      </div>
      <p className="mt-2 text-[10px] text-zinc-600">
        Estimates per unit: Places search ₹{COST_INR.placesRequest}, site read by AI ₹{COST_INR.siteRead}, email draft ₹{COST_INR.aiDraft}, email check ₹{COST_INR.reoonCheck} after the free 20 a day, send ₹{COST_INR.email}. Places searches are estimated from results found (20 per page).
      </p>
    </div>
  );
}
