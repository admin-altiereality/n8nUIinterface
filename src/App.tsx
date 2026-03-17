import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { JsonView } from './components/JsonView';

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

const App: React.FC = () => {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
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

  useEffect(() => {
    const loadExecutions = async () => {
      const list = await listExecutions(20);
      if (list && Array.isArray(list)) {
        setRecentExecutions(list);
      }
    };
    loadExecutions();
    // Auto-refresh every 30 s
    execRefreshRef.current = setInterval(loadExecutions, 30_000);
    return () => {
      if (execRefreshRef.current) clearInterval(execRefreshRef.current);
    };
  }, []);

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
    const file = event.target.files?.[0] ?? null;
    setPdfFile(file);
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

  const handleRun = async () => {
    if (status === 'running') return;
    await runAutomation(pdfFile, prompt);
  };

  const handleQuickStart = async () => {
    if (status === 'running') return;
    await runAutomation(null, '');
  };

  const handleStop = () => {
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

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 pb-10 pt-8 lg:px-6">
        <header className="flex flex-col gap-4 rounded-2xl border border-slate-800/70 bg-slate-900/80 px-5 py-5 lg:px-6 lg:py-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">
                LearnXR Lesson Builder
              </h1>
              <p className="max-w-2xl text-xs leading-relaxed text-slate-400 sm:text-[13px]">
                Upload a chapter PDF, tweak the OpenAI prompt, and run the PDF-to-VR-lesson pipeline
                through n8n.
              </p>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/90 px-3.5 py-1.5 text-[11px] text-slate-200 shadow-sm">
              <span
                className={`h-2 w-2 rounded-full ${
                  status === 'idle'
                    ? 'bg-slate-500'
                    : status === 'running'
                    ? 'bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.9)]'
                    : status === 'success'
                    ? 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.9)]'
                    : 'bg-rose-400 shadow-[0_0_12px_rgba(248,113,113,0.9)]'
                }`}
              />
              <span className="font-medium tracking-tight">
                {status === 'idle' && 'Idle'}
                {status === 'running' && 'Running…'}
                {status === 'success' && 'Last run: success'}
                {status === 'error' && 'Last run: error'}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-slate-400">
            <span>
              Runs this session:{' '}
              <span className="font-semibold text-slate-200">{runCount}</span>
            </span>
            {!n8nConfigured && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[10px] font-medium text-amber-100">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                Set <code className="font-mono text-[10px]">VITE_N8N_WEBHOOK_URL</code> in{' '}
                <code className="font-mono text-[10px]">.env</code> to enable the workflow.
              </span>
            )}
          </div>
        </header>

        <main className="grid gap-5 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)] lg:gap-6">
          <section className="space-y-5">
            <Card className="border-slate-800/70 bg-slate-900">
              <CardHeader>
                <CardTitle>1. PDF upload</CardTitle>
                <CardDescription>
                  Choose the chapter PDF to send to n8n. It can be uploaded or processed inside your
                  workflow.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <label className="group relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-700/80 bg-slate-950/70 px-5 py-5 text-xs text-slate-200 transition-colors hover:border-slate-400 hover:bg-slate-900/80">
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={handleFileChange}
                    disabled={status === 'running'}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                  <span className="rounded-full bg-slate-900/80 px-3 py-0.5 text-[11px] font-medium text-slate-200 ring-1 ring-slate-700/70">
                    {pdfFile ? 'PDF selected' : 'Choose a PDF file'}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {pdfFile
                      ? `${pdfFile.name} • ${(pdfFile.size / (1024 * 1024)).toFixed(2)} MB`
                      : 'Click to browse a chapter PDF (PDF only)'}
                  </span>
                </label>
              </CardContent>
            </Card>

            <Card className="border-slate-800/70 bg-slate-900">
              <CardHeader>
                <CardTitle>2. OpenAI prompt</CardTitle>
                <CardDescription>
                  Override or extend the system prompt for the{' '}
                  <code className="rounded bg-slate-900/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-200">
                    Message a model
                  </code>{' '}
                  node in n8n (for example{' '}
                  <code className="rounded bg-slate-900/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-200">
                    {'{{$json["prompt"]}}'}
                  </code>
                  ).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Paste or edit the OpenAI prompt. It will be sent as `prompt` to the n8n webhook."
                  rows={10}
                  disabled={status === 'running'}
                  className="min-h-[170px] text-xs leading-relaxed"
                />
              </CardContent>
            </Card>
          </section>

          <section className="space-y-5">
            <Card className="border-slate-800/70 bg-slate-900">
              <CardHeader>
                <CardTitle>3. Lesson metadata</CardTitle>
                <CardDescription>
                  Configure language, curriculum, class, and subject. All values are forwarded to
                  n8n with the PDF and prompt.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="language" className="text-[11px] text-slate-400">
                      Language
                    </Label>
                    <Select
                      id="language"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      disabled={status === 'running'}
                    >
                      <option value="">Select language…</option>
                      <option value="en">English</option>
                      <option value="hi">Hindi</option>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="curriculum" className="text-[11px] text-slate-400">
                      Curriculum
                    </Label>
                    <Select
                      id="curriculum"
                      value={curriculum}
                      onChange={(e) => setCurriculum(e.target.value)}
                      disabled={status === 'running'}
                    >
                      <option value="">Not set (optional)</option>
                      <option value="CBSE">CBSE</option>
                      <option value="RBSE">RBSE</option>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="classLevel" className="text-[11px] text-slate-400">
                      Class
                    </Label>
                    <Select
                      id="classLevel"
                      value={classLevel}
                      onChange={(e) => setClassLevel(e.target.value)}
                      disabled={status === 'running'}
                    >
                      <option value="">Not set (optional)</option>
                      <option value="1">Class 1</option>
                      <option value="2">Class 2</option>
                      <option value="3">Class 3</option>
                      <option value="4">Class 4</option>
                      <option value="5">Class 5</option>
                      <option value="6">Class 6</option>
                      <option value="7">Class 7</option>
                      <option value="8">Class 8</option>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="subject" className="text-[11px] text-slate-400">
                      Subject
                    </Label>
                    <Select
                      id="subject"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      disabled={status === 'running'}
                    >
                      <option value="">Not set (optional)</option>
                      <option value="EVS">EVS</option>
                      <option value="English">English</option>
                      <option value="Maths">Maths</option>
                      <option value="Science">Science</option>
                      <option value="Social Science">Social Science</option>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-800/70 bg-slate-900">
              <CardHeader>
                <CardTitle>4. Run workflow</CardTitle>
                <CardDescription>
                  Start or stop the n8n automation using the current PDF and prompt.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Button
                      type="button"
                      onClick={handleRun}
                      disabled={status === 'running' || !n8nConfigured}
                      className="px-4 text-xs"
                    >
                      {status === 'running' ? 'Running…' : 'Start Workflow'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleStop}
                      disabled={status !== 'running'}
                      className="border-rose-500/70 px-3 text-[11px] text-rose-100 hover:bg-rose-500/10 hover:border-rose-400"
                    >
                      Stop workflow
                    </Button>
                  </div>
                  {formError && (
                    <p className="rounded-md border border-rose-500/50 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-100">
                      {formError}
                    </p>
                  )}
                  {!n8nConfigured && (
                    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-100">
                      Set <code className="font-mono text-[10px]">VITE_N8N_WEBHOOK_URL</code> in{' '}
                      <code className="font-mono text-[10px]">.env</code> to enable the workflow
                      buttons.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </section>
        </main>

        <section className="space-y-4">
          <Card className="border-slate-800/80 bg-slate-900/70">
            <CardHeader>
              <CardTitle>Pipeline progress</CardTitle>
              <CardDescription>
                Visual timeline of the PDF-to-VR-lesson workflow. Steps advance as the automation
                runs.
              </CardDescription>
              {currentNodeName && (
                <p className="mt-1 text-[11px] text-slate-400">
                  Current n8n node:{' '}
                  <span className="font-medium text-slate-100">{currentNodeName}</span>
                </p>
              )}
            </CardHeader>
            <CardContent>
              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
                  <span>Overall progress</span>
                  <span className="font-medium text-slate-100">{progressPercent}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800/90">
                  <div
                    className="h-full rounded-full bg-sky-400 transition-[width] duration-300 ease-out"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>
              <ol className="flex flex-wrap gap-2 text-[11px] text-slate-300">
                {(dynamicNodes.length ? dynamicNodes : PIPELINE_STEPS.map((s) => s.label)).map(
                  (name, index) => {
                    const isCurrent = currentNodeName && name === currentNodeName;
                    const isDone =
                      currentNodeName &&
                      dynamicNodes.length &&
                      dynamicNodes.indexOf(name) !== -1 &&
                      dynamicNodes.indexOf(name) <
                        (dynamicNodes.indexOf(currentNodeName) ?? 0);

                    const state: StepState = isCurrent ? 'running' : isDone ? 'done' : 'pending';

                    return (
                      <li
                        key={name}
                        className={`flex items-center gap-2 rounded-2xl border px-3 py-1.5 ${
                          state === 'pending'
                            ? 'border-slate-700/70 bg-slate-950/60 text-slate-400'
                            : state === 'running'
                            ? 'border-sky-400/80 bg-sky-500/10 text-sky-200'
                            : state === 'done'
                            ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-300'
                            : 'border-rose-500/70 bg-rose-500/10 text-rose-200'
                        }`}
                        aria-current={state === 'running' ? 'step' : undefined}
                      >
                        <span className="flex h-5 w-5 items-center justify-center rounded-full text-[10px]">
                          {state === 'done' && '✓'}
                          {state === 'pending' && (
                            <span className="h-1.5 w-1.5 rounded-full bg-slate-500/80" />
                          )}
                          {state === 'running' && (
                            <span className="h-3 w-3 animate-spin rounded-full border border-slate-500 border-t-sky-400" />
                          )}
                        </span>
                        <span className="font-medium">{name}</span>
                      </li>
                    );
                  }
                )}
              </ol>
            </CardContent>
          </Card>

          <Card className="border-slate-800/80 bg-slate-900/70">
            <CardHeader>
              <CardTitle>Execution & error logs</CardTitle>
              <CardDescription>
                Click any execution to see its node-by-node logs. Refreshes every 30 s.
              </CardDescription>
            </CardHeader>
            <CardContent>

              {/* ── Recent executions list ── */}
              {recentExecutions.length > 0 ? (
                <div className="mb-4 space-y-1.5 text-[11px]">
                  <p className="font-medium text-slate-400">Recent executions — click to expand logs</p>
                  <ul className="space-y-1">
                    {recentExecutions.map((exec) => {
                      const isSelected = selectedExecId === exec.id;
                      const isLoading = loadingExecId === exec.id;
                      const detail = executionDetails[exec.id];

                      // Build node list from cached detail
                      type NodeEntry = { 
                        name: string; 
                        startedAt?: string; 
                        durationMs?: number; 
                        status: 'done' | 'error' | 'running'; 
                        raw?: any; 
                        error?: any 
                      };
                      
                      let detailNodes: NodeEntry[] = [];
                      if (detail?.data?.resultData?.runData) {
                        const runData = detail.data.resultData.runData;
                        const timeline: Array<{ name: string; firstStart: number }> = [];
                        Object.entries(runData).forEach(([name, runs]) => {
                          const typedRuns = runs as Array<any>;
                          if (!typedRuns.length) return;
                          timeline.push({ name, firstStart: typedRuns[0].startTime });
                        });
                        timeline.sort((a, b) => a.firstStart - b.firstStart);
                        detailNodes = timeline.map(({ name }) => {
                          const runs = runData[name] as Array<any>;
                          const last = runs[runs.length - 1];
                          return {
                            name,
                            startedAt: last && typeof last.startTime === 'number'
                              ? new Date(last.startTime).toLocaleString()
                              : undefined,
                            durationMs: last && typeof last.executionTime === 'number'
                              ? Math.round(last.executionTime)
                              : undefined,
                            status: (last.error || (exec.status === 'error' && name === timeline[timeline.length - 1]?.name))
                              ? 'error'
                              : 'done',
                            raw: last.data,
                            error: last.error
                          };
                        });
                      }

                      return (
                        <li key={exec.id} className="rounded-lg border border-slate-700/80 bg-slate-950/60 overflow-hidden">
                          {/* Row header — always visible */}
                          <button
                            type="button"
                            onClick={() => handleSelectExecution(exec.id)}
                            className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-slate-800/50 transition-colors"
                          >
                            <div className="space-y-0.5 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-mono text-[10px] text-slate-300 truncate">
                                  {exec.id}
                                </span>
                                <span className="text-[10px] text-slate-500 whitespace-nowrap">
                                  {new Date(exec.startedAt).toLocaleString()}
                                </span>
                              </div>
                              {exec.stoppedAt && (
                                <span className="text-[10px] text-slate-500">
                                  Finished: {new Date(exec.stoppedAt).toLocaleString()}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span
                                className={`inline-flex h-5 items-center rounded-full px-2 text-[9px] font-semibold uppercase ${
                                  exec.status === 'success'
                                    ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/60'
                                    : exec.status === 'running'
                                    ? 'bg-sky-500/15 text-sky-300 border border-sky-400/60'
                                    : exec.status === 'error'
                                    ? 'bg-rose-500/15 text-rose-200 border border-rose-500/60'
                                    : 'bg-slate-600/20 text-slate-200 border border-slate-500/60'
                                }`}
                              >
                                {exec.status}
                              </span>
                              <span className="text-slate-500 text-[10px]">{isSelected ? '▲' : '▼'}</span>
                            </div>
                          </button>

                          {/* Expanded detail panel */}
                          {isSelected && (
                            <div className="border-t border-slate-700/60 px-2.5 py-2">
                              {isLoading ? (
                                <div className="flex items-center gap-2 text-[10px] text-slate-400 py-1">
                                  <span className="h-3 w-3 animate-spin rounded-full border border-slate-500 border-t-sky-400" />
                                  Loading node logs…
                                </div>
                              ) : detailNodes.length > 0 ? (
                                <div className="space-y-3">
                                  <ul className="space-y-1">
                                    {detailNodes.map((node) => {
                                      const isNodeSelected = selectedNodeId === `${exec.id}-${node.name}`;
                                      return (
                                        <li key={node.name} className="space-y-1">
                                          <button
                                            onClick={() => setSelectedNodeId(isNodeSelected ? null : `${exec.id}-${node.name}`)}
                                            className={`flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 transition-colors ${
                                              isNodeSelected
                                                ? 'border-sky-500/50 bg-sky-500/10'
                                                : 'border-slate-700/40 bg-slate-900/70 hover:bg-slate-800/80'
                                            }`}
                                          >
                                            <div className="space-y-0 text-left">
                                              <span className="font-medium text-slate-100 text-[10px]">{node.name}</span>
                                              <div className="flex items-center gap-2 text-[9px] text-slate-500">
                                                {node.startedAt && <span>{node.startedAt}</span>}
                                                {typeof node.durationMs === 'number' && (
                                                  <span>• {node.durationMs} ms</span>
                                                )}
                                              </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                              <span
                                                className={`inline-flex h-4 items-center rounded-full px-1.5 text-[9px] font-semibold uppercase ${
                                                  node.status === 'running'
                                                    ? 'bg-sky-500/15 text-sky-300 border border-sky-400/60'
                                                    : node.status === 'error'
                                                    ? 'bg-rose-500/15 text-rose-200 border border-rose-500/60'
                                                    : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/50'
                                                }`}
                                              >
                                                {node.status}
                                              </span>
                                              <span className="text-[10px] text-slate-500">{isNodeSelected ? '▲' : '▼'}</span>
                                            </div>
                                          </button>

                                          {/* Node Data Inspection */}
                                          {isNodeSelected && (
                                            <div className="space-y-3 rounded-lg border border-slate-800/60 bg-slate-950/40 p-2 ml-1">
                                              {node.error && (
                                                <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2">
                                                  <p className="font-bold text-rose-400 text-[9px] uppercase tracking-wider mb-1">Execution Error</p>
                                                  <p className="text-[10px] text-rose-200 leading-tight">{node.error.message}</p>
                                                  {node.error.description && (
                                                     <p className="mt-1 text-[9px] text-rose-300/70 italic">{node.error.description}</p>
                                                  )}
                                                </div>
                                              )}
                                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                <JsonView title="Output Data (main)" data={node.raw?.main} />
                                                <JsonView title="Input Data" data={node.raw?.input} />
                                              </div>
                                            </div>
                                          )}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                  
                                  {/* Global Execution Error */}
                                  {detail.data?.resultData?.error && (
                                    <div className="mt-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3">
                                      <p className="font-bold text-rose-300 text-[10px] uppercase mb-1">Workflow Error</p>
                                      <p className="text-[11px] text-slate-100">{detail.data.resultData.error.message}</p>
                                      {detail.data.resultData.error.stack && (
                                        <pre className="mt-2 max-h-32 overflow-auto text-[9px] text-rose-200/50 leading-relaxed font-mono">
                                          {detail.data.resultData.error.stack}
                                        </pre>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="text-[10px] text-slate-500 py-1">No node data available for this execution.</p>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <div className="mb-4 rounded-xl border border-dashed border-slate-700/80 bg-slate-950/50 px-4 py-3 text-[11px] text-slate-400">
                  No recent executions found. Ensure the n8n API is configured.
                </div>
              )}

              {/* ── Live node logs for the current run ── */}
              {nodeLogs.length > 0 && (
                <div className="mb-3 space-y-1.5 text-[11px]">
                  <p className="font-medium text-slate-400">Current execution (live node-by-node):</p>
                  <ul className="space-y-1.5">
                    {nodeLogs.map((node) => (
                      <li
                        key={node.name}
                        className="flex items-start justify-between gap-2 rounded-lg border border-slate-700/80 bg-slate-950/60 px-2.5 py-1.5"
                      >
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-slate-400">
                              {node.startedAt ?? '—'}
                            </span>
                            {typeof node.durationMs === 'number' && (
                              <span className="text-[10px] text-slate-500">
                                • {Math.round(node.durationMs)} ms
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-50">{node.name}</span>
                          </div>
                        </div>
                        <span
                          className={`mt-0.5 inline-flex h-5 items-center rounded-full px-2 text-[9px] font-semibold uppercase ${
                            node.status === 'running'
                              ? 'bg-sky-500/15 text-sky-300 border border-sky-400/60'
                              : node.status === 'error'
                              ? 'bg-rose-500/15 text-rose-200 border border-rose-500/60'
                              : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/50'
                          }`}
                        >
                          {node.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* ── Session run logs ── */}
              {logs.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-700/80 bg-slate-950/50 px-4 py-3 text-[11px] text-slate-400">
                  No runs yet this session. Trigger the automation to see logs here.
                </div>
              ) : (
                <div className="space-y-1.5">
                  <p className="font-medium text-[11px] text-slate-400">This session's run logs</p>
                  <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto text-[11px]">
                    {logs.map((log) => (
                      <li
                        key={log.id}
                        className={`rounded-xl border px-3 py-2 ${
                          log.status === 'success'
                            ? 'border-emerald-500/60 bg-emerald-500/10'
                            : log.status === 'error'
                            ? 'border-rose-500/70 bg-rose-500/10'
                            : 'border-slate-700/80 bg-slate-950/50'
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-3 text-[10px]">
                          <span className="text-slate-300">{log.time}</span>
                          <span className="font-semibold text-slate-50">
                            {log.status.toUpperCase()} • HTTP {log.httpStatus || 'n/a'}
                          </span>
                        </div>
                        <pre className="max-h-40 whitespace-pre-wrap break-words text-[10px] text-slate-100/90">
                          {log.message}
                        </pre>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
};

export default App;
