import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlarmClock, Check, Loader2, MessageCircle, Phone, RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { LeadDrawer } from '../components/sales/LeadDrawer';
import { useAuth } from '../context/AuthContext';
import { fetchMetaOverview } from '../api/opsClient';
import { leadPhoneForMessaging, type SchoolLeadRow } from '../api/sheetsClient';
import {
  QUEUE_SECTIONS,
  field,
  formatDuration,
  formatInr,
  formatWhen,
  funnelConversion,
  ownerLabel,
  salesKpis,
  stageOf,
  todayQueue,
  tomorrowMorning,
  type QueueItem,
} from '../lib/pipeline';
import { useLeadUpdate } from '../lib/useLeadUpdate';
import { useSheetLeads } from '../lib/useSheetLeads';
import { useAppSettings } from '../lib/useAppSettings';

const REFRESH_MS = 60_000;

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="surface-card stat-card">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="text-[10px] text-zinc-500">{sub}</span>
    </div>
  );
}

const actionClass =
  'inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700 px-2 text-[10px] text-zinc-200 hover:bg-zinc-800/60 disabled:opacity-40';

export default function SalesHomePage() {
  const { user } = useAuth();
  const me = (user?.email || '').toLowerCase();
  const [searchParams, setSearchParams] = useSearchParams();
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const { leads, loading, error, fetchedAt, reload, replaceLead } = useSheetLeads({ refreshMs: REFRESH_MS });
  const { update, busy, error: actionError } = useLeadUpdate(replaceLead);

  // Re-anchor "now" whenever the leads change so due and overdue labels keep up with the clock.
  const now = useMemo(() => Date.now(), [leads]);
  const queue = useMemo(
    () => todayQueue(leads, { now, owner: scope === 'mine' ? me : undefined }),
    [leads, now, scope, me]
  );
  // Meta ad spend this month, for cost per demo; only roles that may read Social Ads can fetch it.
  const [metaSpend, setMetaSpend] = useState<number | null>(null);
  const canSeeAds = user?.role === 'superadmin' || user?.role === 'associate';
  useEffect(() => {
    if (!canSeeAds) return;
    fetchMetaOverview('this_month')
      .then((o) => setMetaSpend(o.spend))
      .catch(() => setMetaSpend(null)); // Meta not connected yet: keep the configured spend
  }, [canSeeAds]);
  // Target and non-Meta channel spend come from Admin → Settings.
  const settings = useAppSettings();
  const targetInr = settings?.monthlyTargetInr ?? 0;
  const otherSpend = settings ? Object.values(settings.channelSpendInr).reduce((a, b) => a + b, 0) : 0;
  const spendInr = (metaSpend ?? 0) + otherSpend;
  const kpis = useMemo(() => salesKpis(leads, { now, targetInr, spendInr }), [leads, now, targetInr, spendInr]);
  const funnel = useMemo(() => funnelConversion(leads), [leads]);
  const queueSize = QUEUE_SECTIONS.reduce((n, s) => n + queue[s.key].length, 0);

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

  const isBusy = (row: SchoolLeadRow, action: string) => busy === `${field(row, 'Lead_id')}:${action}`;

  const renderItem = (item: QueueItem) => {
    const { row } = item;
    const owner = field(row, 'Owner').toLowerCase();
    const step = field(row, 'Next_step');
    const phone = field(row, 'WhatsApp_number') || leadPhoneForMessaging(row);
    return (
      <div
        key={field(row, 'Lead_id') || field(row, 'School Name')}
        className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-800/40 p-3 sm:flex-row sm:items-center"
      >
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openDrawer(row)}>
          <p className="truncate text-xs font-medium text-zinc-100">{field(row, 'School Name') || 'Unknown school'}</p>
          <p className="truncate text-[10px] text-zinc-500">
            {field(row, 'City') || '—'} · {stageOf(row)} · {owner ? (owner === me ? 'you' : ownerLabel(owner)) : 'unclaimed'}
          </p>
          {step && <p className="mt-0.5 truncate text-[11px] text-zinc-300">{step}</p>}
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          {item.at !== null && (
            <span className={`text-[10px] ${item.overdue ? 'text-red-400' : 'text-zinc-400'}`}>
              {item.overdue ? 'Overdue · ' : ''}
              {formatWhen(item.at, now)}
            </span>
          )}
          {item.windowLeftMs !== null && (
            <Badge variant="warning" className="text-[9px]">
              {formatDuration(item.windowLeftMs)} to reply
            </Badge>
          )}
          {!owner && (
            <button
              type="button"
              className={actionClass}
              disabled={Boolean(busy)}
              onClick={() => void update(row, { fields: { Owner: 'me' } }, { Owner: me }, 'claim')}
            >
              {isBusy(row, 'claim') && <Loader2 className="h-3 w-3 animate-spin" />} Claim
            </button>
          )}
          {phone && (
            <a
              href={`tel:${phone}`}
              className={actionClass}
              onClick={() => void update(row, { touch: 'call', note: 'Called' }, {}, 'call')}
            >
              <Phone className="h-3 w-3" /> Call
            </a>
          )}
          {phone && (
            <Link to={`/twilio-messaging?contact=${encodeURIComponent(phone)}`} className={actionClass}>
              <MessageCircle className="h-3 w-3" /> WhatsApp
            </Link>
          )}
          {step && (
            <button
              type="button"
              className={actionClass}
              disabled={Boolean(busy)}
              onClick={() =>
                void update(
                  row,
                  { fields: { Next_step: '', Next_step_due: '' }, note: `Done: ${step}` },
                  { Next_step: '', Next_step_due: '' },
                  'done'
                )
              }
            >
              {isBusy(row, 'done') ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Done
            </button>
          )}
          {step && (
            <button
              type="button"
              className={actionClass}
              disabled={Boolean(busy)}
              title="Move to tomorrow 10:00"
              onClick={() => {
                const due = new Date(tomorrowMorning(Date.now())).toISOString();
                void update(row, { fields: { Next_step_due: due } }, { Next_step_due: due }, 'snooze');
              }}
            >
              <AlarmClock className="h-3 w-3" /> Snooze
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Sales Home" subtitle="Today's calls, hot leads and this month's numbers.">
        <div className="flex items-center gap-2">
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
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </PageHeader>

      {(error || actionError) && (
        <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          {actionError || error}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi
          label="Open pipeline"
          value={formatInr(kpis.openValue)}
          sub={`${kpis.openCount} deal${kpis.openCount === 1 ? '' : 's'} from Engaged to Proposal`}
        />
        <Kpi
          label="Won this month"
          value={formatInr(kpis.wonValue)}
          sub={
            kpis.targetShare !== null
              ? `${Math.round(kpis.targetShare * 100)}% of the ${formatInr(targetInr)} target`
              : `${kpis.wonCount} school${kpis.wonCount === 1 ? '' : 's'} won`
          }
        />
        <Kpi label="Demos this month" value={String(kpis.demosBooked)} sub="Booked since the 1st" />
        <Kpi
          label="Speed to lead"
          value={kpis.speedMedianMs !== null ? formatDuration(kpis.speedMedianMs) : '—'}
          sub={
            kpis.speedUnderHourShare !== null
              ? `${Math.round(kpis.speedUnderHourShare * 100)}% answered within 1 hour (${kpis.speedSample})`
              : 'Median time from a hot lead to the first call or message'
          }
        />
        <Kpi
          label="Cost per demo"
          value={kpis.costPerDemo !== null ? formatInr(kpis.costPerDemo) : '—'}
          sub={kpis.costPerDemo !== null ? 'Ad spend + channel costs this month' : 'Set monthly spend in Admin → Settings'}
        />
      </div>

      <div className="surface-card mb-6 p-4">
        <div className="flex flex-wrap items-center gap-x-1 gap-y-2 text-[11px]">
          {funnel.map((step, i) => {
            const prev = i > 0 ? funnel[i - 1].count : 0;
            return (
              <React.Fragment key={step.label}>
                {i > 0 && <span className="px-1 text-zinc-600">→</span>}
                <span className="text-zinc-400">{step.label}</span>
                <span className="font-semibold text-zinc-100">{step.count}</span>
                {i > 0 && prev > 0 && <span className="text-zinc-600">({Math.round((step.count / prev) * 100)}%)</span>}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      <div className="space-y-5">
        {QUEUE_SECTIONS.map((section) =>
          queue[section.key].length ? (
            <div key={section.key} className="surface-card p-5">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-zinc-100">
                  {section.title} <span className="text-zinc-500">({queue[section.key].length})</span>
                </h3>
                <span className="text-[10px] text-zinc-600">{section.hint}</span>
              </div>
              <div className="space-y-2">{queue[section.key].map(renderItem)}</div>
            </div>
          ) : null
        )}
        {!queueSize && (
          <div className="surface-card p-8 text-center text-xs text-zinc-500">
            {loading && !leads.length ? 'Loading leads…' : 'Nothing in the queue right now.'}
          </div>
        )}
      </div>

      {fetchedAt && (
        <p className="mt-4 text-[10px] text-zinc-600">
          {leads.length} leads · updated {new Date(fetchedAt).toLocaleTimeString()} · refreshes every minute
        </p>
      )}

      {openLead && <LeadDrawer lead={openLead} onClose={closeDrawer} onChange={replaceLead} />}
    </div>
  );
}
