import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, RefreshCw, Trophy } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { fetchLeaderboard, type RepStats, type SlaBreach } from '../api/opsClient';
import { formatDuration, formatInr, ownerLabel } from '../lib/pipeline';

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

export default function TeamPage() {
  const [days, setDays] = useState(7);
  const [reps, setReps] = useState<RepStats[]>([]);
  const [breaches, setBreaches] = useState<SlaBreach[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLeaderboard(days);
      setReps(data.reps);
      setBreaches(data.slaBreaches);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the leaderboard.');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Team" subtitle="Who is working which leads, and how fast hot leads hear from us.">
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-zinc-700 p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => setDays(p.days)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${days === p.days ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </PageHeader>

      {error && <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error}</div>}

      <div className="surface-card mb-6 overflow-x-auto p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
          <Trophy className="h-3.5 w-3.5 text-amber-300" /> Leaderboard
        </h2>
        <table className="w-full min-w-[640px] text-left text-[11px]">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Rep</th>
              <th className="py-1.5 pr-3 text-right font-medium">Won</th>
              <th className="py-1.5 pr-3 text-right font-medium">₹ won</th>
              <th className="py-1.5 pr-3 text-right font-medium">Demos booked</th>
              <th className="py-1.5 pr-3 text-right font-medium">Calls</th>
              <th className="py-1.5 pr-3 text-right font-medium">All touches</th>
              <th className="py-1.5 pr-3 text-right font-medium">Open deals</th>
              <th className="py-1.5 text-right font-medium">Speed to lead</th>
            </tr>
          </thead>
          <tbody>
            {reps.map((r, i) => (
              <tr key={r.rep} className="border-t border-zinc-800 text-zinc-200">
                <td className="py-1.5 pr-3">
                  {i === 0 && (r.won || r.demos) ? '🏆 ' : ''}
                  {ownerLabel(r.rep)}
                </td>
                <td className="py-1.5 pr-3 text-right">{r.won}</td>
                <td className="py-1.5 pr-3 text-right">{r.wonInr ? formatInr(r.wonInr) : '—'}</td>
                <td className="py-1.5 pr-3 text-right">{r.demos}</td>
                <td className="py-1.5 pr-3 text-right">{r.calls}</td>
                <td className="py-1.5 pr-3 text-right">{r.touches}</td>
                <td className="py-1.5 pr-3 text-right">{r.openDeals}</td>
                <td className="py-1.5 text-right">{r.speedMedianMs !== null ? formatDuration(r.speedMedianMs) : '—'}</td>
              </tr>
            ))}
            {!reps.length && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-zinc-500">
                  {loading ? 'Loading…' : 'No logged activity in this period. Claim leads and log calls in the lead drawer to show up here.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="mt-2 text-[10px] text-zinc-600">
          Won, ₹ and demos count deals owned by the rep. Calls and touches count what they logged. Speed to lead is the median time from a lead turning hot to the
          first call or message.
        </p>
      </div>

      <div className="surface-card p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-300" /> Hot leads waiting for a first call ({breaches.length})
        </h2>
        <p className="mb-3 text-[10px] text-zinc-500">
          Counted in business hours (Mon–Sat, 10:00–19:00). The owner gets an alert after 1 hour and the manager after 4. Calling or messaging from the lead drawer
          clears it.
        </p>
        <div className="space-y-2">
          {breaches.map((b) => (
            <Link
              key={b.leadId}
              to={`/sales?lead=${encodeURIComponent(b.leadId)}`}
              className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-[11px] hover:border-zinc-700"
            >
              <span className="truncate text-zinc-100">{b.school}</span>
              <span className="flex items-center gap-2 text-zinc-400">
                {b.owner ? ownerLabel(b.owner) : 'unclaimed'}
                <Badge variant={b.level === 'manager' ? 'danger' : 'warning'}>{formatDuration(b.waitingMs)} waiting</Badge>
              </span>
            </Link>
          ))}
          {!breaches.length && !loading && <p className="text-[11px] text-emerald-400">Every hot lead has been contacted.</p>}
        </div>
      </div>
    </div>
  );
}
