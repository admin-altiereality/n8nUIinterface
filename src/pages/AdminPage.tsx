import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Save } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  fetchAdminHealth,
  fetchSettings,
  updateSettings,
  type AdminHealth,
  type AppSettings,
  type LeadSourceKey,
} from '../api/opsClient';
import { forgetAppSettings } from '../lib/useAppSettings';
import { formatWhen } from '../lib/pipeline';

const N8N_BASE = 'https://n8n.altiereality.com';

const CHANNELS: Array<{ key: LeadSourceKey; label: string }> = [
  { key: 'cold_email', label: 'Cold email (ZeptoMail, Places API)' },
  { key: 'website', label: 'Website' },
  { key: 'instagram_ad', label: 'Instagram ads (beyond Meta spend)' },
  { key: 'facebook_ad', label: 'Facebook ads (beyond Meta spend)' },
  { key: 'whatsapp', label: 'WhatsApp (Twilio)' },
  { key: 'other', label: 'Other tools' },
];

function Stat({ label, value, sub, warn }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className="surface-card stat-card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${warn ? 'text-amber-300' : ''}`}>{value}</span>
      <span className="text-[10px] text-zinc-500">{sub}</span>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-zinc-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10px] text-zinc-500">{hint}</span>}
    </label>
  );
}

const selectClass = 'h-9 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100';

export default function AdminPage() {
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [loadingHealth, setLoadingHealth] = useState(false);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [recipients, setRecipients] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const loadHealth = useCallback(async () => {
    setLoadingHealth(true);
    setHealthError(null);
    try {
      setHealth(await fetchAdminHealth());
    } catch (e) {
      setHealthError(e instanceof Error ? e.message : 'Could not load system health.');
    } finally {
      setLoadingHealth(false);
    }
  }, []);

  useEffect(() => {
    void loadHealth();
    fetchSettings()
      .then((s) => {
        setSaved(s);
        setDraft(s);
        setRecipients(s.alertRecipients.join(', '));
      })
      .catch((e) => setMessage({ text: e instanceof Error ? e.message : 'Could not load settings.', ok: false }));
  }, [loadHealth]);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = async () => {
    if (!draft || !saved) return;
    const next = { ...draft, alertRecipients: recipients.split(',').map((e) => e.trim()).filter(Boolean) };
    const patch: Partial<AppSettings> = {};
    for (const key of Object.keys(next) as Array<keyof AppSettings>) {
      if (JSON.stringify(next[key]) !== JSON.stringify(saved[key])) (patch as Record<string, unknown>)[key] = next[key];
    }
    if (!Object.keys(patch).length) return setMessage({ text: 'Nothing changed.', ok: true });
    const goingLive = (['autoActionsMode', 'welcomeMode'] as const).filter((k) => patch[k] === 'live');
    if (
      goingLive.length &&
      !window.confirm(
        `Switch ${goingLive.map((k) => (k === 'welcomeMode' ? 'WhatsApp welcome' : 'automatic WhatsApp replies')).join(' and ')} to LIVE? Real schools will receive messages.`
      )
    ) {
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await updateSettings(patch);
      setSaved(result);
      setDraft(result);
      setRecipients(result.alertRecipients.join(', '));
      forgetAppSettings();
      setMessage({ text: `Saved ${Object.keys(patch).length} setting(s).`, ok: true });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : 'Could not save settings.', ok: false });
    } finally {
      setSaving(false);
    }
  };

  const now = Date.now();
  const capUse = health?.email.sentToday != null ? `${health.email.sentToday} / ${health.email.cap}` : '—';

  return (
    <div>
      <PageHeader title="Admin" subtitle="System health and settings for the sales engine">
        <Button variant="outline" size="sm" onClick={() => void loadHealth()} disabled={loadingHealth}>
          <RefreshCw className={`h-3.5 w-3.5 ${loadingHealth ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </PageHeader>

      {healthError && (
        <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{healthError}</div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Cold emails today" value={capUse} sub="First emails + follow-ups vs. daily cap" warn={!!health && (health.email.sentToday ?? 0) >= health.email.cap} />
        <Stat
          label="WhatsApp failures"
          value={health?.whatsapp.failed24h != null ? String(health.whatsapp.failed24h) : '—'}
          sub="Failed or undelivered, last 24 h"
          warn={(health?.whatsapp.failed24h ?? 0) > 0}
        />
        <Stat
          label="WhatsApp templates"
          value={health?.whatsapp.approvedTemplates != null ? String(health.whatsapp.approvedTemplates) : '—'}
          sub="Approved in Twilio"
        />
        <Stat
          label="Meta"
          value={health ? health.meta.mode : '—'}
          sub={health?.meta.snapshotAt ? `Snapshot ${formatWhen(Date.parse(health.meta.snapshotAt), now)}` : `Ad account ${health?.meta.adAccountId || ''}`}
          warn={health?.meta.mode === 'not connected'}
        />
      </div>

      {health && !health.productAccess && (
        <div className="mb-6 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          The dashboard can't read LearnXR product data (customer health, report-download leads). A Google Cloud owner of
          learnxr-evoneuralai can allow it with:
          <code className="mt-1 block select-all rounded bg-zinc-900 px-2 py-1 text-zinc-200">
            gcloud projects add-iam-policy-binding learnxr-evoneuralai --member=serviceAccount:1074016177582-compute@developer.gserviceaccount.com --role=roles/datastore.viewer
          </code>
        </div>
      )}

      <div className="surface-card mb-6 p-4">
        <h2 className="mb-3 text-xs font-semibold text-zinc-200">Workflows</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {(health?.workflows || []).map((wf) => {
            const bad = !wf.ok || (wf.errors24h ?? 0) > 0 || wf.lastStatus === 'error';
            return (
              <div key={wf.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-[11px]">
                <div className="mb-1 flex items-center justify-between">
                  <a href={`${N8N_BASE}/workflow/${wf.id}`} target="_blank" rel="noreferrer" className="font-medium text-zinc-100 hover:underline">
                    {wf.name}
                  </a>
                  {bad ? (
                    <Badge variant="danger"><AlertTriangle className="mr-1 h-3 w-3" />{wf.ok ? `${wf.errors24h} error(s) in 24 h` : 'unreachable'}</Badge>
                  ) : (
                    <Badge variant="success"><CheckCircle2 className="mr-1 h-3 w-3" />healthy</Badge>
                  )}
                </div>
                <p className="text-zinc-500">{wf.role}</p>
                <p className="mt-1 text-zinc-400">
                  {wf.ok
                    ? `Last run ${wf.lastRunAt ? formatWhen(Date.parse(wf.lastRunAt), now) : 'never'} (${wf.lastStatus || '—'}) · ${wf.runs24h} run(s) in 24 h`
                    : wf.error}
                </p>
                {wf.lastErrorId && (
                  <a href={`${N8N_BASE}/workflow/${wf.id}/executions/${wf.lastErrorId}`} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                    Open last error
                  </a>
                )}
              </div>
            );
          })}
          {!health && !healthError && <p className="text-[11px] text-zinc-500">Checking…</p>}
        </div>
      </div>

      <div className="surface-card p-4">
        <h2 className="mb-1 text-xs font-semibold text-zinc-200">Settings</h2>
        <p className="mb-4 text-[11px] text-zinc-500">Changes apply within a minute and are recorded in the audit log.</p>
        {!draft ? (
          <p className="text-[11px] text-zinc-500">Loading…</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Targets</h3>
              <Field label="Monthly revenue target (₹)" hint="0 hides the target on Sales Home.">
                <Input type="number" min={0} value={draft.monthlyTargetInr} onChange={(e) => set('monthlyTargetInr', Number(e.target.value))} />
              </Field>
              <h3 className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Monthly spend by channel (₹)</h3>
              <p className="text-[10px] text-zinc-500">Meta ad spend is added automatically; enter other costs here for cost per lead and per demo.</p>
              <div className="grid grid-cols-2 gap-3">
                {CHANNELS.map((c) => (
                  <Field key={c.key} label={c.label}>
                    <Input
                      type="number"
                      min={0}
                      value={draft.channelSpendInr[c.key]}
                      onChange={(e) => set('channelSpendInr', { ...draft.channelSpendInr, [c.key]: Number(e.target.value) })}
                    />
                  </Field>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Sending</h3>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cold emails per day" hint="First emails + follow-ups (max 100).">
                  <Input type="number" min={0} max={100} value={draft.dailyEmailCap} onChange={(e) => set('dailyEmailCap', Number(e.target.value))} />
                </Field>
                <Field label="Of which follow-ups" hint="The rest stays free for new schools.">
                  <Input type="number" min={0} max={draft.dailyEmailCap} value={draft.followUpMax} onChange={(e) => set('followUpMax', Number(e.target.value))} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Automatic WhatsApp replies" hint="Sales • Inbound replies to brochure/pricing asks.">
                  <select className={selectClass} value={draft.autoActionsMode} onChange={(e) => set('autoActionsMode', e.target.value as 'test' | 'live')}>
                    <option value="test">Test (internal numbers only)</option>
                    <option value="live">Live</option>
                  </select>
                </Field>
                <Field label="WhatsApp welcome to new form leads" hint="Needs an approved welcome template.">
                  <select className={selectClass} value={draft.welcomeMode} onChange={(e) => set('welcomeMode', e.target.value as 'test' | 'live')}>
                    <option value="test">Test (internal numbers only)</option>
                    <option value="live">Live</option>
                  </select>
                </Field>
              </div>
              <Field label="Meta daily budget ceiling per ad set (₹)" hint="The Social page refuses budgets above this.">
                <Input type="number" min={0} value={draft.metaMaxDailyBudgetInr} onChange={(e) => set('metaMaxDailyBudgetInr', Number(e.target.value))} />
              </Field>
              <Field label="Alert recipients" hint="Comma-separated emails for hot-lead and failure alerts.">
                <Input value={recipients} onChange={(e) => setRecipients(e.target.value)} />
              </Field>
            </div>

            <div className="space-y-3 lg:col-span-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Reply templates</h3>
              <p className="text-[10px] text-zinc-500">
                Shown as quick replies in Messaging and in the lead drawer. Use {'{{name}}'} and {'{{school}}'} to fill in the contact. Free-text WhatsApp only works within 24 hours of
                the school's last message.
              </p>
              {draft.replyTemplates.map((t, i) => (
                <div key={i} className="grid gap-2 rounded-lg border border-zinc-800 p-3 md:grid-cols-[200px_1fr_auto]">
                  <Input
                    placeholder="Title"
                    value={t.title}
                    maxLength={60}
                    onChange={(e) => set('replyTemplates', draft.replyTemplates.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                  />
                  <textarea
                    placeholder="Message"
                    value={t.body}
                    maxLength={1000}
                    onChange={(e) => set('replyTemplates', draft.replyTemplates.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))}
                    className="min-h-[60px] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-100"
                  />
                  <Button variant="ghost" size="sm" onClick={() => set('replyTemplates', draft.replyTemplates.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
              {draft.replyTemplates.length < 20 && (
                <Button variant="outline" size="sm" onClick={() => set('replyTemplates', [...draft.replyTemplates, { title: '', body: '' }])}>
                  Add template
                </Button>
              )}
            </div>
          </div>
        )}
        <div className="mt-5 flex items-center justify-end gap-3">
          {message && <span className={`text-[11px] ${message.ok ? 'text-emerald-400' : 'text-red-400'}`}>{message.text}</span>}
          <Button variant="primary" size="sm" disabled={!draft || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save settings
          </Button>
        </div>
      </div>
    </div>
  );
}
