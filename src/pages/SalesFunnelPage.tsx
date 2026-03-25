import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, CheckCircle2, CircleAlert, Clock3, Workflow } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { Select } from '../components/ui/select';
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
import { ensureSignedInAnonymously, isFirebaseConfigured } from '../lib/firebase';

const storageKeys = {
  webhookUrl: 'sales_funnel_webhook_url',
  history: 'sales_funnel_history',
  endpointMode: 'sales_funnel_endpoint_mode',
  logs: 'sales_funnel_logs',
  executions: 'sales_funnel_n8n_executions',
  latestResultText: 'sales_funnel_latest_result_text'
} as const;

const endpointUrls = {
  test: 'https://n8n.altiereality.com/webhook-test/city-scrape-start',
  production: 'https://n8n.altiereality.com/webhook/city-scrape-start'
};

type Mode = 'test' | 'production' | 'custom';

type HeaderStatus = { text: string; kind: '' | 'ok' | 'warn' };

function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function makeId(prefix: string) {
  const rnd = Math.random().toString(16).slice(2);
  return `${prefix}-${Date.now()}-${rnd}`;
}

function toPillLabel(rawStatus: SalesFunnelExecutionStatus) {
  const value = String(rawStatus || '').toLowerCase();
  if (value === 'success') return 'SUCCESS';
  if (value === 'error') return 'ERROR';
  if (value === 'waiting') return 'WAITING';
  return 'UNKNOWN';
}

function runBadge(rawStatus: SalesFunnelExecutionStatus) {
  const value = String(rawStatus || '').toLowerCase();
  if (value === 'success') return 'success';
  if (value === 'error') return 'danger';
  return 'warning';
}

function nodeBadgeLabel(rawStatus: SalesFunnelExecutionNodeStatus) {
  const value = String(rawStatus || '').toLowerCase();
  if (value === 'success') return 'DONE';
  if (value === 'error') return 'ERROR';
  return 'RUNNING';
}

function nodeBadgeVariant(rawStatus: SalesFunnelExecutionNodeStatus) {
  const value = String(rawStatus || '').toLowerCase();
  if (value === 'success') return 'success';
  if (value === 'error') return 'danger';
  return 'warning';
}

function readMode(): Mode {
  return (localStorage.getItem(storageKeys.endpointMode) as Mode) || 'test';
}

function readUrl(mode: Mode): string {
  if (mode === 'test' || mode === 'production') return endpointUrls[mode];
  return localStorage.getItem(storageKeys.webhookUrl) || endpointUrls.test;
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
  const [executions, setExecutions] = useState<SalesFunnelExecution[]>(() =>
    readJsonStorage(storageKeys.executions, [])
  );

  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  const firebaseEnabled = useMemo(() => isFirebaseConfigured(), []);

  const successCount = useMemo(
    () => executions.filter((e) => String(e.status).toLowerCase() === 'success').length,
    [executions]
  );
  const errorCount = useMemo(
    () => executions.filter((e) => String(e.status).toLowerCase() === 'error').length,
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
    const next = items.slice(0, 5);
    setExecutions(next);
    localStorage.setItem(storageKeys.executions, JSON.stringify(next));
  };

  const appendLog = (entry: Omit<SalesFunnelLogEntry, 'at'> & { at?: string }) => {
    const withAt: SalesFunnelLogEntry = {
      type: entry.type,
      message: entry.message,
      at: entry.at || new Date().toISOString()
    };
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

  const onSaveStartUrl = () => {
    if (!webhookUrl.startsWith('http')) {
      setResultText('Please enter a valid webhook URL.');
      setStatus({ text: 'Invalid URL', kind: 'warn' });
      return;
    }
    localStorage.setItem(storageKeys.webhookUrl, webhookUrl);
    setResultText(`Start URL saved:\n${webhookUrl}`);
    setStatus({ text: 'Start URL saved', kind: 'ok' });
  };

  const onReset = () => {
    setCity('');
    setQueryPrefix('CBSE schools in');
    setResultText('Form reset.');
    setStatus({ text: 'Ready', kind: '' });
  };

  useEffect(() => {
    let alive = true;

    const loadFromFirebase = async () => {
      if (!firebaseEnabled) return;

      const items = await fetchRecentSalesFunnelRuns(5);
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

      // Keep localStorage aligned for instant UI and offline fallback.
      if (runs.length) localStorage.setItem(storageKeys.executions, JSON.stringify(runs));
      if (historyFromFb.length) localStorage.setItem(storageKeys.history, JSON.stringify(historyFromFb));
      if (logsFromFb.length) localStorage.setItem(storageKeys.logs, JSON.stringify(logsFromFb));
    };

    loadFromFirebase();
    return () => {
      alive = false;
    };
  }, [firebaseEnabled]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!city.trim()) {
      setResultText('City is required.');
      setStatus({ text: 'Validation error', kind: 'warn' });
      return;
    }

    setSubmitting(true);
    setStatus({ text: 'Submitting', kind: '' });

    const payload = {
      city: city.trim(),
      queryPrefix: queryPrefix.trim() || 'CBSE schools in',
      startedAt: new Date().toISOString()
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

    try {
      const response = await fetch(requestUrl.toString(), { method: 'GET' });
      statusCode = response.status;
      bodyText = await response.text();
      ok = response.ok;
      pushLog(
        'response',
        `Status ${statusCode}: ${bodyText || '(No response body)'}`
      );
    } catch (errorObj) {
      bodyText = errorObj instanceof Error ? errorObj.message : 'Unknown error';
      pushLog('error', bodyText);
    } finally {
      setSubmitting(false);
    }

    const formattedResultText =
      `Status: ${statusCode || 'NETWORK_ERROR'}\n` +
      `Endpoint: ${requestUrl.toString()}\n\n` +
      `${bodyText || '(No response body)'}`;

    setResultText(formattedResultText);
    localStorage.setItem(storageKeys.latestResultText, formattedResultText);
    setStatus({ text: ok ? 'Run started' : 'Run start failed', kind: ok ? 'ok' : 'warn' });

    const runId = makeId('local');
    const nodes = [
      {
        name: 'City Start Webhook',
        status: ok ? ('success' as const) : ('error' as const),
        executionTime: 0,
        itemsInput: 1,
        itemsOutput: ok ? 1 : 0
      }
    ];

    const localExecution: SalesFunnelExecution = {
      id: runId,
      status: ok ? 'success' : 'error',
      mode: 'ui-trigger',
      startedAt: payload.startedAt,
      stoppedAt: new Date().toISOString(),
      nodes
    };

    persistExecutions([localExecution, ...executions]);

    const historyEntry: SalesFunnelHistoryItem = {
      city: payload.city,
      queryPrefix: payload.queryPrefix,
      query: payload.query,
      ok,
      time: new Date().toISOString()
    };
    persistHistory([historyEntry, ...history]);

    if (firebaseEnabled) {
      const user = await ensureSignedInAnonymously();
      if (user) {
        await createSalesFunnelRunWithLogs({
          runId,
          userId: user.uid,
          city: payload.city,
          queryPrefix: payload.queryPrefix,
          query: payload.query,
          startedAt: payload.startedAt,
          stoppedAt: localExecution.stoppedAt || new Date().toISOString(),
          ok,
          endpointMode: mode,
          webhookUrl,
          requestUrl: requestUrl.toString(),
          responseStatus: statusCode,
          responseBody: bodyText,
          nodes,
          logEntries: logEntriesForStorage
        });
      }
    }

    // Scroll to keep the logs/results in view after submission.
    scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 md:px-6">
        <header className="flex flex-col justify-between gap-3 rounded-xl border border-border/70 bg-card/60 p-5 backdrop-blur md:flex-row md:items-start">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              n8n Workflow UI
            </p>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              Data Scrap + Email + WhatsApp Sales Funnel
            </h1>
            <p className="text-sm text-slate-400">
              Direct interface for workflow <span className="rounded-full border border-border bg-slate-900/50 px-2 py-0.5 font-mono text-xs">bJQC23r5at0P8qdA</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/"
              className="inline-flex items-center justify-center rounded-full border border-slate-700/80 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-200 shadow-sm transition-colors hover:bg-slate-900/90"
            >
              Lesson Builder
            </Link>
            <Badge
              variant={status.kind === 'ok' ? 'success' : status.kind === 'warn' ? 'warning' : 'secondary'}
              className="shrink-0"
            >
              {status.text}
            </Badge>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-slate-400">Last 5 runs</p>
              <p className="mt-1 text-2xl font-bold">{executions.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-slate-400">Success</p>
              <p className="mt-1 flex items-center gap-2 text-2xl font-bold text-emerald-400">
                <CheckCircle2 className="size-4" /> {successCount}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-slate-400">Error</p>
              <p className="mt-1 flex items-center gap-2 text-2xl font-bold text-rose-400">
                <CircleAlert className="size-4" /> {errorCount}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-slate-400">Latest run</p>
              <p className="mt-1 flex items-center gap-2 text-lg font-semibold">
                <Activity className="size-4 text-indigo-300" /> #{latestRun?.id || '-'}
              </p>
            </CardContent>
          </Card>
        </section>

        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Run Endpoint</CardTitle>
              <CardDescription>Choose environment and save webhook URL.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="endpointMode" className="text-[11px] text-slate-400">
                  Environment
                </Label>
                <Select
                  id="endpointMode"
                  value={mode}
                  onChange={(e) => onModeChange(e.target.value as Mode)}
                >
                  <option value="test">Test URL</option>
                  <option value="production">Production URL</option>
                  <option value="custom">Custom</option>
                </Select>
              </div>

              <div className="space-y-2 pt-1">
                <Label htmlFor="webhookUrl" className="text-[11px] text-slate-400">
                  Start URL
                </Label>
                <Input
                  id="webhookUrl"
                  type="url"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                />
              </div>

              <Button type="button" variant="secondary" className="mt-1 w-full" onClick={onSaveStartUrl}>
                Save Start URL
              </Button>
              <p className="text-xs text-slate-400">
                Sends GET params: <span className="font-mono">city, queryPrefix, query, startedAt</span>
              </p>
            </CardContent>
          </Card>

          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle>Execution & error logs</CardTitle>
              <CardDescription>Inspect node-by-node logs for each execution.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {!executions.length && (
                  <p className="text-sm text-slate-400">No execution records yet.</p>
                )}
                {executions.map((run, idx) => (
                  <details
                    key={run.id}
                    className="rounded-lg border border-slate-800/70 bg-slate-900/50 overflow-hidden"
                    open={idx === 0}
                  >
                    <summary className="cursor-pointer list-none flex w-full items-center justify-between gap-2 px-3 py-2 hover:bg-slate-800/40">
                      <div className="space-y-0.5">
                        <p className="font-medium text-slate-50">#{run.id}</p>
                        <p className="text-xs text-slate-400">
                          Finished:{' '}
                          {run.stoppedAt ? new Date(run.stoppedAt).toLocaleString() : '-'}
                        </p>
                      </div>
                      <Badge variant={runBadge(run.status)}>{toPillLabel(run.status)}</Badge>
                    </summary>
                    <div className="mt-2 px-3 pb-3">
                      <div className="space-y-2 rounded-md border border-slate-800/60 bg-slate-950/30 p-2">
                        {run.nodes.map((node) => (
                          <div
                            key={`${run.id}-${node.name}`}
                            className="flex items-start justify-between gap-3 rounded-md border border-slate-800/60 bg-slate-950/30 p-3"
                          >
                            <div>
                              <p className="text-sm font-medium text-slate-50">{node.name}</p>
                              <p className="mt-1 text-xs text-slate-400">
                                {run.startedAt ? new Date(run.startedAt).toLocaleString() : '-'} • {node.executionTime} ms
                              </p>
                              <p className="text-xs text-slate-400">
                                {node.itemsInput} in / {node.itemsOutput} out
                              </p>
                            </div>
                            <Badge variant={nodeBadgeVariant(node.status)}>{nodeBadgeLabel(node.status)}</Badge>
                          </div>
                        ))}
                        {!run.nodes.length && (
                          <p className="text-xs text-slate-400">No node-level logs available.</p>
                        )}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Start Scraping by City</CardTitle>
              <CardDescription>Enter city and start the workflow run.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={onSubmit} noValidate className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="city" className="text-[11px] text-slate-400">
                      City Name *
                    </Label>
                    <Input
                      id="city"
                      name="city"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      required
                      placeholder="Rajsamand"
                      disabled={submitting}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="queryPrefix" className="text-[11px] text-slate-400">
                      Search Query Prefix
                    </Label>
                    <Input
                      id="queryPrefix"
                      name="queryPrefix"
                      value={queryPrefix}
                      onChange={(e) => setQueryPrefix(e.target.value)}
                      placeholder="CBSE schools in"
                      disabled={submitting}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" className="flex-1" disabled={submitting}>
                    <Workflow className="size-4" />
                    {submitting ? 'Starting...' : 'Start Workflow'}
                  </Button>
                  <Button type="button" variant="outline" onClick={onReset} disabled={submitting}>
                    Reset
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Latest Submission</CardTitle>
              <CardDescription>Raw request/response diagnostics.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="max-h-56 overflow-auto rounded-md border border-slate-800/60 bg-slate-900/30 p-3 text-xs text-slate-200">
                {resultText}
              </pre>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock3 className="size-4" /> Execution Logs
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {!logs.length && <p className="text-sm text-slate-400">No logs yet.</p>}
              {logs.map((entry, index) => (
                <div
                  key={`${entry.at}-${index}`}
                  className="rounded-md border border-slate-800/70 bg-slate-900/30 p-3"
                >
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    {entry.type} • {new Date(entry.at).toLocaleString()}
                  </p>
                  <p className="mt-1 text-sm text-slate-100/90">{entry.message}</p>
                </div>
              ))}
              <div ref={scrollAnchorRef} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent City Runs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {!history.length && <p className="text-sm text-slate-400">No city runs tracked yet.</p>}
              {history.map((item, index) => (
                <div key={`${item.time}-${index}`} className="rounded-md border border-slate-800/70 bg-slate-900/30 p-3">
                  <p className="text-sm font-medium text-slate-50">{item.city || 'Unknown city'}</p>
                  <p className="text-xs text-slate-400">Query: {item.query || '-'}</p>
                  <p className="mt-1">
                    <Badge variant={item.ok ? 'success' : 'danger'}>
                      {item.ok ? 'Delivered' : 'Failed'} at {new Date(item.time).toLocaleString()}
                    </Badge>
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

