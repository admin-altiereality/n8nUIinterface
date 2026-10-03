import React, { useEffect, useMemo, useState } from 'react';
import type { SchoolLeadRow } from '../../api/sheetsClient';
import { fetchMetaOverview, type AppSettings, type MetaRange } from '../../api/opsClient';
import { DAY_MS, SOURCE_LABELS, channelRoi, formatInr, istMonthStart, type LeadSource } from '../../lib/pipeline';

type Period = { key: 'this_month' | 'last_month' | 'last_90d'; label: string; meta: MetaRange; months: number };

const PERIODS: Period[] = [
  { key: 'this_month', label: 'This month', meta: 'this_month', months: 1 },
  { key: 'last_month', label: 'Last month', meta: 'last_month', months: 1 },
  { key: 'last_90d', label: 'Last 90 days', meta: 'last_90d', months: 3 },
];

function windowFor(period: Period['key'], now: number): { from: number; to: number } {
  const monthStart = istMonthStart(now);
  if (period === 'this_month') return { from: monthStart, to: now + 1 };
  if (period === 'last_month') return { from: istMonthStart(monthStart - DAY_MS), to: monthStart };
  return { from: now - 90 * DAY_MS, to: now + 1 };
}

const money = (n: number | null) => (n === null ? '—' : formatInr(n));

/**
 * Leads → engaged → demos → won per source, with what each channel cost: Meta ad spend (split between Instagram and
 * Facebook by their share of leads) plus the monthly channel costs from Admin → Settings.
 */
export function ChannelRoiTable({ leads, settings, canSeeAds }: { leads: SchoolLeadRow[]; settings: AppSettings | null; canSeeAds: boolean }) {
  const [period, setPeriod] = useState<Period['key']>('this_month');
  const [metaSpend, setMetaSpend] = useState<number>(0);
  const p = PERIODS.find((x) => x.key === period)!;

  useEffect(() => {
    if (!canSeeAds) return;
    let alive = true;
    fetchMetaOverview(p.meta)
      .then((o) => alive && setMetaSpend(o.spend || 0))
      .catch(() => alive && setMetaSpend(0));
    return () => {
      alive = false;
    };
  }, [canSeeAds, p.meta]);

  const rows = useMemo(() => {
    const now = Date.now();
    const { from, to } = windowFor(period, now);
    const spend: Partial<Record<LeadSource, number>> = {};
    const monthly = settings?.channelSpendInr;
    for (const source of Object.keys(SOURCE_LABELS) as LeadSource[]) {
      spend[source] = (monthly?.[source] || 0) * p.months;
    }
    // Split Meta spend between Instagram and Facebook by leads; with no leads yet, it all counts as Instagram.
    const first = channelRoi(leads, { from, to, spendBySource: spend });
    const ig = first.find((r) => r.source === 'instagram_ad')!.leads;
    const fb = first.find((r) => r.source === 'facebook_ad')!.leads;
    const igShare = ig + fb > 0 ? ig / (ig + fb) : 1;
    spend.instagram_ad = (spend.instagram_ad || 0) + metaSpend * igShare;
    spend.facebook_ad = (spend.facebook_ad || 0) + metaSpend * (1 - igShare);
    return channelRoi(leads, { from, to, spendBySource: spend });
  }, [leads, settings, period, p.months, metaSpend]);

  const total = rows.reduce(
    (t, r) => ({ leads: t.leads + r.leads, engaged: t.engaged + r.engaged, demos: t.demos + r.demos, won: t.won + r.won, wonInr: t.wonInr + r.wonInr, spend: t.spend + r.spendInr }),
    { leads: 0, engaged: 0, demos: 0, won: 0, wonInr: 0, spend: 0 }
  );

  return (
    <div className="surface-card mb-6 overflow-x-auto p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-100">Channels</h3>
        <div className="flex rounded-lg border border-zinc-700 p-0.5">
          {PERIODS.map((x) => (
            <button
              key={x.key}
              type="button"
              onClick={() => setPeriod(x.key)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${period === x.key ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <table className="w-full min-w-[720px] text-left text-[11px]">
        <thead className="text-zinc-500">
          <tr>
            <th className="py-1.5 pr-3 font-medium">Source</th>
            <th className="py-1.5 pr-3 text-right font-medium">New leads</th>
            <th className="py-1.5 pr-3 text-right font-medium">Engaged</th>
            <th className="py-1.5 pr-3 text-right font-medium">Demos</th>
            <th className="py-1.5 pr-3 text-right font-medium">Won</th>
            <th className="py-1.5 pr-3 text-right font-medium">₹ won</th>
            <th className="py-1.5 pr-3 text-right font-medium">Spend</th>
            <th className="py-1.5 pr-3 text-right font-medium">Per lead</th>
            <th className="py-1.5 pr-3 text-right font-medium">Per demo</th>
            <th className="py-1.5 text-right font-medium">Per deal</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source} className="border-t border-zinc-800 text-zinc-200">
              <td className="py-1.5 pr-3">{SOURCE_LABELS[r.source]}</td>
              <td className="py-1.5 pr-3 text-right">{r.leads}</td>
              <td className="py-1.5 pr-3 text-right">{r.engaged}</td>
              <td className="py-1.5 pr-3 text-right">{r.demos}</td>
              <td className="py-1.5 pr-3 text-right">{r.won}</td>
              <td className="py-1.5 pr-3 text-right">{r.wonInr ? formatInr(r.wonInr) : '—'}</td>
              <td className="py-1.5 pr-3 text-right text-zinc-400">{r.spendInr ? formatInr(r.spendInr) : '—'}</td>
              <td className="py-1.5 pr-3 text-right">{money(r.costPerLead)}</td>
              <td className="py-1.5 pr-3 text-right">{money(r.costPerDemo)}</td>
              <td className="py-1.5 text-right">{money(r.costPerDeal)}</td>
            </tr>
          ))}
          <tr className="border-t border-zinc-700 font-medium text-zinc-100">
            <td className="py-1.5 pr-3">Total</td>
            <td className="py-1.5 pr-3 text-right">{total.leads}</td>
            <td className="py-1.5 pr-3 text-right">{total.engaged}</td>
            <td className="py-1.5 pr-3 text-right">{total.demos}</td>
            <td className="py-1.5 pr-3 text-right">{total.won}</td>
            <td className="py-1.5 pr-3 text-right">{total.wonInr ? formatInr(total.wonInr) : '—'}</td>
            <td className="py-1.5 pr-3 text-right">{total.spend ? formatInr(total.spend) : '—'}</td>
            <td colSpan={3} />
          </tr>
        </tbody>
      </table>
      {!total.spend && (
        <p className="mt-2 text-[10px] text-zinc-500">Add monthly costs per channel in Admin → Settings to see cost per lead, demo and deal.</p>
      )}
    </div>
  );
}
