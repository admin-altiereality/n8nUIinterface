import React, { useState } from 'react';
import { HeartPulse, Link2, Loader2 } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { linkCustomer, type CustomerBlock } from '../../api/opsClient';

const BAND_VARIANT = { healthy: 'success', watch: 'warning', 'at risk': 'danger', 'not started': 'secondary' } as const;

/** Link a won school to its LearnXR product school, and show usage health and the renewal date. */
export function CustomerPanel({ orgKey, customer, canEdit, onChanged }: { orgKey: string; customer: CustomerBlock; canEdit: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renewal, setRenewal] = useState(customer.renewalAt ? new Date(customer.renewalAt).toISOString().slice(0, 10) : '');

  const save = async (key: string, change: Parameters<typeof linkCustomer>[1]) => {
    setBusy(key);
    setError(null);
    try {
      await linkCustomer(orgKey, change);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

  const h = customer.health;
  return (
    <div className="surface-card mb-6 p-4">
      <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
        <HeartPulse className="h-3.5 w-3.5 text-pink-300" /> Customer health
      </h2>
      {!customer.productAccess && (
        <p className="mb-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          The dashboard can't read LearnXR product data yet, so usage isn't shown. An admin needs to grant it access (see Admin).
        </p>
      )}
      {customer.link ? (
        <p className="mb-3 text-[11px] text-zinc-400">
          Linked to <span className="text-zinc-100">{customer.link.productSchoolName || customer.link.productSchoolId}</span> in LearnXR
          {canEdit && (
            <button type="button" className="ml-2 text-sky-400 hover:underline" onClick={() => void save('unlink', { unlink: true })}>
              unlink
            </button>
          )}
        </p>
      ) : customer.productAccess ? (
        <div className="mb-3 space-y-2">
          <p className="text-[11px] text-zinc-400">Which LearnXR school is this? Link it to see how they use the product.</p>
          {customer.suggestions.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-[11px]">
              <span className="min-w-0 truncate text-zinc-200">
                {s.name} <span className="text-zinc-500">· {s.city || '—'} · {s.reasons.join(', ')}</span>
              </span>
              {canEdit && (
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void save(s.id, { productSchoolId: s.id })}>
                  {busy === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />} Link
                </Button>
              )}
            </div>
          ))}
          {!customer.suggestions.length && <p className="text-[11px] text-zinc-500">No LearnXR school looks like this one yet.</p>}
        </div>
      ) : null}

      {h && (
        <div className="mb-3 grid grid-cols-2 gap-3 text-[11px] md:grid-cols-4">
          <div>
            <p className="text-zinc-500">Health</p>
            <p className="text-sm font-semibold text-zinc-100">
              {h.score} <Badge variant={BAND_VARIANT[h.band]}>{h.band}</Badge>
            </p>
          </div>
          <div>
            <p className="text-zinc-500">Active teachers (30 days)</p>
            <p className="text-sm font-semibold text-zinc-100">
              {h.activeTeachers} / {h.teachers}
            </p>
          </div>
          <div>
            <p className="text-zinc-500">Active students (30 days)</p>
            <p className="text-sm font-semibold text-zinc-100">
              {h.activeStudents} / {h.students}
            </p>
          </div>
          <div>
            <p className="text-zinc-500">Renewal</p>
            <p className="text-sm font-semibold text-zinc-100">{h.daysToRenewal !== null ? `in ${h.daysToRenewal} days` : '—'}</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-zinc-500">Renewal date</span>
        <Input type="date" value={renewal} onChange={(e) => setRenewal(e.target.value)} className="h-8 w-40 text-xs" disabled={!canEdit} />
        {canEdit && (
          <Button size="sm" variant="secondary" disabled={!renewal || !!busy} onClick={() => void save('renewal', { renewalAt: new Date(`${renewal}T00:00:00+05:30`).toISOString() })}>
            {busy === 'renewal' && <Loader2 className="h-3 w-3 animate-spin" />} Save
          </Button>
        )}
        <span className="text-zinc-600">Reminders go out 60, 30 and 7 days before.</span>
      </div>
      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
