import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useAuth } from '../context/AuthContext';
import { fetchPricing, savePricing, type PricePlan, type Pricing } from '../api/opsClient';
import { formatWhen } from '../lib/pipeline';

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const priceText = (p: PricePlan) =>
  !p.priceInr && !p.priceMaxInr ? '—' : p.priceMaxInr ? `${inr(p.priceInr)}–${inr(p.priceMaxInr)}` : inr(p.priceInr);
const withGst = (n: number, gst: number) => inr(Math.round(n * (1 + gst / 100)));

const NEW_PLAN: PricePlan = { id: '', name: '', includes: '', priceInr: 0, priceMaxInr: 0, unit: 'one-time', notes: '', agentCanShare: false };

/** A small text cell for edit mode. */
function Cell({ value, onChange, width = 'w-full', type = 'text' }: { value: string | number; onChange: (v: string) => void; width?: string; type?: string }) {
  return <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} className={`h-7 text-[11px] ${width}`} />;
}

export default function PricingPage() {
  const { user } = useAuth();
  const canEdit = user?.role === 'superadmin';
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [draft, setDraft] = useState<Pricing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setError(null);
    fetchPricing().then(setPricing).catch((e) => setError(e instanceof Error ? e.message : 'Could not load pricing.'));
  }, []);
  useEffect(load, [load]);

  const shown = draft || pricing;
  const edit = <K extends keyof Pricing>(key: K, value: Pricing[K]) => draft && setDraft({ ...draft, [key]: value });
  const editRow = <K extends 'plans' | 'partnerMargins' | 'competitors'>(key: K, i: number, patch: Partial<Pricing[K][number]>) =>
    draft && edit(key, draft[key].map((row, j) => (j === i ? { ...row, ...patch } : row)) as Pricing[K]);
  const removeRow = (key: 'plans' | 'partnerMargins' | 'competitors', i: number) =>
    draft && edit(key, draft[key].filter((_, j) => j !== i) as never);

  const onSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const { updatedAt: _a, updatedBy: _b, ...body } = draft;
      setPricing(await savePricing(body));
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save pricing.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Pricing" subtitle="LearnXR plans, partner margins and what competitors charge. Prices exclude GST.">
        {canEdit && shown && (
          <div className="flex items-center gap-2">
            {draft ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setDraft(null)} disabled={saving}>
                  <X className="h-3.5 w-3.5" /> Cancel
                </Button>
                <Button size="sm" onClick={() => void onSave()} disabled={saving}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setDraft(structuredClone(shown))}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            )}
          </div>
        )}
      </PageHeader>

      {error && <div className="mb-4 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{error}</div>}
      {!shown && !error && <div className="surface-card p-6 text-center text-xs text-zinc-500">Loading pricing…</div>}

      {shown && (
        <div className="space-y-6">
          <section className="surface-card p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-zinc-100">LearnXR plans</h2>
              <span className="text-[10px] text-zinc-500">
                GST{' '}
                {draft ? <Cell value={draft.gstPercent} type="number" width="w-14 inline-block" onChange={(v) => edit('gstPercent', Number(v))} /> : `${shown.gstPercent}%`}{' '}
                extra · <Badge variant="outline">AI can say</Badge> = the calling agent may mention its starting price
              </span>
            </div>
            {!shown.plans.length && <p className="text-[11px] text-zinc-500">No plans yet.</p>}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="py-1.5 pr-3">Plan</th>
                    <th className="py-1.5 pr-3">Includes</th>
                    <th className="py-1.5 pr-3">Price</th>
                    <th className="py-1.5 pr-3">With GST</th>
                    <th className="py-1.5 pr-3">Notes</th>
                    {draft && <th />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 align-top text-zinc-300">
                  {shown.plans.map((p, i) =>
                    draft ? (
                      <tr key={i}>
                        <td className="py-1.5 pr-2 w-40"><Cell value={p.name} onChange={(v) => editRow('plans', i, { name: v })} /></td>
                        <td className="py-1.5 pr-2"><Cell value={p.includes} onChange={(v) => editRow('plans', i, { includes: v })} /></td>
                        <td className="py-1.5 pr-2 w-64">
                          <div className="flex gap-1">
                            <Cell type="number" value={p.priceInr} onChange={(v) => editRow('plans', i, { priceInr: Number(v) })} />
                            <Cell type="number" value={p.priceMaxInr} onChange={(v) => editRow('plans', i, { priceMaxInr: Number(v) })} />
                            <Cell value={p.unit} onChange={(v) => editRow('plans', i, { unit: v })} />
                          </div>
                        </td>
                        <td className="py-1.5 pr-2">
                          <label className="flex items-center gap-1 text-[10px] text-zinc-400">
                            <input type="checkbox" checked={p.agentCanShare} onChange={(e) => editRow('plans', i, { agentCanShare: e.target.checked })} />
                            AI can say
                          </label>
                        </td>
                        <td className="py-1.5 pr-2"><Cell value={p.notes} onChange={(v) => editRow('plans', i, { notes: v })} /></td>
                        <td className="py-1.5"><button type="button" onClick={() => removeRow('plans', i)} className="text-zinc-500 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button></td>
                      </tr>
                    ) : (
                      <tr key={p.id}>
                        <td className="py-2 pr-3 font-medium text-zinc-100">
                          {p.name}
                          {p.agentCanShare && <Badge variant="outline" className="ml-1.5">AI can say</Badge>}
                        </td>
                        <td className="py-2 pr-3 text-zinc-400">{p.includes}</td>
                        <td className="py-2 pr-3 whitespace-nowrap text-zinc-100">
                          {priceText(p)} <span className="text-zinc-500">{p.unit}</span>
                        </td>
                        <td className="py-2 pr-3 whitespace-nowrap text-zinc-500">
                          {p.priceInr ? withGst(p.priceInr, shown.gstPercent) : '—'}
                          {p.priceMaxInr ? `–${withGst(p.priceMaxInr, shown.gstPercent)}` : ''}
                        </td>
                        <td className="py-2 pr-3 text-zinc-500">{p.notes}</td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
            {draft && (
              <button type="button" onClick={() => edit('plans', [...draft.plans, { ...NEW_PLAN }])} className="mt-2 flex items-center gap-1 text-[11px] text-sky-400 hover:underline">
                <Plus className="h-3 w-3" /> Add plan
              </button>
            )}
          </section>

          <section className="surface-card p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-100">Channel partner margins</h2>
            {!shown.partnerMargins.length && <p className="text-[11px] text-zinc-500">No margins set.</p>}
            <ul className="space-y-1.5 text-[11px] text-zinc-300">
              {shown.partnerMargins.map((m, i) =>
                draft ? (
                  <li key={i} className="flex gap-2">
                    <Cell value={m.label} width="w-56" onChange={(v) => editRow('partnerMargins', i, { label: v })} />
                    <Cell type="number" value={m.percent} width="w-20" onChange={(v) => editRow('partnerMargins', i, { percent: Number(v) })} />
                    <Cell value={m.notes} onChange={(v) => editRow('partnerMargins', i, { notes: v })} />
                    <button type="button" onClick={() => removeRow('partnerMargins', i)} className="text-zinc-500 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                  </li>
                ) : (
                  <li key={i}>
                    <span className="font-medium text-zinc-100">{m.percent}%</span> {m.label}
                    {m.notes && <span className="text-zinc-500"> · {m.notes}</span>}
                  </li>
                )
              )}
            </ul>
            {draft && (
              <button type="button" onClick={() => edit('partnerMargins', [...draft.partnerMargins, { label: '', percent: 0, notes: '' }])} className="mt-2 flex items-center gap-1 text-[11px] text-sky-400 hover:underline">
                <Plus className="h-3 w-3" /> Add margin
              </button>
            )}
            <p className="mt-3 text-[10px] text-zinc-500">The calling agent never mentions margins; they are shared with partners by the team.</p>
          </section>

          <section className="surface-card p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-100">What competitors charge</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px]">
                <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="py-1.5 pr-3">Who</th>
                    <th className="py-1.5 pr-3">Offer</th>
                    <th className="py-1.5 pr-3">Price</th>
                    <th className="py-1.5 pr-3">Source</th>
                    {draft && <th />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 align-top text-zinc-300">
                  {shown.competitors.map((c, i) =>
                    draft ? (
                      <tr key={i}>
                        <td className="py-1.5 pr-2 w-32"><Cell value={c.name} onChange={(v) => editRow('competitors', i, { name: v })} /></td>
                        <td className="py-1.5 pr-2"><Cell value={c.offer} onChange={(v) => editRow('competitors', i, { offer: v })} /></td>
                        <td className="py-1.5 pr-2 w-40"><Cell value={c.price} onChange={(v) => editRow('competitors', i, { price: v })} /></td>
                        <td className="py-1.5 pr-2">
                          <div className="flex gap-1">
                            <Cell value={c.source} onChange={(v) => editRow('competitors', i, { source: v })} />
                            <Cell value={c.asOf} width="w-24" onChange={(v) => editRow('competitors', i, { asOf: v })} />
                          </div>
                        </td>
                        <td className="py-1.5"><button type="button" onClick={() => removeRow('competitors', i)} className="text-zinc-500 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button></td>
                      </tr>
                    ) : (
                      <tr key={i}>
                        <td className="py-2 pr-3 font-medium text-zinc-100">{c.name}</td>
                        <td className="py-2 pr-3 text-zinc-400">{c.offer}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{c.price}</td>
                        <td className="py-2 pr-3 text-zinc-500">
                          {c.source && (
                            <a href={c.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-400 hover:underline">
                              link <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                          {c.asOf && ` · ${c.asOf}`}
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
            {draft && (
              <button type="button" onClick={() => edit('competitors', [...draft.competitors, { name: '', offer: '', price: '', source: '', asOf: '' }])} className="mt-2 flex items-center gap-1 text-[11px] text-sky-400 hover:underline">
                <Plus className="h-3 w-3" /> Add competitor
              </button>
            )}
          </section>

          <p className="text-[10px] text-zinc-500">
            {shown.updatedAt ? `Last changed ${formatWhen(Date.parse(shown.updatedAt))} by ${shown.updatedBy || 'unknown'}.` : 'Not saved yet.'} A copy is kept in the
            “Pricing” tab of the leads sheet.
          </p>
        </div>
      )}
    </div>
  );
}
