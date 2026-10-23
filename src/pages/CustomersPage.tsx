import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { fetchCustomers, type Customer } from '../api/opsClient';
import { formatInr, formatWhen, ownerLabel } from '../lib/pipeline';

const BAND_VARIANT = { healthy: 'success', watch: 'warning', 'at risk': 'danger', 'not started': 'secondary' } as const;

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCustomers(await fetchCustomers());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load customers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const noAccess = customers.some((c) => !c.productAccess);
  const now = Date.now();
  // Riskiest first: at risk, then soonest renewal.
  const order = { 'at risk': 0, watch: 1, 'not started': 2, healthy: 3 } as const;
  const sorted = [...customers].sort(
    (a, b) => (a.health ? order[a.health.band] : 2) - (b.health ? order[b.health.band] : 2) || (a.renewalAt ?? Infinity) - (b.renewalAt ?? Infinity)
  );

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Customers" subtitle="Schools that bought LearnXR: how actively they use it and when they renew.">
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </PageHeader>

      {error && <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error}</div>}
      {noAccess && (
        <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          Usage isn't shown yet: the dashboard needs read access to LearnXR product data (Admin shows how).
        </div>
      )}

      <div className="surface-card overflow-x-auto p-4">
        <table className="w-full min-w-[720px] text-left text-[11px]">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-1.5 pr-3 font-medium">School</th>
              <th className="py-1.5 pr-3 font-medium">Won</th>
              <th className="py-1.5 pr-3 text-right font-medium">Value</th>
              <th className="py-1.5 pr-3 font-medium">Owner</th>
              <th className="py-1.5 pr-3 font-medium">Health</th>
              <th className="py-1.5 pr-3 text-right font-medium">Active teachers</th>
              <th className="py-1.5 pr-3 text-right font-medium">Active students</th>
              <th className="py-1.5 font-medium">Renews</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.orgKey} className="border-t border-zinc-800 text-zinc-200">
                <td className="py-1.5 pr-3">
                  <Link to={`/schools/${encodeURIComponent(c.orgKey)}`} className="hover:underline">
                    {c.name || c.orgKey}
                  </Link>
                  <span className="text-zinc-500"> · {c.city || '—'}</span>
                  {!c.link && c.productAccess && <span className="ml-1 text-amber-400">· not linked</span>}
                </td>
                <td className="py-1.5 pr-3 text-zinc-400">{c.wonAt ? formatWhen(Date.parse(c.wonAt), now) : '—'}</td>
                <td className="py-1.5 pr-3 text-right">{c.value ? formatInr(c.value) : '—'}</td>
                <td className="py-1.5 pr-3 text-zinc-400">{c.owner ? ownerLabel(c.owner.toLowerCase()) : '—'}</td>
                <td className="py-1.5 pr-3">{c.health ? <Badge variant={BAND_VARIANT[c.health.band]}>{c.health.score} · {c.health.band}</Badge> : '—'}</td>
                <td className="py-1.5 pr-3 text-right">{c.health ? `${c.health.activeTeachers} / ${c.health.teachers}` : '—'}</td>
                <td className="py-1.5 pr-3 text-right">{c.health ? `${c.health.activeStudents} / ${c.health.students}` : '—'}</td>
                <td className="py-1.5">{c.renewalAt ? new Date(c.renewalAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>
              </tr>
            ))}
            {!sorted.length && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-zinc-500">
                  {loading ? 'Loading…' : 'No won schools yet. Mark a deal Won in the lead drawer and it shows up here.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
