import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Workflow,
  Target,
  Cpu,
  History as HistoryIcon,
  Loader2,
  RefreshCw,
  Table2,
  X,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
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
import {
  fetchSheetLeads,
  leadPhoneForMessaging,
  type SchoolLeadRow,
} from '../api/sheetsClient';
import { writeOpsAuditEvent } from '../api/opsClient';
import { OPS_DASHBOARD_ROADMAP } from '../lib/opsDashboardRoadmap';

const storageKeys = {
  webhookUrl: 'sales_funnel_webhook_url',
  history: 'sales_funnel_history',
  endpointMode: 'sales_funnel_endpoint_mode',
  logs: 'sales_funnel_logs',
  executions: 'sales_funnel_n8n_executions',
  latestResultText: 'sales_funnel_latest_result_text',
} as const;

const endpointUrls = {
  test: import.meta.env.VITE_N8N_SALES_FUNNEL_URL || 'https://n8n.altiereality.com/webhook/city-scrape-start',
  production:
    import.meta.env.VITE_N8N_SALES_FUNNEL_URL || 'https://n8n.altiereality.com/webhook/city-scrape-start',
};

const SALES_WORKFLOW_ID =
  (import.meta.env.VITE_N8N_SALES_WORKFLOW_ID as string | undefined) || 'sLk0CAalsSlR5z4P';

const POLL_INTERVAL_MS = 2500;

type Mode = 'test' | 'production' | 'custom';
type HeaderStatus = { text: string; kind: '' | 'ok' | 'warn' };

const LEAD_COLUMNS = [
  'School Name',
  'City',
  'Email ID',
  'Phone number',
  'Lead_status',
  'Status',
  'Reply_Status',
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

function readMode(): Mode {
  return (localStorage.getItem(storageKeys.endpointMode) as Mode) || 'production';
}

function readUrl(mode: Mode): string {
  const storedUrl = localStorage.getItem(storageKeys.webhookUrl);
  if (storedUrl?.includes('webhook-test')) {
    localStorage.removeItem(storageKeys.webhookUrl);
    return endpointUrls.production;
  }
  if (mode === 'test' || mode === 'production') return endpointUrls[mode];
  return storedUrl || endpointUrls.production;
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

function parseExecutionId(bodyText: string): string | undefined {
  try {
    const data = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof data.executionId === 'string') return data.executionId;
    if (typeof data.execution_id === 'string') return data.execution_id;
    if (data.data && typeof data.data === 'object') {
      const inner = data.data as Record<string, unknown>;
      if (typeof inner.executionId === 'string') return inner.executionId;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function cell(row: SchoolLeadRow, key: string): string {
  const v = row[key];
  if (v == null) return '';
  return String(v);
}

export default function SalesFunnelPage() {
  const [mode] = useState<Mode>(() => readMode());
  const [webhookUrl] = useState<string>(() => readUrl(readMode()));
  const [city, setCity] = useState<string>('');
  const [queryPrefix, setQueryPrefix] = useState<string>('CBSE schools in');
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
  const [recentN8nLoading, setRecentN8nLoading] = useState(false);
  const [recentN8nError, setRecentN8nError] = useState<string | null>(null);
  const [recentN8nSource, setRecentN8nSource] = useState<'n8n' | 'firestore' | 'unknown'>('unknown');
  const [selectedN8nId, setSelectedN8nId] = useState<string | null>(null);

  const [leads, setLeads] = useState<SchoolLeadRow[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsError, setLeadsError] = useState<string | null>(null);
  const [leadsFetchedAt, setLeadsFetchedAt] = useState<string | null>(null);
  const [leadQuery, setLeadQuery] = useState('');
  const [leadCity, setLeadCity] = useState('');
  const [leadStatusFilter, setLeadStatusFilter] = useState('');
  const [selectedLead, setSelectedLead] = useState<SchoolLeadRow | null>(null);

  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firebaseEnabled = useMemo(() => isFirebaseConfigured(), []);

  const successCount = useMemo(
    () => executions.filter((e) => String(e.status).toLowerCase() === 'success').length,
    [executions]
  );
  const errorCount = useMemo(
    () => executions.filter((e) => String(e.status).toLowerCase() === 'error').length,
    [executions]
  );
  const waitingCount = useMemo(
    () => executions.filter((e) => String(e.status).toLowerCase() === 'waiting').length,
    [executions]
  );
  const latestRun = executions[0];

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
    setQueryPrefix('CBSE schools in');
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
        setRecentN8n(list);
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

  const loadLeads = useCallback(async () => {
    setLeadsLoading(true);
    setLeadsError(null);
    try {
      const result = await fetchSheetLeads({
        q: leadQuery.trim() || undefined,
        city: leadCity.trim() || undefined,
        leadStatus: leadStatusFilter.trim() || undefined,
        limit: 500,
      });
      setLeads(result.rows);
      setLeadsFetchedAt(result.fetchedAt);
    } catch (e) {
      setLeadsError(e instanceof Error ? e.message : 'Failed to load leads');
      setLeads([]);
    } finally {
      setLeadsLoading(false);
    }
  }, [leadQuery, leadCity, leadStatusFilter]);

  useEffect(() => {
    let alive = true;
    const loadFromFirebase = async () => {
      if (!firebaseEnabled) return;
      const items = await fetchRecentSalesFunnelRuns(10);
      const logsFromFb = await fetchRecentSalesFunnelLogs(200);
      if (!alive) return;
      const runs = items.map((i) => i.run);
      const historyFromFb = items.map((i) => i.history);
      setExecutions(runs);
      setHistory(historyFromFb);
      setLogs(logsFromFb);
      if (items[0]?.resultText) {
        setResultText(items[0].resultText);
        localStorage.setItem(storageKeys.latestResultText, items[0].resultText);
      }
      if (runs.length) localStorage.setItem(storageKeys.executions, JSON.stringify(runs));
      if (historyFromFb.length) localStorage.setItem(storageKeys.history, JSON.stringify(historyFromFb));
      if (logsFromFb.length) localStorage.setItem(storageKeys.logs, JSON.stringify(logsFromFb));

      const waiting = runs.find((r) => r.status === 'waiting' && r.n8nExecutionId);
      if (waiting?.n8nExecutionId) {
        setActiveRunId(waiting.id);
        setPollingExecutionId(waiting.n8nExecutionId);
        setStatus({ text: 'Pipeline running', kind: '' });
      }
    };
    loadFromFirebase();
    void refreshRecentN8n();
    void loadLeads();
    return () => {
      alive = false;
    };
  }, [firebaseEnabled, refreshRecentN8n, loadLeads]);

  useEffect(() => {
    if (!pollingExecutionId || !canPollExecution) return;

    const poll = async () => {
      const exec = await getSalesExecutionStatus(pollingExecutionId);
      if (!exec) return;
      const nodes = mapRunDataToNodes(exec);
      const runId = activeRunId;

      if (exec.finished) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        const finalStatus: SalesFunnelExecutionStatus = exec.status === 'error' ? 'error' : 'success';
        if (runId) {
          patchExecution(runId, {
            status: finalStatus,
            stoppedAt: exec.stoppedAt || new Date().toISOString(),
            nodes,
            n8nExecutionId: exec.id,
          });
          if (firebaseEnabled) {
            await updateSalesFunnelRun(runId, {
              status: finalStatus,
              stoppedAt: exec.stoppedAt || new Date().toISOString(),
              ok: finalStatus === 'success',
              nodes,
              n8nExecutionId: exec.id,
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

      if (runId) {
        patchExecution(runId, { status: 'waiting', nodes, n8nExecutionId: exec.id });
      }
      setStatus({ text: `Running · ${nodes[nodes.length - 1]?.name || '…'}`, kind: '' });
    };

    void poll();
    pollRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
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

    const payload: { city: string; queryPrefix: string; startedAt: string; query?: string } = {
      city: city.trim(),
      queryPrefix: queryPrefix.trim() || 'CBSE schools in',
      startedAt: new Date().toISOString(),
    };
    payload.query = `${payload.queryPrefix} ${payload.city}`.trim();

    const requestUrl = new URL(webhookUrl);
    requestUrl.searchParams.set('city', payload.city);
    requestUrl.searchParams.set('queryPrefix', payload.queryPrefix);
    requestUrl.searchParams.set('query', payload.query);
    requestUrl.searchParams.set('startedAt', payload.startedAt);

    const logEntriesForStorage: SalesFunnelLogEntry[] = [];
    const pushLog = (type: string, message: string) => {
      const entry: SalesFunnelLogEntry = { type, message, at: new Date().toISOString() };
      logEntriesForStorage.push(entry);
      persistLogs([entry, ...logs].slice(0, 200));
    };

    pushLog('request', `GET ${requestUrl.toString()}`);
    setResultText(`Sending GET request to:\n${requestUrl.toString()}`);

    let ok = false;
    let bodyText = '';
    let statusCode = 0;
    let n8nExecutionId: string | undefined;

    try {
      const response = await fetch(requestUrl.toString(), { method: 'GET' });
      statusCode = response.status;
      bodyText = await response.text();
      ok = response.ok;
      n8nExecutionId = parseExecutionId(bodyText);
      pushLog('response', `Status ${statusCode}: ${bodyText || '(No response body)'}`);
    } catch (errorObj) {
      bodyText = errorObj instanceof Error ? errorObj.message : 'Unknown error';
      pushLog('error', bodyText);
    } finally {
      setSubmitting(false);
    }

    const formattedResultText =
      `Status: ${statusCode || 'NETWORK_ERROR'}\nEndpoint: ${requestUrl.toString()}\n\n` +
      `${bodyText || '(No response body)'}`;
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
      query: payload.query!,
      ok,
      time: new Date().toISOString(),
    };
    persistHistory([historyEntry, ...history]);

    void writeOpsAuditEvent({
      action: ok ? 'n8n.city_scrape.launch' : 'n8n.city_scrape.launch_failed',
      targetId: payload.city,
      details: {
        city: payload.city,
        queryPrefix: payload.queryPrefix,
        query: payload.query,
        status: ok ? runStatus : 'error',
        responseStatus: statusCode || 'NETWORK_ERROR',
        n8nExecutionId: n8nExecutionId || null,
        endpointMode: mode,
      },
    }).catch((error) => console.warn('[sales-funnel] Failed to write ops audit event.', error));

    if (firebaseEnabled) {
      const authUser = getCurrentAuthUser();
      if (authUser) {
        await createSalesFunnelRunWithLogs({
          runId,
          userId: authUser.uid,
          city: payload.city,
          queryPrefix: payload.queryPrefix,
          query: payload.query!,
          startedAt: payload.startedAt,
          stoppedAt: localExecution.stoppedAt || new Date().toISOString(),
          ok,
          endpointMode: mode,
          webhookUrl,
          requestUrl: requestUrl.toString(),
          responseStatus: statusCode,
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
    scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const inspectN8nExecution = async (id: string) => {
    setSelectedN8nId(id);
    const exec = await getSalesExecutionStatus(id);
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
      <PageHeader title="Sales Funnel" subtitle="Launch city-based lead generation campaigns.">
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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <div className="surface-card stat-card">
          <div className="flex items-center justify-between">
            <span className="stat-label">Total Runs</span>
            <Activity className="w-4 h-4 text-zinc-600" />
          </div>
          <span className="stat-value">{executions.length}</span>
        </div>
        <div className="surface-card stat-card">
          <div className="flex items-center justify-between">
            <span className="stat-label">Success</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-500/50" />
          </div>
          <span className="stat-value text-emerald-400">{successCount}</span>
        </div>
        <div className="surface-card stat-card">
          <div className="flex items-center justify-between">
            <span className="stat-label">Errors / Waiting</span>
            <CircleAlert className="w-4 h-4 text-red-500/50" />
          </div>
          <span className="stat-value text-red-400">
            {errorCount}
            <span className="text-zinc-500 text-sm font-normal"> / {waitingCount}</span>
          </span>
        </div>
        <div className="surface-card stat-card">
          <div className="flex items-center justify-between">
            <span className="stat-label">Latest</span>
            <Target className="w-4 h-4 text-zinc-600" />
          </div>
          <span className="text-sm font-medium text-zinc-300 truncate">
            #{latestRun?.n8nExecutionId?.slice(-8) || latestRun?.id?.slice(-8) || '—'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="surface-card p-5">
          <div className="flex items-center gap-2 mb-5">
            <Cpu className="w-4 h-4 text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-100">Launch Campaign</h3>
          </div>
          <form onSubmit={onSubmit} noValidate className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Target Region</Label>
                <Input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="e.g. New York, Mumbai"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Business Niche</Label>
                <Input
                  value={queryPrefix}
                  onChange={(e) => setQueryPrefix(e.target.value)}
                  placeholder="e.g. Dental Clinics"
                />
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
              <Button type="button" variant="outline" onClick={onReset} className="px-5">
                Reset
              </Button>
            </div>
          </form>
        </div>

        <div className="surface-card p-5">
          <h3 className="text-sm font-semibold text-zinc-100 mb-4">Live Diagnostics</h3>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-[11px] leading-relaxed text-zinc-400 h-[150px] overflow-auto whitespace-pre-wrap">
            {resultText || 'Awaiting telemetry...'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6" ref={scrollAnchorRef}>
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

          <div className="surface-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <HistoryIcon className="w-4 h-4 text-zinc-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Conversion History</h3>
            </div>
            <div className="space-y-2 max-h-[240px] overflow-y-auto">
              {history.map((item, index) => (
                <div
                  key={index}
                  className="p-3 rounded-lg bg-zinc-800/40 border border-zinc-800 hover:border-zinc-700 transition-all"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-xs font-medium text-zinc-200">{item.city}</p>
                    <Badge variant={item.ok ? 'success' : 'danger'} className="text-[9px]">
                      {item.ok ? 'OK' : 'FAIL'}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-zinc-500 italic mb-2">
                    &quot;{item.query || 'Generic Search'}&quot;
                  </p>
                  <p className="text-[9px] text-zinc-600 text-right">
                    {new Date(item.time).toLocaleTimeString()}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

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
          <div className="flex gap-2">
            <Input
              placeholder="Lead_status"
              value={leadStatusFilter}
              onChange={(e) => setLeadStatusFilter(e.target.value)}
              className="h-9 text-xs flex-1"
            />
            <Button type="button" variant="secondary" className="h-9 text-xs" onClick={() => void loadLeads()}>
              Apply
            </Button>
          </div>
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
              ) : !leads.length ? (
                <tr>
                  <td colSpan={LEAD_COLUMNS.length} className="px-3 py-8 text-center text-zinc-600">
                    No leads found
                  </td>
                </tr>
              ) : (
                leads.map((row, idx) => {
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
        <p className="mt-2 text-[10px] text-zinc-600">{leads.length} row(s) shown</p>
      </div>

      {selectedLead && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => setSelectedLead(null)}>
          <div
            className="w-full max-w-lg max-h-[80vh] overflow-auto rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div>
                <h4 className="text-sm font-semibold text-zinc-100">
                  {cell(selectedLead, 'School Name') || 'Lead detail'}
                </h4>
                <p className="text-[11px] text-zinc-500">{cell(selectedLead, 'City')}</p>
              </div>
              <button type="button" className="p-1 text-zinc-500 hover:text-zinc-300" onClick={() => setSelectedLead(null)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <dl className="space-y-2 text-[11px]">
              {[
                'Email ID',
                'Phone number',
                'Lead_status',
                'Status',
                'Reply_Status',
                'Whatsapp_status',
                'Whatsapp_message_sid',
                'whatsapp_sent_at',
                'whatsapp_replied',
                'whatsapp_reply_message',
                'whatsapp_reply_category',
                'Follow_up_count',
                'Last_Follow_up',
                'Next_Follow_up',
                'XR_status',
                'Thread ID',
              ].map((key) => (
                <div key={key} className="flex gap-3 border-b border-zinc-800/80 pb-1.5">
                  <dt className="w-40 flex-shrink-0 text-zinc-500">{key}</dt>
                  <dd className="text-zinc-200 break-all">{cell(selectedLead, key) || '—'}</dd>
                </div>
              ))}
            </dl>
            {leadPhoneForMessaging(selectedLead) && (
              <Link
                to={`/twilio-messaging?contact=${encodeURIComponent(leadPhoneForMessaging(selectedLead)!)}`}
                className="mt-4 inline-flex text-xs text-sky-400 hover:underline"
              >
                Open in Messaging →
              </Link>
            )}
          </div>
        </div>
      )}

      <div className="surface-card p-5 mt-6">
        <h3 className="text-sm font-semibold text-zinc-100 mb-2">Coming next (ops roadmap)</h3>
        <ul className="grid gap-2 sm:grid-cols-2 text-[11px] text-zinc-500">
          {OPS_DASHBOARD_ROADMAP.map((item) => (
            <li key={item.id} className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
              <span className="text-zinc-300 font-medium">{item.title}</span>
              <span className="block mt-0.5 text-zinc-600">{item.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
