import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Heart, Loader2, MessageSquare, Pause, Play, RefreshCw, Rocket, X } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useAuth } from '../context/AuthContext';
import {
  boostMetaIgPost,
  fetchMetaCampaigns,
  fetchMetaIgPosts,
  fetchMetaOverview,
  updateMetaEntity,
  type MetaBoostResult,
  type MetaCampaign,
  type MetaIgPost,
  type MetaInsights,
  type MetaRange,
} from '../api/opsClient';
import { formatInr } from '../lib/pipeline';
import { useSheetLeads } from '../lib/useSheetLeads';

const RANGES: Array<{ value: MetaRange; label: string }> = [
  { value: 'last_7d', label: 'Last 7 days' },
  { value: 'last_28d', label: 'Last 28 days' },
  { value: 'last_90d', label: 'Last 90 days' },
  { value: 'this_month', label: 'This month' },
];

const OBJECTIVES: Record<string, string> = {
  OUTCOME_TRAFFIC: 'Visits',
  OUTCOME_ENGAGEMENT: 'Engagement',
  OUTCOME_LEADS: 'Leads',
  OUTCOME_SALES: 'Sales',
  OUTCOME_AWARENESS: 'Awareness',
};

const num = (n: number) => new Intl.NumberFormat('en-IN').format(n);

function adsManagerUrl(accountId: string, campaignId?: string) {
  const base = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${accountId}`;
  return campaignId ? `${base}&selected_campaign_ids=${campaignId}` : base;
}

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'secondary' {
  if (status === 'ACTIVE') return 'success';
  if (status === 'PAUSED' || status === 'CAMPAIGN_PAUSED' || status === 'ADSET_PAUSED') return 'warning';
  if (status.includes('DISAPPROVED') || status === 'WITH_ISSUES') return 'danger';
  return 'secondary';
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="surface-card stat-card">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="text-[10px] text-zinc-500">{sub}</span>
    </div>
  );
}

function BoostDialog({
  post,
  maxDailyBudget,
  onClose,
  onCreated,
}: {
  post: MetaIgPost;
  maxDailyBudget: number;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [goal, setGoal] = useState<'visits' | 'engagement'>('visits');
  const [dailyBudget, setDailyBudget] = useState('500');
  const [days, setDays] = useState('7');
  const [cities, setCities] = useState('');
  const [ageMin, setAgeMin] = useState('25');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MetaBoostResult | null>(null);
  const [activated, setActivated] = useState(false);

  const total = (Number(dailyBudget) || 0) * (Number(days) || 0);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await boostMetaIgPost({
        igMediaId: post.id,
        goal,
        dailyBudget: Number(dailyBudget),
        days: Number(days),
        cities: cities.split(',').map((c) => c.trim()).filter(Boolean),
        ageMin: Number(ageMin),
      });
      setResult(created);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the boost.');
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!result) return;
    if (!window.confirm(`Start spending up to ${formatInr(total)} (${formatInr(Number(dailyBudget))}/day for ${days} days)?`)) return;
    setBusy(true);
    setError(null);
    try {
      await updateMetaEntity(result.campaignId, { status: 'ACTIVE' });
      setActivated(true);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not activate the campaign.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="surface-card max-h-[90vh] w-full max-w-lg overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">Boost Instagram post</h2>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 line-clamp-3 text-[11px] text-zinc-400">{post.caption || 'No caption'}</p>

        {!result ? (
          <div className="space-y-3 text-xs">
            <label className="block">
              <span className="mb-1 block text-zinc-400">Goal</span>
              <select
                value={goal}
                onChange={(e) => setGoal(e.target.value as 'visits' | 'engagement')}
                className="h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-zinc-100"
              >
                <option value="visits">Website visits (LearnXR site)</option>
                <option value="engagement">Engagement (likes, comments, saves)</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-zinc-400">Daily budget (₹, max {num(maxDailyBudget)})</span>
                <Input type="number" min={100} max={maxDailyBudget} value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-zinc-400">Days (1–30)</span>
                <Input type="number" min={1} max={30} value={days} onChange={(e) => setDays(e.target.value)} />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-zinc-400">Cities (comma separated; empty = all India)</span>
              <Input value={cities} placeholder="Indore, Bhopal" onChange={(e) => setCities(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-zinc-400">Minimum age</span>
              <Input type="number" min={18} max={65} value={ageMin} onChange={(e) => setAgeMin(e.target.value)} />
            </label>
            <p className="text-[11px] text-zinc-500">
              Total up to {formatInr(total)}. The campaign is created <strong>paused</strong>; nothing spends until you activate it.
            </p>
            {error && <p className="text-[11px] text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void create()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
                Create paused
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-xs">
            <p className="text-zinc-300">
              Created <span className="font-medium">{result.name}</span>
              {activated ? ' and activated. Meta reviews new ads before they run.' : ' (paused).'}
            </p>
            {result.previewHtml && (
              <iframe
                title="Ad preview"
                srcDoc={result.previewHtml}
                sandbox="allow-scripts allow-same-origin"
                className="h-[520px] w-full rounded-lg border border-zinc-800 bg-white"
              />
            )}
            {error && <p className="text-[11px] text-red-400">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>{activated ? 'Done' : 'Leave paused'}</Button>
              {!activated && (
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void activate()}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Activate
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SocialAdsPage() {
  const { user } = useAuth();
  const canSpend = user?.role === 'superadmin';
  const [range, setRange] = useState<MetaRange>('last_28d');
  const [overview, setOverview] = useState<MetaInsights | null>(null);
  const [campaigns, setCampaigns] = useState<MetaCampaign[]>([]);
  const [accountId, setAccountId] = useState('');
  const [maxDailyBudget, setMaxDailyBudget] = useState(0);
  const [posts, setPosts] = useState<MetaIgPost[]>([]);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [boostPost, setBoostPost] = useState<MetaIgPost | null>(null);
  const { leads } = useSheetLeads();

  const metaLeadsInSheet = useMemo(
    () => leads.filter((row) => String(row.XR_keywords || '').includes('_lead_ad')).length,
    [leads]
  );

  const load = useCallback(
    async (fresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const [ov, list] = await Promise.all([fetchMetaOverview(range), fetchMetaCampaigns(range, fresh)]);
        setOverview(ov);
        setCampaigns(list.campaigns);
        setAccountId(list.accountId);
        setMaxDailyBudget(list.maxDailyBudget);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load Meta ads.');
      } finally {
        setLoading(false);
      }
    },
    [range]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetchMetaIgPosts()
      .then(setPosts)
      .catch((e) => setPostsError(e instanceof Error ? e.message : 'Could not load Instagram posts.'));
  }, []);

  const toggle = async (id: string, name: string, status: string) => {
    const next = status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    if (!window.confirm(`${next === 'ACTIVE' ? 'Resume' : 'Pause'} "${name}"?`)) return;
    setBusyId(id);
    try {
      await updateMetaEntity(id, { status: next });
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Meta did not accept the change.');
    } finally {
      setBusyId(null);
    }
  };

  const editBudget = async (id: string, name: string, current: number | null) => {
    const input = window.prompt(`New daily budget for "${name}" in ₹ (max ${num(maxDailyBudget)}):`, current ? String(current) : '');
    if (input === null) return;
    const value = Number(input);
    if (!Number.isFinite(value) || value <= 0) return setError('Enter a positive number of rupees.');
    setBusyId(id);
    try {
      await updateMetaEntity(id, { dailyBudget: value });
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Meta did not accept the change.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <PageHeader title="Social Ads" subtitle="Instagram and Facebook campaigns for the Altie Reality Page">
        <div className="flex items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as MetaRange)}
            className="h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-100"
            aria-label="Date range"
          >
            {RANGES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          {accountId && (
            <a href={adsManagerUrl(accountId)} target="_blank" rel="noreferrer" className="text-[11px] text-sky-400 hover:underline">
              Ads Manager <ExternalLink className="inline h-3 w-3" />
            </a>
          )}
        </div>
      </PageHeader>

      {error && (
        <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error}</div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-6">
        <Kpi label="Spend" value={overview ? formatInr(overview.spend) : '—'} sub={RANGES.find((r) => r.value === range)?.label || ''} />
        <Kpi label="Reach" value={overview ? num(overview.reach) : '—'} sub="People who saw an ad" />
        <Kpi label="Clicks" value={overview ? num(overview.clicks) : '—'} sub={overview?.impressions ? `${((overview.clicks / overview.impressions) * 100).toFixed(2)}% of impressions` : 'All clicks'} />
        <Kpi label="Leads" value={overview ? num(overview.leads) : '—'} sub="Lead forms and site leads" />
        <Kpi label="Cost per lead" value={overview?.costPerLead != null ? formatInr(overview.costPerLead) : '—'} sub="Spend ÷ leads" />
        <Kpi label="Meta leads in sheet" value={num(metaLeadsInSheet)} sub="All time; open them in Pipeline" />
      </div>

      <div className="surface-card mb-6 overflow-x-auto p-4">
        <h2 className="mb-3 text-xs font-semibold text-zinc-200">Campaigns</h2>
        <table className="w-full min-w-[760px] text-left text-[11px]">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-2 pr-3 font-medium">Campaign / ad set</th>
              <th className="py-2 pr-3 font-medium">Goal</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 font-medium">Daily budget</th>
              <th className="py-2 pr-3 text-right font-medium">Spend</th>
              <th className="py-2 pr-3 text-right font-medium">Clicks</th>
              <th className="py-2 pr-3 text-right font-medium">Leads</th>
              <th className="py-2 pr-3 text-right font-medium">CPL</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <React.Fragment key={c.id}>
                <tr className="border-t border-zinc-800 text-zinc-200">
                  <td className="py-2 pr-3">
                    <a href={adsManagerUrl(accountId, c.id)} target="_blank" rel="noreferrer" className="hover:underline">{c.name}</a>
                  </td>
                  <td className="py-2 pr-3 text-zinc-400">{OBJECTIVES[c.objective] || c.objective}</td>
                  <td className="py-2 pr-3"><Badge variant={statusVariant(c.effectiveStatus)}>{c.effectiveStatus.toLowerCase().replace(/_/g, ' ')}</Badge></td>
                  <td className="py-2 pr-3 text-zinc-400">{c.dailyBudget ? formatInr(c.dailyBudget) : c.lifetimeBudget ? `${formatInr(c.lifetimeBudget)} total` : 'per ad set'}</td>
                  <td className="py-2 pr-3 text-right">{formatInr(c.insights.spend)}</td>
                  <td className="py-2 pr-3 text-right">{num(c.insights.clicks)}</td>
                  <td className="py-2 pr-3 text-right">{num(c.insights.leads)}</td>
                  <td className="py-2 pr-3 text-right">{c.insights.costPerLead != null ? formatInr(c.insights.costPerLead) : '—'}</td>
                  <td className="py-2 text-right">
                    {canSpend && (c.status === 'ACTIVE' || c.status === 'PAUSED') && (
                      <Button variant="ghost" size="sm" disabled={busyId === c.id} onClick={() => void toggle(c.id, c.name, c.status)}>
                        {c.status === 'ACTIVE' ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        {c.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                      </Button>
                    )}
                  </td>
                </tr>
                {c.adsets.map((s) => (
                  <tr key={s.id} className="text-zinc-400">
                    <td className="py-1.5 pl-4 pr-3">↳ {s.name}</td>
                    <td />
                    <td className="py-1.5 pr-3"><Badge variant={statusVariant(s.effectiveStatus)}>{s.effectiveStatus.toLowerCase().replace(/_/g, ' ')}</Badge></td>
                    <td className="py-1.5 pr-3">
                      {s.dailyBudget ? formatInr(s.dailyBudget) : '—'}
                      {canSpend && s.dailyBudget !== null && (
                        <button
                          type="button"
                          className="ml-2 text-sky-400 hover:underline disabled:opacity-50"
                          disabled={busyId === s.id}
                          onClick={() => void editBudget(s.id, s.name, s.dailyBudget)}
                        >
                          edit
                        </button>
                      )}
                    </td>
                    <td colSpan={5} />
                  </tr>
                ))}
              </React.Fragment>
            ))}
            {!campaigns.length && (
              <tr>
                <td colSpan={9} className="py-6 text-center text-zinc-500">{loading ? 'Loading…' : 'No campaigns yet.'}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="surface-card p-4">
        <h2 className="mb-3 text-xs font-semibold text-zinc-200">Instagram posts</h2>
        {postsError && <p className="text-[11px] text-amber-300">{postsError}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {posts.map((p) => (
            <div key={p.id} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/60">
              <a href={p.permalink} target="_blank" rel="noreferrer">
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt={p.caption.slice(0, 80) || 'Instagram post'} className="aspect-square w-full object-cover" loading="lazy" />
                ) : (
                  <div className="aspect-square w-full bg-zinc-800" />
                )}
              </a>
              <div className="flex items-center justify-between px-2 py-1.5 text-[10px] text-zinc-400">
                <span className="flex items-center gap-2">
                  <span className="flex items-center gap-0.5"><Heart className="h-3 w-3" />{num(p.likes)}</span>
                  <span className="flex items-center gap-0.5"><MessageSquare className="h-3 w-3" />{num(p.comments)}</span>
                </span>
                {canSpend && (
                  <button type="button" className="text-sky-400 hover:underline" onClick={() => setBoostPost(p)}>Boost</button>
                )}
              </div>
            </div>
          ))}
          {!posts.length && !postsError && <p className="col-span-full py-4 text-center text-[11px] text-zinc-500">Loading posts…</p>}
        </div>
      </div>

      {boostPost && (
        <BoostDialog
          post={boostPost}
          maxDailyBudget={maxDailyBudget}
          onClose={() => setBoostPost(null)}
          onCreated={() => void load(true)}
        />
      )}
    </div>
  );
}
