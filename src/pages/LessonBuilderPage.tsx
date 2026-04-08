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
} from '../api/n8nClient';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';
import { Label } from '../components/ui/label';
import { Select } from '../components/ui/select';
import { Badge } from '../components/ui/badge';
import { PageHeader } from '../components/layout/PageHeader';
import {
  Workflow,
  Activity,
  Upload,
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  Play,
  Square,
  Zap,
  Clock,
} from 'lucide-react';

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
  const [language, setLanguage] = useState<string>('');
  const [curriculum, setCurriculum] = useState<string>('');
  const [classLevel, setClassLevel] = useState<string>('');
  const [subject, setSubject] = useState<string>('');
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
      if (typeof value === 'string' && value.trim()) return value;
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

  const n8nConfigured = useMemo(() => Boolean(import.meta.env.VITE_N8N_WEBHOOK_URL), []);
  const n8nWorkflowId = useMemo(
    () => (import.meta.env.VITE_N8N_WORKFLOW_ID ? String(import.meta.env.VITE_N8N_WORKFLOW_ID) : null),
    []
  );

  useEffect(() => {
    const loadExecutions = async () => {
      const list = await listExecutions(10, n8nWorkflowId);
      if (list && Array.isArray(list)) setRecentExecutions(list);
      else setRecentExecutions([]);
    };
    if (!showRecentExecutions || !n8nConfigured) {
      if (execRefreshRef.current) clearInterval(execRefreshRef.current);
      execRefreshRef.current = null;
      setRecentExecutions([]);
      setSelectedExecId(null);
      setSelectedNodeId(null);
      return;
    }
    void loadExecutions();
    execRefreshRef.current = setInterval(loadExecutions, 30_000);
    return () => {
      if (execRefreshRef.current) clearInterval(execRefreshRef.current);
      execRefreshRef.current = null;
    };
  }, [showRecentExecutions, n8nConfigured, n8nWorkflowId]);

  const handleSelectExecution = useCallback(async (id: string) => {
    if (selectedExecId === id) { setSelectedExecId(null); setSelectedNodeId(null); return; }
    setSelectedExecId(id);
    setSelectedNodeId(null);
    if (executionDetails[id]) return;
    setLoadingExecId(id);
    const detail = await fetchExecutionDetail(id);
    setLoadingExecId(null);
    if (detail) setExecutionDetails((prev) => ({ ...prev, [id]: detail }));
  }, [selectedExecId, executionDetails]);

  const resetProgress = useCallback(() => {
    setStepStates(PIPELINE_STEPS.reduce((acc, s) => ({ ...acc, [s.id]: 'pending' }), {} as Record<PipelineStepId, StepState>));
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
    setStepStates((prev) => PIPELINE_STEPS.reduce((acc, s) => ({ ...acc, [s.id]: 'done' }), { ...prev }));
  }, []);

  const setStepsDoneUpTo = useCallback((index: number) => {
    setStepStates((prev) => {
      const next = { ...prev };
      PIPELINE_STEPS.forEach((s, i) => { next[s.id] = i < index ? 'done' : i === index ? 'running' : 'pending'; });
      return next;
    });
  }, []);

  const setStepsErrorAt = useCallback((index: number) => {
    setStepStates((prev) => {
      const next = { ...prev };
      PIPELINE_STEPS.forEach((s, i) => { next[s.id] = i < index ? 'done' : i === index ? 'error' : 'pending'; });
      return next;
    });
  }, []);

  useEffect(() => {
    if (status !== 'running' || canPollExecution) return;
    rotateRef.current = setInterval(() => {
      setCurrentStepIndex((i) => {
        const next = Math.min(i + 1, PIPELINE_STEPS.length - 1);
        setStepsDoneUpTo(next);
        return next;
      });
    }, STEP_ROTATE_MS);
    return () => { if (rotateRef.current) clearInterval(rotateRef.current); rotateRef.current = null; };
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
      const runData = exec.data?.resultData?.runData;
      if (runData && typeof runData === 'object') {
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
          if (last.startTime > latestStart) { latestStart = last.startTime; latestNode = nodeName; }
        });
        const nodeLogList: NodeLogEntry[] = [];
        orderedNames.forEach((name) => {
          const runs = runData[name] as Array<{ startTime: number; executionTime?: number }>;
          const last = runs && runs[runs.length - 1];
          const startedAt = last && typeof last.startTime === 'number' ? new Date(last.startTime).toLocaleString() : undefined;
          const durationMs = last && typeof last.executionTime === 'number' ? Math.round(last.executionTime) : undefined;
          let nStatus: NodeLogStatus = 'done';
          if (latestNode && name === latestNode && exec.status === 'running') nStatus = 'running';
          else if (exec.status === 'error' && latestNode && name === latestNode) nStatus = 'error';
          nodeLogList.push({ name, status: nStatus, startedAt, durationMs });
        });
        setNodeLogs(nodeLogList);
        if (latestNode) {
          setCurrentNodeName(latestNode);
          const stepId = NODE_TO_STEP[latestNode];
          if (stepId) {
            const index = PIPELINE_STEPS.findIndex((s) => s.id === stepId);
            if (index >= 0) setStepsDoneUpTo(index);
          }
        }
      }
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };
  }, [executionId, status, setAllStepsDone, setStepsDoneUpTo]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    setPdfFiles(files);
    setCurrentFileIndex(-1);
  };

  const appendLog = (result: RunResult, statusOverride: ExecutionStatus) => {
    const now = new Date();
    let message: string | null = result.errorMessage ?? null;
    if (!message) message = extractErrorMessage(result.data);
    if (!message) { try { message = JSON.stringify(result.data, null, 2); } catch { message = 'No response body.'; } }
    const entry: LogEntry = { id: logs.length + 1, time: now.toLocaleString(), status: statusOverride, httpStatus: result.httpStatus, message, raw: result.data };
    setLogs((prev) => [entry, ...prev]);
  };

  const runAutomation = async (file: File | null, promptValue: string) => {
    setFormError(null);
    if (!language) {
      const message = 'Please select a language before starting.';
      const fallback: RunResult = { ok: false, httpStatus: 0, data: null, errorMessage: message };
      setFormError(message);
      appendLog(fallback, 'error');
      return;
    }
    resetProgress();
    setRunCount((prev) => prev + 1);
    try {
      setStatus('running');
      setStepState(PIPELINE_STEPS[0].id, 'running');
      const result = await triggerAutomation({ pdfFile: file, prompt: promptValue, language, curriculum, classLevel, subject });
      if (rotateRef.current) { clearInterval(rotateRef.current); rotateRef.current = null; }
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      if (result.executionId) {
        setExecutionId(result.executionId);
      } else if (canPollExecution) {
        appendLog({ ok: false, httpStatus: result.httpStatus, data: { message: 'Workflow did not return executionId.' } } as RunResult, 'error');
      }
      if (result.ok) {
        appendLog(result, 'success');
        if (!result.executionId || !canPollExecution) { setAllStepsDone(); setStatus('success'); }
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
      const fallback: RunResult = { ok: false, httpStatus: 0, data: null, errorMessage: error instanceof Error ? error.message : 'Unknown error triggering automation.' };
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
        } else { setIsBatchMode(false); }
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [status, isBatchMode, currentFileIndex, pdfFiles, prompt]);

  const handleRun = async () => {
    if (status === 'running') return;
    if (pdfFiles.length === 0) {
      const message = 'Please upload at least one PDF file.';
      const fallback: RunResult = { ok: false, httpStatus: 0, data: null, errorMessage: message };
      setFormError(message);
      appendLog(fallback, 'error');
      return;
    }
    if (pdfFiles.length > 1) { setIsBatchMode(true); setCurrentFileIndex(0); await runAutomation(pdfFiles[0], prompt); }
    else { setIsBatchMode(false); setCurrentFileIndex(0); await runAutomation(pdfFiles[0], prompt); }
  };

  const handleQuickStart = async () => {
    if (status === 'running') return;
    setPrompt("Generate a detailed VR lesson outline based on the PDF content. Include 5 key learning objectives and a scene breakdown for a VR classroom environment.");
    setLanguage("en"); setCurriculum("CBSE"); setClassLevel("7"); setSubject("Science");
    setIsBatchMode(false); setCurrentFileIndex(-1);
    await runAutomation(null, '');
  };

  const handleStop = () => {
    setIsBatchMode(false);
    if (status !== 'running') return;
    if (rotateRef.current) { clearInterval(rotateRef.current); rotateRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setStatus('idle');
    setExecutionId(null);
  };

  const totalSteps = dynamicNodes.length || PIPELINE_STEPS.length;
  const inferredIndexFromNode = currentNodeName && dynamicNodes.length ? dynamicNodes.indexOf(currentNodeName) : -1;
  const activeIndex = status === 'success' ? totalSteps - 1 : inferredIndexFromNode >= 0 ? inferredIndexFromNode : currentStepIndex;
  const progressPercent = status === 'idle' || totalSteps === 0 ? 0 : status === 'success' ? 100 : Math.max(0, Math.min(100, Math.round(((activeIndex + 1) / totalSteps) * 100)));

  const statusIndicator = (
    <div className="flex items-center gap-3">
      <div className={`h-2 w-2 rounded-full ${
        status === 'idle' ? 'bg-zinc-500' :
        status === 'running' ? 'bg-indigo-400 animate-pulse' :
        status === 'success' ? 'bg-emerald-400' :
        'bg-red-400'
      }`} />
      <span className="text-xs font-medium text-zinc-300 uppercase tracking-wide">
        {status === 'idle' ? 'Ready' : status}
      </span>
    </div>
  );

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Lesson Builder" subtitle="Generate VR lessons from PDF content using AI automation.">
        {statusIndicator}
      </PageHeader>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* Left Column: Upload + Prompt */}
        <div className="lg:col-span-7 space-y-6">

          {/* PDF Upload */}
          <div className="surface-card p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-zinc-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Content Source</h3>
              </div>
              <Badge variant="outline">PDF Required</Badge>
            </div>
            <label className="group relative flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-zinc-700 bg-zinc-900/50 transition-all hover:border-indigo-500/40 hover:bg-indigo-500/5">
              <input type="file" accept="application/pdf" multiple onChange={handleFileChange} disabled={status === 'running'} className="absolute inset-0 cursor-pointer opacity-0" />
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800 text-zinc-400 group-hover:text-indigo-400 group-hover:bg-indigo-500/10 transition-all">
                <Upload className="w-5 h-5" />
              </div>
              <div className="text-center">
                <p className="text-xs font-medium text-zinc-300">{pdfFiles.length > 0 ? `${pdfFiles.length} file(s) selected` : 'Drop PDF chapters here or click to browse'}</p>
                <p className="mt-1 text-[11px] text-zinc-500">{pdfFiles.length > 0 ? pdfFiles.map(f => f.name).join(', ') : 'Max size 50MB per file'}</p>
              </div>
            </label>
          </div>

          {/* AI Prompt */}
          <div className="surface-card p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-zinc-400" />
                <h3 className="text-sm font-semibold text-zinc-100">AI Context</h3>
              </div>
              <code className="text-[10px] text-zinc-500 font-mono bg-zinc-800 px-2 py-0.5 rounded">gpt-4o-mini</code>
            </div>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Customize the lesson generation prompt here..."
              rows={8}
              disabled={status === 'running'}
              className="min-h-[200px] text-[13px] leading-relaxed"
            />
          </div>
        </div>

        {/* Right Column: Metadata + Actions + Stats */}
        <div className="lg:col-span-5 space-y-6">

          {/* Metadata */}
          <div className="surface-card p-5">
            <h3 className="text-sm font-semibold text-zinc-100 mb-4">Lesson Metadata</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Language</Label>
                <Select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={status === 'running'}>
                  <option value="">Select...</option>
                  <option value="en">English (US)</option>
                  <option value="hi">Hindi (IN)</option>
                  <option value="de">German (DE)</option>
                  <option value="es">Spanish (ES)</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Curriculum</Label>
                <Select value={curriculum} onChange={(e) => setCurriculum(e.target.value)} disabled={status === 'running'}>
                  <option value="">Not set</option>
                  <option value="CBSE">CBSE</option>
                  <option value="RBSE">RBSE</option>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Grade Level</Label>
                <Select value={classLevel} onChange={(e) => setClassLevel(e.target.value)} disabled={status === 'running'}>
                  <option value="">Choose grade</option>
                  {[1,2,3,4,5,6,7,8].map(l => <option key={l} value={String(l)}>Class {l}</option>)}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Subject</Label>
                <Select value={subject} onChange={(e) => setSubject(e.target.value)} disabled={status === 'running'}>
                  <option value="">Select subject</option>
                  <option value="EVS">Environment</option>
                  <option value="English">English</option>
                  <option value="Maths">Mathematics</option>
                  <option value="Science">Science</option>
                  <option value="Social Science">Social Studies</option>
                </Select>
              </div>
            </div>

            {formError && (
              <p className="mt-3 text-xs text-red-400 font-medium">{formError}</p>
            )}

            <div className="mt-6 flex flex-col gap-2.5">
              <Button variant="primary" onClick={handleRun} disabled={status === 'running' || !n8nConfigured} className="w-full h-10 text-sm font-semibold">
                {status === 'running' ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Processing...</> : <><Play className="w-4 h-4 mr-2" /> Generate VR Lesson</>}
              </Button>
              {status === 'running' && (
                <Button variant="outline" onClick={handleStop} className="border-red-500/20 text-red-400 hover:bg-red-500/10">
                  <Square className="w-3 h-3 mr-2" /> Cancel Operation
                </Button>
              )}
              <Button variant="ghost" onClick={handleQuickStart} className="text-zinc-500 text-xs h-8">
                Try Sample Content
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="surface-card stat-card">
              <span className="stat-label">Builds</span>
              <span className="stat-value">{runCount}</span>
            </div>
            <div className="surface-card stat-card">
              <span className="stat-label">Progress</span>
              <span className="stat-value text-indigo-400">{progressPercent}%</span>
            </div>
          </div>
        </div>

        {/* Pipeline Progress — Full Width */}
        <div className="lg:col-span-12">
          <div className="surface-card p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Workflow className="w-4 h-4 text-zinc-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Automation Pipeline</h3>
              </div>
              <span className="text-xs text-zinc-500">{progressPercent}% complete</span>
            </div>

            {/* Progress Bar */}
            <div className="relative mb-5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="absolute h-full rounded-full bg-indigo-500 transition-all duration-1000 ease-in-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            {/* Stepper */}
            <div className="stepper flex-wrap gap-1">
              {(dynamicNodes.length ? dynamicNodes : PIPELINE_STEPS.map((s) => s.label)).map((name, idx) => {
                const isCurrent = currentNodeName && name === currentNodeName;
                const isDone = currentNodeName && dynamicNodes.length && dynamicNodes.indexOf(name) < dynamicNodes.indexOf(currentNodeName);
                const stepStatus = status === 'success' ? 'done' : isCurrent ? 'active' : isDone ? 'done' : '';

                return (
                  <React.Fragment key={name}>
                    {idx > 0 && <div className="stepper-connector" />}
                    <div className={`stepper-node ${stepStatus}`}>
                      <div className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold flex-shrink-0 ${
                        stepStatus === 'active' ? 'bg-indigo-500 text-white' :
                        stepStatus === 'done' ? 'bg-emerald-500/20 text-emerald-400' :
                        'bg-zinc-800 text-zinc-600'
                      }`}>
                        {stepStatus === 'done' ? <CheckCircle2 className="w-3 h-3" /> : idx + 1}
                      </div>
                      <span>{name}</span>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>

        {/* Execution Logs + History — Full Width, 2 columns */}
        <div className="lg:col-span-12 grid gap-6 lg:grid-cols-2">

          {/* Live Execution */}
          <div className="surface-card p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-zinc-400" />
                <h3 className="text-sm font-semibold text-zinc-100">Live Execution</h3>
              </div>
              {status === 'running' && (
                <span className="text-[10px] text-emerald-400 font-medium flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Active
                </span>
              )}
            </div>
            <div className="space-y-2 max-h-[350px] overflow-y-auto">
              {nodeLogs.length > 0 ? nodeLogs.map((node) => (
                <div key={node.name} className="flex items-center justify-between p-3 rounded-lg bg-zinc-800/50 border border-zinc-800 hover:border-zinc-700 transition-all">
                  <div className="space-y-0.5">
                    <p className="text-xs font-medium text-zinc-200">{node.name}</p>
                    <p className="text-[10px] text-zinc-500">{node.startedAt} {node.durationMs && `• ${node.durationMs}ms`}</p>
                  </div>
                  <Badge variant={node.status === 'done' ? 'success' : node.status === 'running' ? 'warning' : 'danger'}>
                    {node.status}
                  </Badge>
                </div>
              )) : (
                <div className="flex flex-col items-center justify-center py-10 text-zinc-600 text-center">
                  <Workflow className="w-8 h-8 opacity-20 mb-2" />
                  <p className="text-xs">No active execution logs.</p>
                </div>
              )}
            </div>
          </div>

          {/* Session History */}
          <div className="surface-card p-5">
            <div className="flex items-center gap-2 mb-4">
              <Clock className="w-4 h-4 text-zinc-400" />
              <h3 className="text-sm font-semibold text-zinc-100">Session History</h3>
            </div>
            <div className="space-y-2 max-h-[350px] overflow-y-auto">
              {logs.length > 0 ? logs.map((log) => (
                <details key={log.id} className="group rounded-lg bg-zinc-800/50 border border-zinc-800 overflow-hidden hover:border-zinc-700 transition-all">
                  <summary className="flex items-center justify-between p-3 cursor-pointer list-none">
                    <div className="space-y-0.5">
                      <p className="text-[11px] text-zinc-500">{log.time}</p>
                      <p className={`text-xs font-medium ${log.status === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
                        {log.status === 'success' ? 'Successful Build' : 'Build Failure'}
                      </p>
                    </div>
                    <code className="text-[10px] font-mono text-zinc-500 bg-zinc-900 px-2 py-0.5 rounded">
                      HTTP {log.httpStatus}
                    </code>
                  </summary>
                  <div className="p-3 pt-0 text-[11px]">
                    <div className="h-px w-full bg-zinc-800 mb-2" />
                    <pre className="whitespace-pre-wrap font-mono text-zinc-400 leading-relaxed max-h-32 overflow-auto">
                      {log.message}
                    </pre>
                  </div>
                </details>
              )) : (
                <div className="flex flex-col items-center justify-center py-10 text-zinc-600 text-center">
                  <Activity className="w-8 h-8 opacity-20 mb-2" />
                  <p className="text-xs">History will appear after your first run.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LessonBuilderPage;
