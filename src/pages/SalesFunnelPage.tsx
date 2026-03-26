import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, CheckCircle2, CircleAlert, Clock3, Workflow, Target, Cpu, History as HistoryIcon, LogOut, User, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
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

    const payload: { city: string; queryPrefix: string; startedAt: string; query?: string } = {
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

  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-transparent text-slate-100 selection:bg-emerald-500/30">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        
        {/* Header */}
        <header className="glass-card mb-8 rounded-3xl p-6 lg:p-8 animate-fade-in">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                <ShieldCheck className="size-3" />
                {user?.role === 'superadmin' ? 'Super Admin' : 'Sales Lead'}
              </div>
              <h1 className="text-gradient-emerald text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
                Sales Funnel
              </h1>
              <div className="flex items-center gap-2 text-xs text-slate-500 font-medium">
                <User className="size-3 text-emerald-400" />
                <span>Logged in as <span className="text-slate-300">{user?.name}</span></span>
              </div>
            </div>
            
            <div className="flex flex-wrap items-center gap-3">
              <div className="glass-card flex items-center gap-3 rounded-2xl px-4 py-2 text-xs font-medium mr-4">
                <div className={`h-2.5 w-2.5 rounded-full ring-4 ${
                  (typeof status === 'string' && status === 'running') ? 'bg-emerald-400 animate-pulse ring-emerald-400/20' :
                  ((typeof status === 'string' && status === 'success') || (typeof status !== 'string' && status.kind === 'ok')) ? 'bg-emerald-400 ring-emerald-400/20' :
                  ((typeof status === 'string' && status === 'idle') || (typeof status !== 'string' && status.kind === '')) ? 'bg-slate-500 ring-slate-500/20' :
                  'bg-rose-400 ring-rose-400/20'
                }`} />
                <span className="text-slate-200 uppercase tracking-widest text-[10px] font-black">
                  {typeof status === 'string' ? status : status.text}
                </span>
              </div>
              
              {user?.role === 'superadmin' && (
                <>
                  <Link to="/" className="glass-card rounded-2xl px-5 py-2.5 text-xs font-semibold text-slate-200 hover:bg-white/5 transition-all">
                    Builder
                  </Link>
                  <Link to="/twilio-messaging" className="glass-card border-rose-500/10 bg-rose-500/5 rounded-2xl px-5 py-2.5 text-xs font-semibold text-rose-100 hover:bg-rose-500/10 transition-all">
                    Messaging
                  </Link>
                </>
              )}

              <Button 
                variant="ghost" 
                onClick={logout}
                className="rounded-2xl px-4 py-2.5 text-xs font-bold text-rose-500 hover:bg-rose-500/10 transition-all flex items-center gap-2 border border-rose-500/10"
              >
                <LogOut className="size-3" /> Sign Out
              </Button>
            </div>
          </div>
        </header>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4 mb-8">
           <div className="glass-card p-5 rounded-3xl animate-fade-in [animation-delay:100ms]">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Total Runs</p>
                <div className="p-1.5 bg-emerald-500/10 rounded-lg text-emerald-400"><Activity className="size-4" /></div>
              </div>
              <p className="text-3xl font-bold font-heading text-slate-100">{executions.length}</p>
           </div>
           <div className="glass-card p-5 rounded-3xl animate-fade-in [animation-delay:150ms]">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Conversions</p>
                <div className="p-1.5 bg-emerald-500/10 rounded-lg text-emerald-400"><CheckCircle2 className="size-4" /></div>
              </div>
              <p className="text-3xl font-bold font-heading text-emerald-400">{successCount}</p>
           </div>
           <div className="glass-card p-5 rounded-3xl animate-fade-in [animation-delay:200ms]">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Anomalies</p>
                <div className="p-1.5 bg-rose-500/10 rounded-lg text-rose-400"><CircleAlert className="size-4" /></div>
              </div>
              <p className="text-3xl font-bold font-heading text-rose-400">{errorCount}</p>
           </div>
           <div className="glass-card p-5 rounded-3xl animate-fade-in [animation-delay:250ms]">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-500">Latest Active</p>
                <div className="p-1.5 bg-indigo-500/10 rounded-lg text-indigo-400"><Target className="size-4" /></div>
              </div>
              <p className="text-lg font-bold font-heading text-indigo-100 truncate">#{latestRun?.id || '-'}</p>
           </div>
        </div>

        {/* Bento Grid layout */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:grid-rows-[auto_auto]">
          
          {/* Main Controls - Left */}
          <div className="lg:col-span-12 grid gap-6 lg:grid-cols-2">
            
            {/* Campaign Config */}
            <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:300ms]">
              <div className="mb-6 flex items-center justify-between">
                <h3 className="font-heading text-lg font-semibold text-emerald-100">Launch Campaign</h3>
                <Cpu className="size-5 text-emerald-400/50" />
              </div>
              <form onSubmit={onSubmit} noValidate className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-[10px] uppercase tracking-wider text-slate-500">Target Region</Label>
                    <Input 
                      value={city} 
                      onChange={(e) => setCity(e.target.value)} 
                      placeholder="e.g. New York, Mumbai" 
                      className="h-11 bg-slate-950/50 border-white/5 rounded-xl focus:ring-emerald-500/20"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-[10px] uppercase tracking-wider text-slate-500">Business Niche</Label>
                    <Input 
                      value={queryPrefix} 
                      onChange={(e) => setQueryPrefix(e.target.value)} 
                      placeholder="e.g. Dental Clinics" 
                      className="h-11 bg-slate-950/50 border-white/5 rounded-xl focus:ring-emerald-500/20"
                    />
                  </div>
                </div>
                <div className="flex gap-3">
                   <Button type="submit" disabled={submitting} className="flex-1 h-12 bg-emerald-600 hover:bg-emerald-500 rounded-2xl font-bold shadow-lg shadow-emerald-600/20 transition-all active:scale-[0.98]">
                      {submitting ? 'Initializing...' : 'Run Pipeline'}
                      <Workflow className="ml-2 size-4" />
                   </Button>
                   <Button type="button" variant="outline" onClick={onReset} className="px-6 rounded-2xl h-12 border-white/5 hover:bg-white/5">
                      Reset
                   </Button>
                </div>
              </form>
            </div>

            {/* Diagnostics */}
            <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:350ms]">
              <h3 className="font-heading text-lg font-semibold text-emerald-100 mb-5">Live Diagnostics</h3>
              <div className="rounded-2xl border border-white/5 bg-slate-950/80 p-4 font-mono text-[11px] leading-relaxed text-emerald-400/90 h-[120px] overflow-auto">
                 {resultText || 'Awaiting telemetry...'}
              </div>
            </div>

          </div>

          {/* Detailed Logs Area */}
          <div className="lg:col-span-8 lg:row-start-2">
            <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:400ms]">
              <div className="mb-6 flex items-center justify-between">
                 <h3 className="font-heading text-lg font-semibold text-emerald-100">Workflow Node Logs</h3>
                 <Badge variant="outline" className="text-[10px]">Real-time Trace</Badge>
              </div>
              <div className="space-y-4 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar">
                {executions.map((run, idx) => (
                  <div key={run.id} className="rounded-2xl bg-white/5 border border-white/5 overflow-hidden transition-all group hover:bg-white/[0.08]">
                     <div className="flex items-center justify-between p-4 cursor-default">
                        <div className="flex items-center gap-4">
                           <div className={`h-2.5 w-2.5 rounded-full ${run.status === 'success' ? 'bg-emerald-500 shadow-[0_0_8px_emerald]' : 'bg-rose-500'}`}></div>
                           <div className="space-y-0.5">
                              <p className="text-xs font-bold font-heading text-slate-100 uppercase tracking-tight">Run #{run.id}</p>
                              <p className="text-[10px] text-slate-500">{new Date(run.startedAt).toLocaleString()}</p>
                           </div>
                        </div>
                        <Badge variant={run.status === 'success' ? 'success' : 'danger'} className="text-[9px] uppercase tracking-widest">{run.status}</Badge>
                     </div>
                     <div className="px-4 pb-4 space-y-2">
                        {run.nodes.map((node) => (
                          <div key={node.name} className="flex items-center justify-between px-3 py-2 rounded-xl bg-slate-950/40 border border-white/5 text-[11px]">
                             <div className="flex items-center gap-3">
                                <span className="text-slate-400">{node.name}</span>
                                <span className="text-[9px] text-slate-600 px-1.5 py-0.5 rounded bg-white/5">{node.executionTime}ms</span>
                             </div>
                             <div className="flex items-center gap-6">
                                <div className="text-[10px] text-slate-500">
                                   <span className="text-emerald-400/60">{node.itemsInput}</span> → <span className="text-emerald-400">{node.itemsOutput}</span>
                                </div>
                                <Badge variant={node.status === 'success' ? 'success' : 'danger'} className="size-2 rounded-full p-0 flex items-center justify-center">
                                   <div className={`size-1 rounded-full ${node.status === 'success' ? 'bg-emerald-400' : 'bg-rose-400'}`}></div>
                                </Badge>
                             </div>
                          </div>
                        ))}
                     </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="lg:col-span-4 lg:row-start-2">
             <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:450ms]">
                <div className="mb-6 flex items-center gap-2">
                   <HistoryIcon className="size-5 text-emerald-400/50" />
                   <h3 className="font-heading text-lg font-semibold text-emerald-100">Conversion History</h3>
                </div>
                <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2 custom-scrollbar text-[11px]">
                   {history.map((item, index) => (
                      <div key={index} className="p-4 rounded-2xl bg-white/5 border border-white/5 hover:border-emerald-500/20 transition-all">
                         <div className="flex items-center justify-between mb-2">
                            <p className="font-bold text-slate-200 uppercase tracking-tight">{item.city}</p>
                            <span className={`text-[9px] font-bold p-1 px-2 rounded-lg ${item.ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                               {item.ok ? 'DELIVERED' : 'BOUNCED'}
                            </span>
                         </div>
                         <p className="text-slate-500 italic mb-3">"{item.query || 'Generic Search'}"</p>
                         <p className="text-[9px] text-slate-600 text-right">{new Date(item.time).toLocaleTimeString()}</p>
                      </div>
                   ))}
                </div>
             </div>
          </div>

        </div>
      </div>
    </div>
  );
}

