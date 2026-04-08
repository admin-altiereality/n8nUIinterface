import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CheckCircle2, CircleAlert, Clock3, Workflow, Target, Cpu, History as HistoryIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { PageHeader } from '../components/layout/PageHeader';
import {
  createSalesFunnelRunWithLogs,
  fetchRecentSalesFunnelLogs,
  fetchRecentSalesFunnelRuns,
  type SalesFunnelExecution,
  type SalesFunnelExecutionNodeStatus,
  type SalesFunnelExecutionStatus,
  type SalesFunnelHistoryItem,
  type SalesFunnelLogEntry
} from '../lib/salesFunnelRepository';
import { getCurrentAuthUser, isFirebaseConfigured } from '../lib/firebase';

const storageKeys = {
  webhookUrl: 'sales_funnel_webhook_url',
  history: 'sales_funnel_history',
  endpointMode: 'sales_funnel_endpoint_mode',
  logs: 'sales_funnel_logs',
  executions: 'sales_funnel_n8n_executions',
  latestResultText: 'sales_funnel_latest_result_text'
} as const;

const endpointUrls = {
  test: import.meta.env.VITE_N8N_SALES_FUNNEL_URL || 'https://n8n.altiereality.com/webhook/city-scrape-start',
  production: import.meta.env.VITE_N8N_SALES_FUNNEL_URL || 'https://n8n.altiereality.com/webhook/city-scrape-start'
};

type Mode = 'test' | 'production' | 'custom';
type HeaderStatus = { text: string; kind: '' | 'ok' | 'warn' };

function readJsonStorage<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}

function makeId(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function readMode(): Mode { return (localStorage.getItem(storageKeys.endpointMode) as Mode) || 'production'; }

function readUrl(mode: Mode): string {
  const storedUrl = localStorage.getItem(storageKeys.webhookUrl);
  if (storedUrl?.includes('webhook-test')) { localStorage.removeItem(storageKeys.webhookUrl); return endpointUrls.production; }
  if (mode === 'test' || mode === 'production') return endpointUrls[mode];
  return storedUrl || endpointUrls.production;
}

export default function SalesFunnelPage() {
  const [mode, setMode] = useState<Mode>(() => readMode());
  const [webhookUrl, setWebhookUrl] = useState<string>(() => readUrl(readMode()));
  const [city, setCity] = useState<string>('');
  const [queryPrefix, setQueryPrefix] = useState<string>('CBSE schools in');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [resultText, setResultText] = useState<string>(() => localStorage.getItem(storageKeys.latestResultText) || 'No submission yet.');
  const [status, setStatus] = useState<HeaderStatus>({ text: 'Ready', kind: '' });

  const [history, setHistory] = useState<SalesFunnelHistoryItem[]>(() => readJsonStorage(storageKeys.history, []));
  const [logs, setLogs] = useState<SalesFunnelLogEntry[]>(() => readJsonStorage(storageKeys.logs, []));
  const [executions, setExecutions] = useState<SalesFunnelExecution[]>(() => readJsonStorage(storageKeys.executions, []));

  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const firebaseEnabled = useMemo(() => isFirebaseConfigured(), []);

  const successCount = useMemo(() => executions.filter((e) => String(e.status).toLowerCase() === 'success').length, [executions]);
  const errorCount = useMemo(() => executions.filter((e) => String(e.status).toLowerCase() === 'error').length, [executions]);
  const latestRun = executions[0];

  const persistHistory = (items: SalesFunnelHistoryItem[]) => { const next = items.slice(0, 25); setHistory(next); localStorage.setItem(storageKeys.history, JSON.stringify(next)); };
  const persistLogs = (items: SalesFunnelLogEntry[]) => { const next = items.slice(0, 200); setLogs(next); localStorage.setItem(storageKeys.logs, JSON.stringify(next)); };
  const persistExecutions = (items: SalesFunnelExecution[]) => { const next = items.slice(0, 5); setExecutions(next); localStorage.setItem(storageKeys.executions, JSON.stringify(next)); };

  const appendLog = (entry: Omit<SalesFunnelLogEntry, 'at'> & { at?: string }) => {
    const withAt: SalesFunnelLogEntry = { type: entry.type, message: entry.message, at: entry.at || new Date().toISOString() };
    persistLogs([withAt, ...logs].slice(0, 200));
    return withAt;
  };

  const onModeChange = (nextMode: Mode) => {
    setMode(nextMode);
    localStorage.setItem(storageKeys.endpointMode, nextMode);
    if (nextMode === 'test' || nextMode === 'production') {
      const nextUrl = endpointUrls[nextMode];
      setWebhookUrl(nextUrl);
      localStorage.setItem(storageKeys.webhookUrl, nextUrl);
      setResultText(`Using ${nextMode} URL:\n${nextUrl}`);
      setStatus({ text: 'Endpoint updated', kind: 'ok' });
    } else {
      setResultText('Custom URL mode enabled. Update the Start URL field.');
      setStatus({ text: 'Endpoint updated', kind: 'ok' });
    }
  };

  const onReset = () => { setCity(''); setQueryPrefix('CBSE schools in'); setResultText('Form reset.'); setStatus({ text: 'Ready', kind: '' }); };

  useEffect(() => {
    let alive = true;
    const loadFromFirebase = async () => {
      if (!firebaseEnabled) return;
      const items = await fetchRecentSalesFunnelRuns(5);
      const logsFromFb = await fetchRecentSalesFunnelLogs(200);
      if (!alive) return;
      const runs = items.map((i) => i.run);
      const historyFromFb = items.map((i) => i.history);
      setExecutions(runs); setHistory(historyFromFb); setLogs(logsFromFb);
      if (items[0]?.resultText) { setResultText(items[0].resultText); localStorage.setItem(storageKeys.latestResultText, items[0].resultText); }
      if (runs.length) localStorage.setItem(storageKeys.executions, JSON.stringify(runs));
      if (historyFromFb.length) localStorage.setItem(storageKeys.history, JSON.stringify(historyFromFb));
      if (logsFromFb.length) localStorage.setItem(storageKeys.logs, JSON.stringify(logsFromFb));
    };
    loadFromFirebase();
    return () => { alive = false; };
  }, [firebaseEnabled]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!city.trim()) { setResultText('City is required.'); setStatus({ text: 'Validation error', kind: 'warn' }); return; }
    setSubmitting(true);
    setStatus({ text: 'Submitting', kind: '' });

    const payload: { city: string; queryPrefix: string; startedAt: string; query?: string } = {
      city: city.trim(), queryPrefix: queryPrefix.trim() || 'CBSE schools in', startedAt: new Date().toISOString()
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

    let ok = false; let bodyText = ''; let statusCode = 0;

    try {
      const response = await fetch(requestUrl.toString(), { method: 'GET' });
      statusCode = response.status;
      bodyText = await response.text();
      ok = response.ok;
      pushLog('response', `Status ${statusCode}: ${bodyText || '(No response body)'}`);
    } catch (errorObj) {
      bodyText = errorObj instanceof Error ? errorObj.message : 'Unknown error';
      pushLog('error', bodyText);
    } finally { setSubmitting(false); }

    const formattedResultText = `Status: ${statusCode || 'NETWORK_ERROR'}\nEndpoint: ${requestUrl.toString()}\n\n${bodyText || '(No response body)'}`;
    setResultText(formattedResultText);
    localStorage.setItem(storageKeys.latestResultText, formattedResultText);
    setStatus({ text: ok ? 'Run started' : 'Run start failed', kind: ok ? 'ok' : 'warn' });

    const runId = makeId('local');
    const nodes = [{ name: 'City Start Webhook', status: ok ? ('success' as const) : ('error' as const), executionTime: 0, itemsInput: 1, itemsOutput: ok ? 1 : 0 }];
    const localExecution: SalesFunnelExecution = { id: runId, status: ok ? 'success' : 'error', mode: 'ui-trigger', startedAt: payload.startedAt, stoppedAt: new Date().toISOString(), nodes };
    persistExecutions([localExecution, ...executions]);

    const historyEntry: SalesFunnelHistoryItem = { city: payload.city, queryPrefix: payload.queryPrefix, query: payload.query, ok, time: new Date().toISOString() };
    persistHistory([historyEntry, ...history]);

    if (firebaseEnabled) {
      const authUser = getCurrentAuthUser();
      if (authUser) {
        await createSalesFunnelRunWithLogs({
          runId, userId: authUser.uid, city: payload.city, queryPrefix: payload.queryPrefix, query: payload.query,
          startedAt: payload.startedAt, stoppedAt: localExecution.stoppedAt || new Date().toISOString(),
          ok, endpointMode: mode, webhookUrl, requestUrl: requestUrl.toString(), responseStatus: statusCode,
          responseBody: bodyText, nodes, logEntries: logEntriesForStorage
        });
      }
    }
    scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const { user } = useAuth();

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Sales Funnel" subtitle="Launch city-based lead generation campaigns.">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${status.kind === 'ok' ? 'bg-emerald-400' : status.kind === 'warn' ? 'bg-amber-400' : 'bg-zinc-500'}`} />
          <span className="text-xs font-medium text-zinc-300 uppercase tracking-wide">{status.text}</span>
        </div>
      </PageHeader>

      {/* Stats Row */}
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
            <span className="stat-label">Errors</span>
            <CircleAlert className="w-4 h-4 text-red-500/50" />
          </div>
          <span className="stat-value text-red-400">{errorCount}</span>
        </div>
        <div className="surface-card stat-card">
          <div className="flex items-center justify-between">
            <span className="stat-label">Latest</span>
            <Target className="w-4 h-4 text-zinc-600" />
          </div>
          <span className="text-sm font-medium text-zinc-300 truncate">#{latestRun?.id?.slice(-8) || '—'}</span>
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Campaign Config */}
        <div className="surface-card p-5">
          <div className="flex items-center gap-2 mb-5">
            <Cpu className="w-4 h-4 text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-100">Launch Campaign</h3>
          </div>
          <form onSubmit={onSubmit} noValidate className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Target Region</Label>
                <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. New York, Mumbai" />
              </div>
              <div className="space-y-1.5">
                <Label>Business Niche</Label>
                <Input value={queryPrefix} onChange={(e) => setQueryPrefix(e.target.value)} placeholder="e.g. Dental Clinics" />
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={submitting} className="flex-1 h-10 text-sm font-semibold">
                {submitting ? 'Initializing...' : 'Run Pipeline'}
                <Workflow className="ml-2 w-4 h-4" />
              </Button>
              <Button type="button" variant="outline" onClick={onReset} className="px-5">Reset</Button>
            </div>
          </form>
        </div>

        {/* Diagnostics */}
        <div className="surface-card p-5">
          <h3 className="text-sm font-semibold text-zinc-100 mb-4">Live Diagnostics</h3>
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-[11px] leading-relaxed text-zinc-400 h-[150px] overflow-auto whitespace-pre-wrap">
            {resultText || 'Awaiting telemetry...'}
          </div>
        </div>
      </div>

      {/* Workflow Logs + History */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6" ref={scrollAnchorRef}>
        <div className="lg:col-span-8">
          <div className="surface-card p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Workflow className="w-4 h-4 text-zinc-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Workflow Node Logs</h3>
              </div>
              <Badge variant="outline">Real-time Trace</Badge>
            </div>
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {executions.map((run) => (
                <div key={run.id} className="rounded-lg bg-zinc-800/40 border border-zinc-800 overflow-hidden">
                  <div className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3">
                      <div className={`h-2 w-2 rounded-full ${run.status === 'success' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      <div>
                        <p className="text-xs font-medium text-zinc-200">Run #{run.id.slice(-8)}</p>
                        <p className="text-[10px] text-zinc-500">{new Date(run.startedAt).toLocaleString()}</p>
                      </div>
                    </div>
                    <Badge variant={run.status === 'success' ? 'success' : 'danger'}>{run.status}</Badge>
                  </div>
                  <div className="px-3 pb-3 space-y-1.5">
                    {run.nodes.map((node) => (
                      <div key={node.name} className="flex items-center justify-between px-3 py-2 rounded-md bg-zinc-900/60 border border-zinc-800/50 text-[11px]">
                        <div className="flex items-center gap-2">
                          <span className="text-zinc-400">{node.name}</span>
                          <span className="text-[9px] text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded">{node.executionTime}ms</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-[10px] text-zinc-500"><span className="text-emerald-500">{node.itemsInput}</span> → <span className="text-emerald-400">{node.itemsOutput}</span></span>
                          <div className={`h-1.5 w-1.5 rounded-full ${node.status === 'success' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-4">
          <div className="surface-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <HistoryIcon className="w-4 h-4 text-zinc-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Conversion History</h3>
            </div>
            <div className="space-y-2 max-h-[500px] overflow-y-auto">
              {history.map((item, index) => (
                <div key={index} className="p-3 rounded-lg bg-zinc-800/40 border border-zinc-800 hover:border-zinc-700 transition-all">
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-xs font-medium text-zinc-200">{item.city}</p>
                    <Badge variant={item.ok ? 'success' : 'danger'} className="text-[9px]">{item.ok ? 'OK' : 'FAIL'}</Badge>
                  </div>
                  <p className="text-[11px] text-zinc-500 italic mb-2">"{item.query || 'Generic Search'}"</p>
                  <p className="text-[9px] text-zinc-600 text-right">{new Date(item.time).toLocaleTimeString()}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
