import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import {
  canPollExecution,
  ExecutionStatus,
  fetchExecutionDetail,
  getExecutionStatus,
  N8nExecution,
  PIPELINE_STEPS,
  PipelineStepId,
  RunResult,
  triggerAutomation,
  listExecutions,
  N8nExecutionListItem
} from './api/n8nClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Button } from './components/ui/button';
import { Textarea } from './components/ui/textarea';
import { Label } from './components/ui/label';
import { Select } from './components/ui/select';
import { Badge } from './components/ui/badge';
import { JsonView } from './components/JsonView';
import { Workflow, Activity } from 'lucide-react';
import SalesFunnelPage from './pages/SalesFunnelPage';
import TwilioMessagingPage from './pages/TwilioMessagingPage';
import LoginPage from './pages/LoginPage';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LogOut, User, ShieldCheck } from 'lucide-react';

type StepState = 'pending' | 'running' | 'done' | 'error';

interface LogEntry {
  id: number;
  time: string;
  status: ExecutionStatus;
  httpStatus: number;
  message: string;
  raw?: unknown;
}

type NodeLogStatus = 'pending' | 'running' | 'done' | 'error';

interface NodeLogEntry {
  name: string;
  status: NodeLogStatus;
  startedAt?: string;
  durationMs?: number;
}

const POLL_INTERVAL_MS = 2500;
const STEP_ROTATE_MS = 4000;

// Optional mapping from n8n node names to high-level pipeline steps.
const NODE_TO_STEP: Partial<Record<string, PipelineStepId>> = {
  'Receive PDF & prompt': 'receive',
  'Extract text from PDF': 'extract',
  'Generate lesson (OpenAI)': 'ai',
  'Parse & split topics': 'topics',
  'Generate skyboxes': 'skybox',
  'Save to Firebase & Sheets': 'save'
};

const LessonBuilderPage: React.FC = () => {
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(-1);
  const [isBatchMode, setIsBatchMode] = useState<boolean>(false);
  const [prompt, setPrompt] = useState<string>('');
  const [language, setLanguage] = useState<string>(''); // required
  const [curriculum, setCurriculum] = useState<string>(''); // optional
  const [classLevel, setClassLevel] = useState<string>(''); // optional
  const [subject, setSubject] = useState<string>(''); // optional
  const [status, setStatus] = useState<ExecutionStatus>('idle');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [runCount, setRunCount] = useState(0);
  const [stepStates, setStepStates] = useState<Record<PipelineStepId, StepState>>(() =>
    PIPELINE_STEPS.reduce((acc, s) => ({ ...acc, [s.id]: 'pending' }), {} as Record<PipelineStepId, StepState>)
  );
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [currentNodeName, setCurrentNodeName] = useState<string | null>(null);
  const [dynamicNodes, setDynamicNodes] = useState<string[]>([]);
  const [nodeLogs, setNodeLogs] = useState<NodeLogEntry[]>([]);
  const [recentExecutions, setRecentExecutions] = useState<N8nExecutionListItem[]>([]);
  const [selectedExecId, setSelectedExecId] = useState<string | null>(null);
  const [executionDetails, setExecutionDetails] = useState<Record<string, N8nExecution>>({});
  const [loadingExecId, setLoadingExecId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const rotateRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);  
  const execRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const RECENT_EXECUTIONS_TOGGLE_KEY = 'learnxr_show_recent_executions';
  const [showRecentExecutions, setShowRecentExecutions] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RECENT_EXECUTIONS_TOGGLE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const extractErrorMessage = useCallback((data: unknown): string | null => {
    if (!data || typeof data !== 'object') return null;

    const obj = data as Record<string, unknown>;

    const directKeys = ['error', 'message', 'cause', 'description'];
    for (const key of directKeys) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }

    if (obj.error && typeof obj.error === 'object') {
      const nested = extractErrorMessage(obj.error);
      if (nested) return nested;
    }

    if (obj.data && typeof obj.data === 'object') {
      const nested = extractErrorMessage(obj.data);
      if (nested) return nested;
    }

    return null;
  }, []);

  const n8nConfigured = useMemo(
    () => Boolean(import.meta.env.VITE_N8N_WEBHOOK_URL),
    []
  );
  const n8nWorkflowId = useMemo(
    () => (import.meta.env.VITE_N8N_WORKFLOW_ID ? String(import.meta.env.VITE_N8N_WORKFLOW_ID) : null),
    []
  );

  useEffect(() => {
    const loadExecutions = async () => {
      const list = await listExecutions(10, n8nWorkflowId);
      if (list && Array.isArray(list)) {
        setRecentExecutions(list);
      } else {
        setRecentExecutions([]);
      }
    };

    // Budget mode: stop polling when toggle is OFF.
    if (!showRecentExecutions || !n8nConfigured) {
      if (execRefreshRef.current) clearInterval(execRefreshRef.current);
      execRefreshRef.current = null;
      setRecentExecutions([]);
      setSelectedExecId(null);
      setSelectedNodeId(null);
      return;
    }

    void loadExecutions();
    // Auto-refresh every 30 s (only when toggle is ON)
    execRefreshRef.current = setInterval(loadExecutions, 30_000);

    return () => {
      if (execRefreshRef.current) clearInterval(execRefreshRef.current);
      execRefreshRef.current = null;
    };
  }, [showRecentExecutions, n8nConfigured, n8nWorkflowId]);

  const handleSelectExecution = useCallback(async (id: string) => {
    if (selectedExecId === id) {
      setSelectedExecId(null);
      setSelectedNodeId(null);
      return;
    }
    setSelectedExecId(id);
    setSelectedNodeId(null);
    if (executionDetails[id]) return; // already cached
    setLoadingExecId(id);
    const detail = await fetchExecutionDetail(id);
    setLoadingExecId(null);
    if (detail) {
      setExecutionDetails((prev) => ({ ...prev, [id]: detail }));
    }
  }, [selectedExecId, executionDetails]);

  const resetProgress = useCallback(() => {
    setStepStates(
      PIPELINE_STEPS.reduce((acc, s) => ({ ...acc, [s.id]: 'pending' }), {} as Record<PipelineStepId, StepState>)
    );
    setCurrentStepIndex(0);
    setExecutionId(null);
    setCurrentNodeName(null);
    setDynamicNodes([]);
    setNodeLogs([]);
  }, []);

  const setStepState = useCallback((stepId: PipelineStepId, state: StepState) => {
    setStepStates((prev) => ({ ...prev, [stepId]: state }));
  }, []);

  const setAllStepsDone = useCallback(() => {
    setStepStates((prev) =>
      PIPELINE_STEPS.reduce((acc, s) => ({ ...acc, [s.id]: 'done' }), { ...prev })
    );
  }, []);

  const setStepsDoneUpTo = useCallback((index: number) => {
    setStepStates((prev) => {
      const next = { ...prev };
      PIPELINE_STEPS.forEach((s, i) => {
        next[s.id] = i < index ? 'done' : i === index ? 'running' : 'pending';
      });
      return next;
    });
  }, []);

  const setStepsErrorAt = useCallback((index: number) => {
    setStepStates((prev) => {
      const next = { ...prev };
      PIPELINE_STEPS.forEach((s, i) => {
        next[s.id] = i < index ? 'done' : i === index ? 'error' : 'pending';
      });
      return next;
    });
  }, []);

  useEffect(() => {
    // When we can poll the execution from n8n, we rely on real data instead of a fake rotation.
    if (status !== 'running' || canPollExecution) return;
    rotateRef.current = setInterval(() => {
      setCurrentStepIndex((i) => {
        const next = Math.min(i + 1, PIPELINE_STEPS.length - 1);
        setStepsDoneUpTo(next);
        return next;
      });
    }, STEP_ROTATE_MS);
    return () => {
      if (rotateRef.current) clearInterval(rotateRef.current);
      rotateRef.current = null;
    };
  }, [status, setStepsDoneUpTo]);

  useEffect(() => {
    if (!executionId || status !== 'running') return;
    const poll = async () => {
      const exec: N8nExecution | null = await getExecutionStatus(executionId);
      if (!exec) return;

      if (exec.finished) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setAllStepsDone();
        setStatus(exec.status === 'error' ? 'error' : 'success');
        setCurrentNodeName(null);
        return;
      }

      // If the execution is still running, derive the latest node from runData (if available)
      const runData = exec.data?.resultData?.runData;
      if (runData && typeof runData === 'object') {
        // Build a sorted list of node names based on their first start time
        const timeline: Array<{ name: string; firstStart: number }> = [];
        Object.entries(runData).forEach(([nodeName, runs]) => {
          const typedRuns = runs as Array<{ startTime: number; executionTime?: number }>;
          if (!typedRuns.length) return;
          const first = typedRuns[0];
          if (!first) return;
          timeline.push({ name: nodeName, firstStart: first.startTime });
        });
        timeline.sort((a, b) => a.firstStart - b.firstStart);
        const orderedNames = timeline.map((t) => t.name);
        setDynamicNodes(orderedNames);

        let latestNode: string | null = null;
        let latestStart = -Infinity;

        Object.entries(runData).forEach(([nodeName, runs]) => {
          const typedRuns = runs as Array<{ startTime: number; executionTime?: number }>;
          const last = typedRuns[typedRuns.length - 1];
          if (!last) return;
          if (last.startTime > latestStart) {
            latestStart = last.startTime;
            latestNode = nodeName;
          }
        });

        const nodeLogList: NodeLogEntry[] = [];
        orderedNames.forEach((name) => {
          const runs = runData[name] as Array<{ startTime: number; executionTime?: number }>;
          const last = runs && runs[runs.length - 1];
          const startedAt =
            last && typeof last.startTime === 'number'
              ? new Date(last.startTime).toLocaleString()
              : undefined;
          const durationMs =
            last && typeof last.executionTime === 'number'
              ? Math.round(last.executionTime)
              : undefined;

          let status: NodeLogStatus = 'done';
          if (latestNode && name === latestNode && exec.status === 'running') {
            status = 'running';
          } else if (exec.status === 'error' && latestNode && name === latestNode) {
            status = 'error';
          }

          nodeLogList.push({
            name,
            status,
            startedAt,
            durationMs
          });
        });
        setNodeLogs(nodeLogList);

        if (latestNode) {
          setCurrentNodeName(latestNode);

          const stepId = NODE_TO_STEP[latestNode];
          if (stepId) {
            const index = PIPELINE_STEPS.findIndex((s) => s.id === stepId);
            if (index >= 0) {
              setStepsDoneUpTo(index);
            }
          }
        }
      }
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [executionId, status, setAllStepsDone, setStepsDoneUpTo]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    setPdfFiles(files);
    setCurrentFileIndex(-1); // reset index when files change
  };

  const appendLog = (result: RunResult, statusOverride: ExecutionStatus) => {
    const now = new Date();

    let message: string | null = result.errorMessage ?? null;

    if (!message) {
      message = extractErrorMessage(result.data);
    }

    if (!message) {
      try {
        message = JSON.stringify(result.data, null, 2);
      } catch {
        message = 'No response body.';
      }
    }

    const entry: LogEntry = {
      id: logs.length + 1,
      time: now.toLocaleString(),
      status: statusOverride,
      httpStatus: result.httpStatus,
      message,
      raw: result.data
    };

    const shouldLogToConsole =
      import.meta.env.DEV && (import.meta.env.VITE_LOG_TO_CONSOLE as string | undefined) !== 'false';

    const redact = (value: unknown, depth = 0): unknown => {
      if (depth > 6) return '[redacted:depth]';
      if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
      if (!value || typeof value !== 'object') return value;
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        const key = k.toLowerCase();
        if (
          key.includes('token') ||
          key.includes('api_key') ||
          key.includes('apikey') ||
          key.includes('authorization') ||
          key.includes('secret') ||
          key.includes('password')
        ) {
          out[k] = '[redacted]';
        } else {
          out[k] = redact(v, depth + 1);
        }
      }
      return out;
    };

    if (shouldLogToConsole) {
      // eslint-disable-next-line no-console
      console.groupCollapsed(
        `[n8n] ${statusOverride.toUpperCase()} • HTTP ${result.httpStatus || 'n/a'} • ${now.toLocaleTimeString()}`
      );
      // eslint-disable-next-line no-console
      console.log(entry.message);
      // eslint-disable-next-line no-console
      console.log('raw:', redact(entry.raw));
      // eslint-disable-next-line no-console
      console.groupEnd();
    }

    setLogs((prev) => [entry, ...prev]);
  };

  const runAutomation = async (file: File | null, promptValue: string) => {
    setFormError(null);
    if (!language) {
      const message = 'Please select a language before starting.';
      const fallback: RunResult = {
        ok: false,
        httpStatus: 0,
        data: null,
        errorMessage: message
      };
      setFormError(message);
      appendLog(fallback, 'error');
      return;
    }

    resetProgress();
    setRunCount((prev) => prev + 1);

    try {
      setStatus('running');
      setStepState(PIPELINE_STEPS[0].id, 'running');

      const result = await triggerAutomation({
        pdfFile: file,
        prompt: promptValue,
        language,
        curriculum,
        classLevel,
        subject
      });

      if (rotateRef.current) {
        clearInterval(rotateRef.current);
        rotateRef.current = null;
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }

      if (result.executionId) {
        // Happy path: use the execution id provided by the workflow webhook.
        setExecutionId(result.executionId);
      } else if (canPollExecution) {
        // If the workflow does not return an executionId, we cannot reliably track
        // node-by-node progress. Log a synthetic error entry so this is visible in the UI.
        appendLog(
          {
            ok: false,
            httpStatus: result.httpStatus,
            data: {
              message:
                'Workflow did not return executionId. Update the n8n workflow response to include {{$execution.id}} so the app can show per-node logs.'
            }
          } as RunResult,
          'error'
        );
      }

      if (result.ok) {
        appendLog(result, 'success');
        if (!result.executionId || !canPollExecution) {
          setAllStepsDone();
          setStatus('success');
        }
      } else {
        setStepsErrorAt(currentStepIndex);
        setStatus('error');
        appendLog(result, 'error');
      }
    } catch (error) {
      if (rotateRef.current) clearInterval(rotateRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      setStepsErrorAt(currentStepIndex);
      setStatus('error');
      const fallback: RunResult = {
        ok: false,
        httpStatus: 0,
        data: null,
        errorMessage:
          error instanceof Error ? error.message : 'Unknown error triggering automation.'
      };
      appendLog(fallback, 'error');
    }
  };

  useEffect(() => {
    if (isBatchMode && (status === 'success' || status === 'error')) {
      const timer = setTimeout(() => {
        if (currentFileIndex < pdfFiles.length - 1) {
          const nextIndex = currentFileIndex + 1;
          setCurrentFileIndex(nextIndex);
          runAutomation(pdfFiles[nextIndex], prompt);
        } else {
          setIsBatchMode(false);
        }
      }, 2000); // small delay between files
      return () => clearTimeout(timer);
    }
  }, [status, isBatchMode, currentFileIndex, pdfFiles, prompt]);

  const handleRun = async () => {
    if (status === 'running') return;

    if (pdfFiles.length === 0) {
      const message = 'Please upload at least one PDF file.';
      const fallback: RunResult = {
        ok: false,
        httpStatus: 0,
        data: null,
        errorMessage: message
      };
      setFormError(message);
      appendLog(fallback, 'error');
      return;
    }

    if (pdfFiles.length > 1) {
      setIsBatchMode(true);
      setCurrentFileIndex(0);
      await runAutomation(pdfFiles[0], prompt);
    } else {
      setIsBatchMode(false);
      setCurrentFileIndex(0);
      await runAutomation(pdfFiles[0], prompt);
    }
  };

  const handleQuickStart = async () => {
    if (status === 'running') return;
    setPrompt("Generate a detailed VR lesson outline based on the PDF content. Include 5 key learning objectives and a scene breakdown for a VR classroom environment.");
    setLanguage("en");
    setCurriculum("CBSE");
    setClassLevel("7");
    setSubject("Science");
    setIsBatchMode(false);
    setCurrentFileIndex(-1);
    await runAutomation(null, '');
  };

  const handleStop = () => {
    setIsBatchMode(false);
    if (status !== 'running') return;

    if (rotateRef.current) {
      clearInterval(rotateRef.current);
      rotateRef.current = null;
    }
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    setStatus('idle');
    setExecutionId(null);
  };

  const totalSteps = dynamicNodes.length || PIPELINE_STEPS.length;
  const inferredIndexFromNode =
    currentNodeName && dynamicNodes.length ? dynamicNodes.indexOf(currentNodeName) : -1;
  const activeIndex =
    status === 'success'
      ? totalSteps - 1
      : inferredIndexFromNode >= 0
      ? inferredIndexFromNode
      : currentStepIndex;

  const progressPercent =
    status === 'idle' || totalSteps === 0
      ? 0
      : status === 'success'
      ? 100
      : Math.max(0, Math.min(100, Math.round(((activeIndex + 1) / totalSteps) * 100)));

  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-transparent text-slate-100 selection:bg-indigo-500/30">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        
        {/* Header */}
        <header className="glass-card mb-8 rounded-3xl p-6 lg:p-8 animate-fade-in">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-indigo-300">
                <ShieldCheck className="size-3" />
                {user?.role === 'superadmin' ? 'Super Admin' : 'Content Builder'}
              </div>
              <h1 className="text-gradient-indigo text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
                Lesson Builder
              </h1>
              <div className="flex items-center gap-2 text-xs text-slate-500 font-medium">
                <User className="size-3 text-indigo-400" />
                <span>Logged in as <span className="text-slate-300">{user?.name}</span></span>
              </div>
            </div>
            
            <div className="flex flex-wrap items-center gap-3">
              <div className="glass-card flex items-center gap-3 rounded-2xl px-4 py-2 text-xs font-medium mr-4">
                <div className={`h-2.5 w-2.5 rounded-full ring-4 ${
                  status === 'idle' ? 'bg-slate-500 ring-slate-500/20' :
                  status === 'running' ? 'bg-indigo-400 animate-pulse ring-indigo-400/20' :
                  status === 'success' ? 'bg-emerald-400 ring-emerald-400/20' :
                  'bg-rose-400 ring-rose-400/20'
                }`} />
                <span className="text-slate-200 uppercase tracking-widest text-[10px] font-black">
                  {status === 'idle' ? 'Ready' : status}
                </span>
              </div>
              
              {user?.role === 'superadmin' && (
                <>
                  <Link to="/sales-funnel" className="glass-card rounded-2xl px-5 py-2.5 text-xs font-semibold text-slate-200 hover:bg-white/5 transition-all">
                    Sales Funnel
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

        {/* Bento Grid Layout */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:grid-rows-[auto_auto]">
          
          {/* Main Controls - Top Left */}
          <div className="lg:col-span-7 space-y-6">
            
            {/* PDF Upload */}
            <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:100ms]">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-heading text-lg font-semibold text-indigo-100">Content Source</h3>
                <Badge variant="outline" className="border-indigo-500/20 text-indigo-300">PDF Required</Badge>
              </div>
              <label className="group relative flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-indigo-500/10 bg-indigo-500/5 transition-all hover:border-indigo-500/30 hover:bg-indigo-500/10">
                <input
                  type="file"
                  accept="application/pdf"
                  multiple
                  onChange={handleFileChange}
                  disabled={status === 'running'}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400 ring-1 ring-indigo-500/20 transition-transform group-hover:scale-110">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                </div>
                <div className="text-center">
                  <p className="text-xs font-medium text-slate-200">
                    {pdfFiles.length > 0 ? `${pdfFiles.length} file(s) selected` : 'Drag & drop PDF chapters'}
                  </p>
                  <p className="mt-1 text-[10px] text-slate-500 text-center px-4">
                    {pdfFiles.length > 0 ? pdfFiles.map(f => f.name).join(', ') : 'Click to browse. Max size 50MB per file.'}
                  </p>
                </div>
              </label>
            </div>

            {/* OpenAI Settings */}
            <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:200ms]">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-heading text-lg font-semibold text-indigo-100">AI Context</h3>
                <code className="text-[10px] text-indigo-400 font-mono">model: gpt-4o-mini</code>
              </div>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Customize the lesson generation prompt here..."
                rows={8}
                disabled={status === 'running'}
                className="min-h-[220px] bg-slate-950/40 border-slate-800/60 focus:border-indigo-500/50 focus:ring-indigo-500/20 text-xs leading-relaxed transition-all"
              />
            </div>
          </div>

          {/* Sidebar Area - Top Right */}
          <div className="lg:col-span-5 space-y-6">
            
            {/* Metadata Bento Card */}
            <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:150ms]">
              <h3 className="font-heading text-lg font-semibold text-indigo-100 mb-5">Lesson Metadata</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-[10px] uppercase tracking-wider text-slate-500">Language</Label>
                  <Select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={status === 'running'} className="bg-slate-950/50 border-slate-800/60">
                    <option value="">Select...</option>
                    <option value="en">English (US)</option>
                    <option value="hi">Hindi (IN)</option>
                    <option value="de">German (DE)</option>
                    <option value="es">Spanish (ES)</option>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-[10px] uppercase tracking-wider text-slate-500">Curriculum</Label>
                  <Select value={curriculum} onChange={(e) => setCurriculum(e.target.value)} disabled={status === 'running'} className="bg-slate-950/50 border-slate-800/60">
                    <option value="">Not set</option>
                    <option value="CBSE">CBSE</option>
                    <option value="RBSE">RBSE</option>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-[10px] uppercase tracking-wider text-slate-500">Grade Level</Label>
                  <Select value={classLevel} onChange={(e) => setClassLevel(e.target.value)} disabled={status === 'running'} className="bg-slate-950/50 border-slate-800/60">
                    <option value="">Choose grade</option>
                    {[1,2,3,4,5,6,7,8].map(l => <option key={l} value={String(l)}>Class {l}</option>)}
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-[10px] uppercase tracking-wider text-slate-500">Subject</Label>
                  <Select value={subject} onChange={(e) => setSubject(e.target.value)} disabled={status === 'running'} className="bg-slate-950/50 border-slate-800/60">
                    <option value="">Select subject</option>
                    <option value="EVS">Environment</option>
                    <option value="English">English</option>
                    <option value="Maths">Mathematics</option>
                    <option value="Science">Science</option>
                    <option value="Social Science">Social Studies</option>
                  </Select>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-8 flex flex-col gap-3">
                <Button 
                  onClick={handleRun} 
                  disabled={status === 'running' || !n8nConfigured}
                  className="w-full h-12 bg-indigo-600 hover:bg-indigo-500 text-sm font-semibold rounded-2xl shadow-lg shadow-indigo-600/20 transition-all active:scale-[0.98]"
                >
                  {status === 'running' ? 'Processing...' : 'Generate VR Lesson'}
                </Button>
                {status === 'running' && (
                  <Button variant="outline" onClick={handleStop} className="border-rose-500/20 text-rose-300 hover:bg-rose-500/10 rounded-2xl h-11 transition-all">
                    Cancel Operation
                  </Button>
                )}
                <Button variant="ghost" onClick={handleQuickStart} className="text-slate-400 hover:text-white text-[11px] h-8">
                  Try Sample Content
                </Button>
              </div>
            </div>

            {/* Stats Card */}
            <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:250ms]">
               <div className="flex items-center justify-between mb-4">
                  <h3 className="font-heading text-sm font-semibold text-slate-300">Session Stats</h3>
                  <div className="h-2 w-2 rounded-full bg-emerald-500"></div>
               </div>
               <div className="grid grid-cols-2 gap-4">
                  <div className="rounded-2xl bg-white/5 p-4 py-3">
                    <p className="text-[10px] uppercase tracking-wider text-slate-500">Builds Finished</p>
                    <p className="text-xl font-bold font-heading text-indigo-100">{runCount}</p>
                  </div>
                  <div className="rounded-2xl bg-white/5 p-4 py-3">
                    <p className="text-[10px] uppercase tracking-wider text-slate-500">Success Rate</p>
                    <p className="text-xl font-bold font-heading text-emerald-400">92%</p>
                  </div>
               </div>
            </div>
          </div>

          {/* Pipeline Progress - Bottom Wide */}
          <div className="lg:col-span-12">
            <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:300ms]">
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h3 className="font-heading text-lg font-semibold text-indigo-100">Automation Timeline</h3>
                  <p className="text-xs text-slate-500 mt-1">Real-time node-by-node execution tracking from n8n.</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold font-heading text-indigo-400">{progressPercent}%</p>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">Global Progress</p>
                </div>
              </div>

              <div className="relative mb-8 h-2 w-full overflow-hidden rounded-full bg-slate-800/50">
                <div
                  className="absolute h-full rounded-full bg-gradient-to-r from-indigo-500 to-indigo-400 shadow-[0_0_12px_rgba(99,102,241,0.4)] transition-all duration-1000 ease-in-out"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>

              <div className="flex flex-wrap gap-3">
                {(dynamicNodes.length ? dynamicNodes : PIPELINE_STEPS.map((s) => s.label)).map((name, idx) => {
                  const isCurrent = currentNodeName && name === currentNodeName;
                  const isDone = currentNodeName && dynamicNodes.length && dynamicNodes.indexOf(name) < dynamicNodes.indexOf(currentNodeName);
                  const stepStatus = isCurrent ? 'running' : isDone ? 'done' : 'pending';

                  return (
                    <div 
                      key={name}
                      className={`flex items-center gap-3 rounded-2xl border px-4 py-2.5 transition-all ${
                        stepStatus === 'running' ? 'border-indigo-400 bg-indigo-400/10 text-indigo-100 shadow-lg shadow-indigo-500/10' :
                        stepStatus === 'done' ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300' :
                        'border-slate-800 bg-slate-900/40 text-slate-500'
                      }`}
                    >
                      <div className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                        stepStatus === 'running' ? 'bg-indigo-400 text-indigo-950 animate-pulse' :
                        stepStatus === 'done' ? 'bg-emerald-500/20 text-emerald-400' :
                        'bg-slate-800 text-slate-600'
                      }`}>
                        {stepStatus === 'done' ? '✓' : idx + 1}
                      </div>
                      <span className="text-[11px] font-semibold">{name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Logs and Logs - Bottom split or wide */}
          <div className="lg:col-span-12 grid gap-6 lg:grid-cols-2">
            
            {/* Run Logs */}
            <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:350ms]">
               <div className="flex items-center justify-between mb-5">
                  <h3 className="font-heading text-lg font-semibold text-indigo-100">Live Execution</h3>
                   {showRecentExecutions && (
                    <span className="text-[10px] text-emerald-400 font-medium animate-pulse flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                      Polling Active
                    </span>
                   )}
               </div>
               
               <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                  {nodeLogs.length > 0 ? nodeLogs.map((node) => (
                      <div key={node.name} className="flex items-center justify-between p-3 rounded-2xl bg-white/5 border border-white/5 hover:border-indigo-500/20 transition-all group">
                         <div className="space-y-1">
                            <p className="text-[11px] font-semibold text-slate-100 group-hover:text-indigo-300 transition-colors uppercase tracking-tight">{node.name}</p>
                            <p className="text-[9px] text-slate-500">{node.startedAt} {node.durationMs && `• ${node.durationMs}ms`}</p>
                         </div>
                         <Badge variant={node.status === 'done' ? 'success' : node.status === 'running' ? 'warning' : 'danger'} className="text-[9px] h-5">
                            {node.status}
                         </Badge>
                      </div>
                  )) : (
                    <div className="flex flex-col items-center justify-center py-12 text-slate-500 text-center">
                       <Workflow className="size-8 opacity-20 mb-3" />
                       <p className="text-xs">No active execution logs to display.</p>
                    </div>
                  )}
               </div>
            </div>

            {/* Session History */}
            <div className="glass-card p-6 rounded-3xl animate-fade-in [animation-delay:400ms]">
               <h3 className="font-heading text-lg font-semibold text-indigo-100 mb-5">Session History</h3>
               <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                  {logs.length > 0 ? logs.map((log) => (
                    <details key={log.id} className="group rounded-2xl bg-white/5 border border-white/5 overflow-hidden transition-all hover:bg-white/[0.08]">
                       <summary className="flex items-center justify-between p-3 cursor-pointer list-none">
                          <div className="space-y-1">
                             <p className="text-[10px] text-slate-500">{log.time}</p>
                             <p className={`text-[11px] font-bold ${log.status === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {log.status === 'success' ? 'SUCCESSFUL BUILD' : 'BUILD FAILURE'}
                             </p>
                          </div>
                          <div className="text-[10px] font-mono text-slate-400 bg-slate-950/40 px-2 py-0.5 rounded-lg ring-1 ring-white/5">
                             HTTP {log.httpStatus}
                          </div>
                       </summary>
                       <div className="p-3 pt-0 text-[10px]">
                          <div className="h-px w-full bg-white/5 mb-3"></div>
                          <pre className="whitespace-pre-wrap font-mono text-slate-300/80 leading-relaxed max-h-40 overflow-auto">
                             {log.message}
                          </pre>
                       </div>
                    </details>
                  )) : (
                     <div className="flex flex-col items-center justify-center py-12 text-slate-500 text-center">
                        <Activity className="size-8 opacity-20 mb-3" />
                        <p className="text-xs">History will appear after your first run.</p>
                     </div>
                  )}
               </div>
            </div>

          </div>

        </div>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'builder']}>
              <LessonBuilderPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/sales-funnel"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'salesperson']}>
              <SalesFunnelPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/twilio-messaging"
          element={
            <ProtectedRoute allowedRoles={['superadmin', 'whatsapp_manager']}>
              <TwilioMessagingPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
};

export default App;
