import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Workflow, Cpu, Loader2, RefreshCw, Table2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select } from '../components/ui/select';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { PageHeader } from '../components/layout/PageHeader';
import {
  createSalesFunnelRunWithLogs,
  fetchRecentSalesFunnelLogs,
  fetchRecentSalesFunnelRuns,
  updateSalesFunnelRun,
  type SalesFunnelExecution,
  type SalesFunnelExecutionNode,
  type SalesFunnelExecutionNodeStatus,
  type SalesFunnelExecutionStatus,
  type SalesFunnelHistoryItem,
  type SalesFunnelLogEntry,
  type SalesRunCounts,
} from '../lib/salesFunnelRepository';
import { getCurrentAuthUser, isFirebaseConfigured } from '../lib/firebase';
import {
  canPollExecution,
  getSalesExecutionStatus,
  lastSalesExecutionsMeta,
  listSalesExecutions,
  type N8nExecution,
  type N8nExecutionListItem,
} from '../api/n8nClient';
import { leadPhoneForMessaging, type SchoolLeadRow } from '../api/sheetsClient';
import { startCityRun, type CityRunPreset } from '../api/opsClient';
import { SalesInsightsPanel } from '../components/sales/SalesInsightsPanel';
import { LeadDrawer } from '../components/sales/LeadDrawer';
import { useSheetLeads } from '../lib/useSheetLeads';

const storageKeys = {
  history: 'sales_funnel_history',
  logs: 'sales_funnel_logs',
  executions: 'sales_funnel_n8n_executions',
  latestResultText: 'sales_funnel_latest_result_text',
} as const;

/** Search presets the backend maps to Google Places queries ("CBSE schools in <city>", ...). */
const CITY_RUN_PRESETS: Array<{ value: CityRunPreset; label: string }> = [
  { value: 'cbse', label: 'CBSE schools' },
  { value: 'icse', label: 'ICSE schools' },
  { value: 'ib', label: 'IB schools' },
  { value: 'international', label: 'International schools' },
  { value: 'all', label: 'All schools' },
];

const SALES_WORKFLOW_ID =
  (import.meta.env.VITE_N8N_SALES_WORKFLOW_ID as string | undefined) || '6pBPEDzIfj8939GG';

/** Status-only polls are cheap; node counts are fetched once, when the run finishes. */
const POLL_INTERVAL_MS = 5000;
/** Stop watching a run when n8n keeps returning nothing or it hangs, so Run Pipeline never locks. */
const MAX_EMPTY_POLLS = 12;
const MAX_WATCH_MS = 20 * 60 * 1000;
const RESUME_MAX_AGE_MS = 30 * 60 * 1000;
const LEAD_SEARCH_COLUMNS = ['School Name', 'Email ID', 'City', 'Phone number', 'Stage', 'Owner', 'Whatsapp_status'];

type HeaderStatus = { text: string; kind: '' | 'ok' | 'warn' };

const LEAD_COLUMNS = [
  'School Name',
  'City',
  'Stage',
  'Owner',
  'Email ID',
  'Phone number',
  'Status',
  'Reply_Status',
  'Email_template_id',
  'Click_count',
  'Last_Clicked_Button',
  'Whatsapp_status',
  'whatsapp_sent_at',
  'Follow_up_count',
  'Next_Follow_up',
] as const;

function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function mapRunDataToNodes(exec: N8nExecution): SalesFunnelExecutionNode[] {
  const runData = exec.data?.resultData?.runData;
  if (!runData || typeof runData !== 'object') return [];

  const timeline: Array<{ name: string; firstStart: number }> = [];
  Object.entries(runData).forEach(([nodeName, runs]) => {
    const typed = runs as Array<{ startTime: number }>;
    if (!typed?.length) return;
    timeline.push({ name: nodeName, firstStart: typed[0].startTime });
  });
  timeline.sort((a, b) => a.firstStart - b.firstStart);

  let latestNode: string | null = null;
  let latestStart = -Infinity;
  Object.entries(runData).forEach(([nodeName, runs]) => {
    const typed = runs as Array<{ startTime: number }>;
    const last = typed?.[typed.length - 1];
    if (!last) return;
    if (last.startTime > latestStart) {
      latestStart = last.startTime;
      latestNode = nodeName;
    }
  });

  return timeline.map(({ name }) => {
    const runs = runData[name] as Array<{
      startTime: number;
      executionTime?: number;
      error?: { message?: string };
      data?: { main?: unknown[][] };
    }>;
    const last = runs?.[runs.length - 1];
    const itemsOut = Array.isArray(last?.data?.main?.[0]) ? last!.data!.main![0].length : 0;
    let status: SalesFunnelExecutionNodeStatus = 'success';
    if (last?.error) status = 'error';
    else if (latestNode === name && exec.status === 'running' && !exec.finished) status = 'running';
    else if (exec.status === 'error' && latestNode === name) status = 'error';
    return {
      name,
      status,
      executionTime: typeof last?.executionTime === 'number' ? Math.round(last.executionTime) : 0,
      itemsInput: 1,
      itemsOutput: itemsOut,
    };
  });
}

function cell(row: SchoolLeadRow, key: string): string {
  const v = row[key];
  if (v == null) return '';
  return String(v);
}

/** The v3 scraper records its numbers on the execution (custom data); undefined for runs that don't. */
function countsFrom(exec: N8nExecution | null): SalesRunCounts | undefined {
  const data = exec?.customData;
  if (!data || data.found === undefined) return undefined;
  const num = (value?: string) => Number(value) || 0;
  return {
    found: num(data.unique ?? data.found),
    added: num(data.added),
    emailed: num(data.emailed),
    emailFailed: num(data.email_failed),
  };
}

/** What a funnel run did (known once the run has been watched or inspected). */
function runSummary(run: SalesFunnelExecution) {
  if (run.counts) {
    const { found, added, emailed, emailFailed } = run.counts;
    return { found, added, emailed, sendFailures: emailFailed > 0 };
  }
  // Runs of the old funnel workflow: read its node outputs.
  const output = (name: string) => run.nodes.find((n) => n.name === name)?.itemsOutput;
  return {
    found: output('Split Out'),
    added: output('Append or update row in sheet'),
    emailed: output('Send Mail'),
    sendFailures: run.nodes.some((n) => n.name === 'Summarize Send Failures'),
  };
}

export default function SalesFunnelPage() {
  const [city, setCity] = useState<string>('');
  const [preset, setPreset] = useState<CityRunPreset>('cbse');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [resultText, setResultText] = useState<string>(
    () => localStorage.getItem(storageKeys.latestResultText) || 'No submission yet.'
  );
  const [status, setStatus] = useState<HeaderStatus>({ text: 'Ready', kind: '' });

  const [history, setHistory] = useState<SalesFunnelHistoryItem[]>(() =>
    readJsonStorage(storageKeys.history, [])
  );
  const [logs, setLogs] = useState<SalesFunnelLogEntry[]>(() => readJsonStorage(storageKeys.logs, []));
  const [executions, setExecutions] = useState<SalesFunnelExecution[]>(() =>
    readJsonStorage(storageKeys.executions, [])
  );

  const [pollingExecutionId, setPollingExecutionId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [recentN8n, setRecentN8n] = useState<N8nExecutionListItem[]>([]);
  const [lastFollowUpRun, setLastFollowUpRun] = useState<N8nExecutionListItem | null>(null);
  const [recentN8nLoading, setRecentN8nLoading] = useState(false);
  const [recentN8nError, setRecentN8nError] = useState<string | null>(null);
  const [recentN8nSource, setRecentN8nSource] = useState<'n8n' | 'firestore' | 'unknown'>('unknown');
  const [selectedN8nId, setSelectedN8nId] = useState<string | null>(null);

  const {
    leads,
    loading: leadsLoading,
    error: leadsError,
    fetchedAt: leadsFetchedAt,
    reload: loadLeads,
    replaceLead,
  } = useSheetLeads();
  const [leadQuery, setLeadQuery] = useState('');
  const [leadCity, setLeadCity] = useState('');
  const [leadStageFilter, setLeadStageFilter] = useState('');
  const [selectedLead, setSelectedLead] = useState<SchoolLeadRow | null>(null);

  const scrollAnchorRef = useRef<HTMLDetailsElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firebaseEnabled = useMemo(() => isFirebaseConfigured(), []);

  const latestRun = executions[0];
  const latestSummary = latestRun ? runSummary(latestRun) : null;
  // n8n has the real outcome; a run recorded here can carry a stale status from when polling failed.
  const latestStatus =
    (latestRun?.n8nExecutionId && recentN8n.find((item) => item.id === latestRun.n8nExecutionId)?.status) ||
    latestRun?.status;

  const persistHistory = (items: SalesFunnelHistoryItem[]) => {
    const next = items.slice(0, 25);
    setHistory(next);
    localStorage.setItem(storageKeys.history, JSON.stringify(next));
  };
  const persistLogs = (items: SalesFunnelLogEntry[]) => {
    const next = items.slice(0, 200);
    setLogs(next);
    localStorage.setItem(storageKeys.logs, JSON.stringify(next));
  };
  const persistExecutions = (items: SalesFunnelExecution[]) => {
    const next = items.slice(0, 10);
    setExecutions(next);
    localStorage.setItem(storageKeys.executions, JSON.stringify(next));
  };

  const patchExecution = useCallback(
    (runId: string, patch: Partial<SalesFunnelExecution>) => {
      setExecutions((prev) => {
        const next = prev.map((e) => (e.id === runId ? { ...e, ...patch } : e));
        localStorage.setItem(storageKeys.executions, JSON.stringify(next.slice(0, 10)));
        return next;
      });
    },
    []
  );

  const onReset = () => {
    setCity('');
    setPreset('cbse');
    setResultText('Form reset.');
    setStatus({ text: 'Ready', kind: '' });
  };

  const refreshRecentN8n = useCallback(async () => {
    if (!canPollExecution) {
      setRecentN8nError('Execution proxy is unavailable.');
      return;
    }
    setRecentN8nLoading(true);
    setRecentN8nError(null);
    try {
      const list = await listSalesExecutions(15, SALES_WORKFLOW_ID);
      if (list) {
        // The daily follow-up emails run in the same workflow on a schedule ("trigger" mode); city runs come in by webhook.
        setRecentN8n(list.filter((item) => item.mode !== 'trigger'));
        setLastFollowUpRun(list.find((item) => item.mode === 'trigger') ?? null);
        setRecentN8nSource(lastSalesExecutionsMeta.source);
        if (lastSalesExecutionsMeta.warning) {
          setRecentN8nError(lastSalesExecutionsMeta.warning);
        }
      } else {
        setRecentN8nError('Could not load recent n8n executions. Refresh sign-in or check role/API access.');
      }
    } catch (e) {
      setRecentN8nError(e instanceof Error ? e.message : 'Could not load recent n8n executions.');
    } finally {
      setRecentN8nLoading(false);
    }
  }, []);

  // Filters run in memory over the leads loaded once, so typing never refetches.
  const filteredLeads = useMemo(() => {
    const q = leadQuery.trim().toLowerCase();
    const cityQ = leadCity.trim().toLowerCase();
    const stageQ = leadStageFilter.trim().toLowerCase();
    return leads.filter((row) => {
      if (cityQ && !cell(row, 'City').toLowerCase().includes(cityQ)) return false;
      if (stageQ && cell(row, 'Stage').trim().toLowerCase() !== stageQ) return false;
      if (q && !LEAD_SEARCH_COLUMNS.some((col) => cell(row, col).toLowerCase().includes(q))) return false;
      return true;
    });
  }, [leads, leadQuery, leadCity, leadStageFilter]);

  const stopWatching = useCallback(
    async (text: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      setPollingExecutionId(null);
      setStatus({ text, kind: 'warn' });
      if (!activeRunId) return;
      const stoppedAt = new Date().toISOString();
      patchExecution(activeRunId, { status: 'error', stoppedAt });
      if (firebaseEnabled) {
        await updateSalesFunnelRun(activeRunId, { status: 'error', stoppedAt, ok: false });
      }
    },
    [activeRunId, firebaseEnabled, patchExecution]
  );

  useEffect(() => {
    let alive = true;
    const loadFromFirebase = async () => {
      if (!firebaseEnabled) return;
      const items = await fetchRecentSalesFunnelRuns(10);
      const logsFromFb = await fetchRecentSalesFunnelLogs(200);
      if (!alive) return;
      const runs = items.map((i) => i.run);
      const historyFromFb = items.map((i) => i.history);
      // An empty store must not wipe the runs this browser already recorded.
      if (runs.length) {
        setExecutions(runs);
        setHistory(historyFromFb);
      }
      if (logsFromFb.length) setLogs(logsFromFb);
      if (items[0]?.resultText) {
        setResultText(items[0].resultText);
        localStorage.setItem(storageKeys.latestResultText, items[0].resultText);
      }
      if (runs.length) localStorage.setItem(storageKeys.executions, JSON.stringify(runs));
      if (historyFromFb.length) localStorage.setItem(storageKeys.history, JSON.stringify(historyFromFb));
      if (logsFromFb.length) localStorage.setItem(storageKeys.logs, JSON.stringify(logsFromFb));

      const waiting = runs.find(
        (r) =>
          r.status === 'waiting' &&
          r.n8nExecutionId &&
          Date.now() - Date.parse(r.startedAt) < RESUME_MAX_AGE_MS
      );
      if (waiting?.n8nExecutionId) {
        setActiveRunId(waiting.id);
        setPollingExecutionId(waiting.n8nExecutionId);
        setStatus({ text: 'Pipeline running', kind: '' });
      }
    };
    loadFromFirebase();
    void refreshRecentN8n();
    return () => {
      alive = false;
    };
  }, [firebaseEnabled, refreshRecentN8n]);

  useEffect(() => {
    if (!pollingExecutionId || !canPollExecution) return;

    let active = true;
    let emptyPolls = 0;
    const watchStartedAt = Date.now();

    const poll = async () => {
      const exec = await getSalesExecutionStatus(pollingExecutionId);
      if (!active) return;
      if (!exec) {
        emptyPolls += 1;
        if (emptyPolls >= MAX_EMPTY_POLLS) {
          active = false;
          await stopWatching('No status from n8n · stopped watching');
        }
        return;
      }
      emptyPolls = 0;
      const runId = activeRunId;

      if (exec.finished) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        // One full fetch at the end gives each node's counts for the run summary.
        const full = await getSalesExecutionStatus(pollingExecutionId, { nodes: true });
        const nodes = mapRunDataToNodes(full || exec);
        const counts = countsFrom(full);
        const finalStatus: SalesFunnelExecutionStatus = exec.status === 'error' ? 'error' : 'success';
        if (runId) {
          patchExecution(runId, {
            status: finalStatus,
            stoppedAt: exec.stoppedAt || new Date().toISOString(),
            nodes,
            n8nExecutionId: exec.id,
            counts,
          });
          if (firebaseEnabled) {
            await updateSalesFunnelRun(runId, {
              status: finalStatus,
              stoppedAt: exec.stoppedAt || new Date().toISOString(),
              ok: finalStatus === 'success',
              nodes,
              n8nExecutionId: exec.id,
              ...(counts ? { counts } : {}), // Firestore rejects undefined fields
            });
          }
        }
        setStatus({
          text: finalStatus === 'success' ? 'Pipeline finished' : 'Pipeline failed',
          kind: finalStatus === 'success' ? 'ok' : 'warn',
        });
        setPollingExecutionId(null);
        void refreshRecentN8n();
        void loadLeads();
        return;
      }

      if (Date.now() - watchStartedAt > MAX_WATCH_MS) {
        active = false;
        await stopWatching('Still running after 20 min · see Recent n8n Runs');
        return;
      }

      if (runId) {
        patchExecution(runId, { status: 'waiting', n8nExecutionId: exec.id });
      }
      setStatus({ text: 'Running…', kind: '' });
    };

    void poll();
    pollRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [
    pollingExecutionId,
    activeRunId,
    firebaseEnabled,
    patchExecution,
    refreshRecentN8n,
    loadLeads,
    stopWatching,
  ]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!city.trim()) {
      setResultText('City is required.');
      setStatus({ text: 'Validation error', kind: 'warn' });
      return;
    }
    setSubmitting(true);
    setStatus({ text: 'Submitting', kind: '' });

    const presetLabel = CITY_RUN_PRESETS.find((p) => p.value === preset)?.label || preset;
    const payload = {
      city: city.trim(),
      queryPrefix: `${presetLabel} in`,
      query: `${presetLabel} in ${city.trim()}`,
      startedAt: new Date().toISOString(),
    };

    const logEntriesForStorage: SalesFunnelLogEntry[] = [];
    const pushLog = (type: string, message: string) => {
      const entry: SalesFunnelLogEntry = { type, message, at: new Date().toISOString() };
      logEntriesForStorage.push(entry);
      persistLogs([entry, ...logs].slice(0, 200));
    };

    pushLog('request', `Start ${payload.query}`);
    setResultText(`Starting: ${payload.query}`);

    let ok = false;
    let bodyText = '';
    let n8nExecutionId: string | undefined;

    try {
      // The backend launches the n8n run with the shared webhook key (no public n8n URL in the browser).
      const result = await startCityRun(payload.city, preset);
      ok = true;
      n8nExecutionId = result.executionId || undefined;
      bodyText = n8nExecutionId ? `Started · n8n execution ${n8nExecutionId}` : 'Started';
      pushLog('response', bodyText);
    } catch (errorObj) {
      bodyText = errorObj instanceof Error ? errorObj.message : 'Unknown error';
      pushLog('error', bodyText);
    } finally {
      setSubmitting(false);
    }

    const formattedResultText = `${payload.query}\n\n${bodyText}`;
    setResultText(formattedResultText);
    localStorage.setItem(storageKeys.latestResultText, formattedResultText);

    const runId = makeId('local');
    const runStatus: SalesFunnelExecutionStatus =
      ok && n8nExecutionId ? 'waiting' : ok ? 'success' : 'error';
    const nodes: SalesFunnelExecutionNode[] = [
      {
        name: 'City Start Webhook',
        status: ok ? 'success' : 'error',
        executionTime: 0,
        itemsInput: 1,
        itemsOutput: ok ? 1 : 0,
      },
    ];
    const localExecution: SalesFunnelExecution = {
      id: runId,
      status: runStatus,
      mode: 'ui-trigger',
      startedAt: payload.startedAt,
      stoppedAt: runStatus === 'waiting' ? undefined : new Date().toISOString(),
      nodes,
      n8nExecutionId,
    };
    persistExecutions([localExecution, ...executions]);

    const historyEntry: SalesFunnelHistoryItem = {
      city: payload.city,
      queryPrefix: payload.queryPrefix,
      query: payload.query,
      ok,
      time: new Date().toISOString(),
    };
    persistHistory([historyEntry, ...history]);

    if (firebaseEnabled) {
      const authUser = getCurrentAuthUser();
      if (authUser) {
        await createSalesFunnelRunWithLogs({
          runId,
          userId: authUser.uid,
          city: payload.city,
          queryPrefix: payload.queryPrefix,
          query: payload.query,
          startedAt: payload.startedAt,
          stoppedAt: localExecution.stoppedAt || new Date().toISOString(),
          ok,
          endpointMode: 'api',
          webhookUrl: '/api/sales/city-runs',
          requestUrl: '/api/sales/city-runs',
          responseStatus: ok ? 202 : 0,
          responseBody: bodyText,
          nodes,
          logEntries: logEntriesForStorage,
          status: runStatus,
          n8nExecutionId,
        });
      }
    }

    if (ok && n8nExecutionId && canPollExecution) {
      setActiveRunId(runId);
      setPollingExecutionId(n8nExecutionId);
      setStatus({ text: 'Pipeline running', kind: '' });
    } else {
      setStatus({ text: ok ? 'Run started' : 'Run start failed', kind: ok ? 'ok' : 'warn' });
    }

    void refreshRecentN8n();
    if (scrollAnchorRef.current) {
      scrollAnchorRef.current.open = true;
      scrollAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const inspectN8nExecution = async (id: string) => {
    setSelectedN8nId(id);
    const exec = await getSalesExecutionStatus(id, { nodes: true });
    if (!exec) return;
    const nodes = mapRunDataToNodes(exec);
    const synthetic: SalesFunnelExecution = {
      id: `n8n-${id}`,
      status: exec.finished
        ? exec.status === 'error'
          ? 'error'
          : 'success'
        : 'waiting',
      mode: 'n8n',
      startedAt: exec.startedAt,
      stoppedAt: exec.stoppedAt,
      nodes,
      n8nExecutionId: id,
      counts: countsFrom(exec),
    };
    setExecutions((prev) => {
      const without = prev.filter((e) => e.n8nExecutionId !== id && e.id !== synthetic.id);
      const next = [synthetic, ...without].slice(0, 10);
      localStorage.setItem(storageKeys.executions, JSON.stringify(next));
      return next;
    });
    if (!exec.finished) {
      setActiveRunId(synthetic.id);
      setPollingExecutionId(id);
      setStatus({ text: 'Pipeline running', kind: '' });
    }
  };

  const statusBadgeVariant = (s: string) => {
    const v = s.toLowerCase();
    if (v === 'success') return 'success' as const;
    if (v === 'waiting' || v === 'running') return 'warning' as const;
    return 'danger' as const;
  };

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Campaigns" subtitle="Find schools in a city and send them the first email.">
        <div className="flex items-center gap-2">
          <div
            className={`h-2 w-2 rounded-full ${
              status.kind === 'ok'
                ? 'bg-emerald-400'
                : status.kind === 'warn'
                  ? 'bg-amber-400'
                  : pollingExecutionId
                    ? 'bg-sky-400 animate-pulse'
                    : 'bg-zinc-500'
            }`}
          />
          <span className="text-xs font-medium text-zinc-300 uppercase tracking-wide">{status.text}</span>
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="surface-card p-5">
          <div className="flex items-center gap-2 mb-5">
            <Cpu className="w-4 h-4 text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-100">Launch Campaign</h3>
          </div>
          <form onSubmit={onSubmit} noValidate className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>City</Label>
                <Input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="e.g. Jaipur"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Schools to find</Label>
                <Select value={preset} onChange={(e) => setPreset(e.target.value as CityRunPreset)}>
                  {CITY_RUN_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="primary"
                disabled={submitting || Boolean(pollingExecutionId)}
                className="flex-1 h-10 text-sm font-semibold"
              >
                {submitting ? 'Initializing...' : pollingExecutionId ? 'Pipeline running…' : 'Run Pipeline'}
                <Workflow className="ml-2 w-4 h-4" />
              </Button>
              {pollingExecutionId ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void stopWatching('Stopped watching · run may continue in n8n')}
                  className="px-5"
                >
                  Stop watching
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={onReset} className="px-5">
                  Reset
                </Button>
              )}
            </div>
          </form>
        </div>

        <div className="surface-card p-5">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-semibold text-zinc-100">Last run</h3>
            {latestStatus && <Badge variant={statusBadgeVariant(latestStatus)}>{latestStatus}</Badge>}
          </div>
          {latestRun && latestSummary ? (
            <>
              <p className="text-[11px] text-zinc-500 mb-3">
                {latestRun.mode !== 'n8n' && history[0]?.query ? `${history[0].query} · ` : ''}
                {new Date(latestRun.startedAt).toLocaleString()}
              </p>
              <div className="grid grid-cols-3 gap-3 mb-3">
                {[
                  { label: 'Schools found', value: latestSummary.found },
                  { label: 'New in the sheet', value: latestSummary.added },
                  { label: 'First emails sent', value: latestSummary.emailed },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                    <p className="text-[10px] text-zinc-500">{s.label}</p>
                    <p className="text-lg font-semibold text-zinc-100">{s.value ?? '—'}</p>
                  </div>
                ))}
              </div>
              {latestSummary.found === undefined && latestRun.n8nExecutionId && !pollingExecutionId && (
                <button
                  type="button"
                  className="mb-3 text-[11px] text-sky-400 hover:underline"
                  onClick={() => void inspectN8nExecution(latestRun.n8nExecutionId!)}
                >
                  Load this run&apos;s numbers from n8n
                </button>
              )}
              {latestSummary.sendFailures && (
                <p className="mb-3 text-[11px] text-amber-400">Some emails failed to send. The alert email has the error.</p>
              )}
            </>
          ) : recentN8n[0] ? (
            <p className="text-[11px] text-zinc-500 mb-3">
              Latest n8n run #{recentN8n[0].id} · {recentN8n[0].status}
              {recentN8n[0].startedAt ? ` · ${new Date(recentN8n[0].startedAt).toLocaleString()}` : ''} ·{' '}
              <button type="button" className="text-sky-400 hover:underline" onClick={() => void inspectN8nExecution(recentN8n[0].id)}>
                Load its numbers
              </button>
            </p>
          ) : (
            <p className="text-[11px] text-zinc-500 mb-3">No runs yet.</p>
          )}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-400 max-h-[90px] overflow-auto whitespace-pre-wrap">
            {resultText || 'Awaiting telemetry...'}
          </div>
        </div>
      </div>

      <details className="mt-6" ref={scrollAnchorRef}>
        <summary className="cursor-pointer select-none text-xs font-medium text-zinc-400 hover:text-zinc-200">
          Run details: node logs and recent n8n runs
        </summary>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-4">
        <div className="lg:col-span-8">
          <div className="surface-card p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Workflow className="w-4 h-4 text-zinc-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Workflow Node Logs</h3>
              </div>
              <Badge variant="outline">
                {pollingExecutionId ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Live
                  </span>
                ) : (
                  'Trace'
                )}
              </Badge>
            </div>
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {executions.map((run) => (
                <div
                  key={run.id}
                  className="rounded-lg bg-zinc-800/40 border border-zinc-800 overflow-hidden"
                >
                  <div className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-2 w-2 rounded-full ${
                          run.status === 'success'
                            ? 'bg-emerald-500'
                            : run.status === 'waiting'
                              ? 'bg-sky-400 animate-pulse'
                              : 'bg-red-500'
                        }`}
                      />
                      <div>
                        <p className="text-xs font-medium text-zinc-200">
                          Run #{(run.n8nExecutionId || run.id).slice(-8)}
                        </p>
                        <p className="text-[10px] text-zinc-500">
                          {new Date(run.startedAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <Badge variant={statusBadgeVariant(run.status)}>{run.status}</Badge>
                  </div>
                  <div className="px-3 pb-3 space-y-1.5">
                    {run.nodes.map((node) => (
                      <div
                        key={`${run.id}-${node.name}`}
                        className="flex items-center justify-between px-3 py-2 rounded-md bg-zinc-900/60 border border-zinc-800/50 text-[11px]"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-zinc-400 truncate">{node.name}</span>
                          <span className="text-[9px] text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded flex-shrink-0">
                            {node.executionTime}ms
                          </span>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <span className="text-[10px] text-zinc-500">
                            <span className="text-emerald-500">{node.itemsInput}</span> →{' '}
                            <span className="text-emerald-400">{node.itemsOutput}</span>
                          </span>
                          <div
                            className={`h-1.5 w-1.5 rounded-full ${
                              node.status === 'success'
                                ? 'bg-emerald-500'
                                : node.status === 'running'
                                  ? 'bg-sky-400'
                                  : 'bg-red-500'
                            }`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {!executions.length && (
                <p className="text-xs text-zinc-600 text-center py-8">No runs yet</p>
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-4 space-y-6">
          <div className="surface-card p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-zinc-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Recent n8n Runs</h3>
              </div>
              <button
                type="button"
                onClick={() => void refreshRecentN8n()}
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                title="Refresh"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${recentN8nLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {recentN8nError && (
              <div className="mb-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                {recentN8nError}
              </div>
            )}
            {recentN8nSource === 'firestore' && (
              <div className="mb-3 rounded-md border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-200">
                Showing stored sales runs while n8n API access is unavailable.
              </div>
            )}
            {lastFollowUpRun && (
              <p className="mb-3 text-[11px] text-zinc-500">
                Daily follow-ups last ran {new Date(lastFollowUpRun.startedAt).toLocaleString()} · {lastFollowUpRun.status}
              </p>
            )}
            <div className="space-y-2 max-h-[220px] overflow-y-auto">
              {recentN8n.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void inspectN8nExecution(item.id)}
                  className={`w-full text-left p-3 rounded-lg border transition-all ${
                    selectedN8nId === item.id
                      ? 'border-indigo-500/40 bg-indigo-500/10'
                      : 'bg-zinc-800/40 border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-medium text-zinc-200 font-mono">#{item.id.slice(-8)}</p>
                    <Badge variant={statusBadgeVariant(item.status)} className="text-[9px]">
                      {item.status}
                    </Badge>
                  </div>
                  <p className="text-[9px] text-zinc-600">
                    {item.startedAt ? new Date(item.startedAt).toLocaleString() : '—'}
                  </p>
                </button>
              ))}
              {!recentN8n.length && !recentN8nError && (
                <p className="text-[11px] text-zinc-600 text-center py-4">
                  {recentN8nLoading ? 'Loading executions...' : canPollExecution ? 'No recent executions' : 'Proxy unavailable'}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
      </details>

      <SalesInsightsPanel leads={filteredLeads} onSelectLead={setSelectedLead} />

      {/* Leads from Google Sheets */}
      <div className="surface-card p-5 mt-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Table2 className="w-4 h-4 text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-100">Leads (Google Sheets)</h3>
            {leadsFetchedAt && (
              <span className="text-[10px] text-zinc-600">
                Updated {new Date(leadsFetchedAt).toLocaleString()}
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => void loadLeads()}
            disabled={leadsLoading}
          >
            {leadsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
            Refresh
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 mb-4">
          <Input
            placeholder="Search school, email, phone…"
            value={leadQuery}
            onChange={(e) => setLeadQuery(e.target.value)}
            className="h-9 text-xs"
          />
          <Input
            placeholder="Filter city"
            value={leadCity}
            onChange={(e) => setLeadCity(e.target.value)}
            className="h-9 text-xs"
          />
          <Input
            placeholder="Stage (e.g. Engaged)"
            value={leadStageFilter}
            onChange={(e) => setLeadStageFilter(e.target.value)}
            className="h-9 text-xs"
          />
        </div>

        {leadsError && (
          <p className="text-xs text-amber-400 mb-3">{leadsError}</p>
        )}

        <div className="overflow-auto max-h-[480px] rounded-lg border border-zinc-800">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-zinc-900 z-10">
              <tr className="border-b border-zinc-800 text-zinc-500">
                {LEAD_COLUMNS.map((col) => (
                  <th key={col} className="px-3 py-2 font-medium whitespace-nowrap">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leadsLoading && !leads.length ? (
                <tr>
                  <td colSpan={LEAD_COLUMNS.length} className="px-3 py-8 text-center text-zinc-600">
                    Loading leads…
                  </td>
                </tr>
              ) : !filteredLeads.length ? (
                <tr>
                  <td colSpan={LEAD_COLUMNS.length} className="px-3 py-8 text-center text-zinc-600">
                    No leads found
                  </td>
                </tr>
              ) : (
                filteredLeads.map((row, idx) => {
                  const phone = leadPhoneForMessaging(row);
                  return (
                    <tr
                      key={idx}
                      className="border-b border-zinc-800/60 hover:bg-zinc-800/40 cursor-pointer"
                      onClick={() => setSelectedLead(row)}
                    >
                      {LEAD_COLUMNS.map((col) => {
                        const value = cell(row, col);
                        if (col === 'Phone number' && phone) {
                          return (
                            <td key={col} className="px-3 py-2 whitespace-nowrap">
                              <Link
                                to={`/twilio-messaging?contact=${encodeURIComponent(phone)}`}
                                className="text-sky-400 hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {value || phone}
                              </Link>
                            </td>
                          );
                        }
                        return (
                          <td key={col} className="px-3 py-2 whitespace-nowrap max-w-[180px] truncate text-zinc-300">
                            {value || '—'}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] text-zinc-600">{filteredLeads.length} of {leads.length} row(s) shown</p>
      </div>

      {selectedLead && (
        <LeadDrawer
          lead={selectedLead}
          onClose={() => setSelectedLead(null)}
          onChange={(row) => {
            replaceLead(row);
            setSelectedLead(row);
          }}
        />
      )}
    </div>
  );
}
