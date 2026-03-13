import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canPollExecution,
  ExecutionStatus,
  getExecutionStatus,
  N8nExecution,
  PIPELINE_STEPS,
  PipelineStepId,
  RunResult,
  triggerAutomation
} from './api/n8nClient';

type StepState = 'pending' | 'running' | 'done' | 'error';

interface LogEntry {
  id: number;
  time: string;
  status: ExecutionStatus;
  httpStatus: number;
  message: string;
  raw?: unknown;
}

const POLL_INTERVAL_MS = 2500;
const STEP_ROTATE_MS = 4000;

const App: React.FC = () => {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState<string>('');
  const [status, setStatus] = useState<ExecutionStatus>('idle');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [runCount, setRunCount] = useState(0);
  const [stepStates, setStepStates] = useState<Record<PipelineStepId, StepState>>(() =>
    PIPELINE_STEPS.reduce((acc, s) => ({ ...acc, [s.id]: 'pending' }), {} as Record<PipelineStepId, StepState>)
  );
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const rotateRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const n8nConfigured = useMemo(
    () => Boolean(import.meta.env.VITE_N8N_WEBHOOK_URL),
    []
  );

  const resetProgress = useCallback(() => {
    setStepStates(
      PIPELINE_STEPS.reduce((acc, s) => ({ ...acc, [s.id]: 'pending' }), {} as Record<PipelineStepId, StepState>)
    );
    setCurrentStepIndex(0);
    setExecutionId(null);
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
    if (status !== 'running') return;
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
      }
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [executionId, status, setAllStepsDone]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setPdfFile(file);
  };

  const appendLog = (result: RunResult, statusOverride: ExecutionStatus) => {
    const now = new Date();
    const message =
      result.errorMessage ??
      (typeof result.data === 'object' && result.data !== null && 'error' in result.data
        ? String((result.data as Record<string, unknown>).error)
        : JSON.stringify(result.data, null, 2).slice(0, 500)) ??
      'No response body.';

    setLogs((prev) => [
      {
        id: prev.length + 1,
        time: now.toLocaleString(),
        status: statusOverride,
        httpStatus: result.httpStatus,
        message,
        raw: result.data
      },
      ...prev
    ]);
  };

  const handleRun = async () => {
    if (status === 'running') return;

    resetProgress();
    setStatus('running');
    setRunCount((prev) => prev + 1);
    setStepState(PIPELINE_STEPS[0].id, 'running');

    try {
      const result = await triggerAutomation({ pdfFile, prompt });

      if (rotateRef.current) {
        clearInterval(rotateRef.current);
        rotateRef.current = null;
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }

      if (result.executionId) setExecutionId(result.executionId);

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

  return (
    <div className="app-root">
      <header className="app-header">
        <div>
          <h1>LearnXR Lesson Builder</h1>
          <p className="subtitle">
            Upload a chapter PDF, set the OpenAI prompt, and run the PDF-to-VR-lesson pipeline.
          </p>
        </div>
        <div className="status-pill">
          <span className={`dot dot-${status}`} />
          <span className="status-label">
            {status === 'idle' && 'Idle'}
            {status === 'running' && 'Running…'}
            {status === 'success' && 'Last run: success'}
            {status === 'error' && 'Last run: error'}
          </span>
        </div>
      </header>

      <main className="layout">
        <section className="card">
          <h2>1. PDF Upload</h2>
          <p className="card-text">
            Choose the chapter PDF. It will be sent to n8n and can be uploaded to your Drive folder.
          </p>
          <label className="file-drop">
            <input
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              disabled={status === 'running'}
            />
            <span className="file-label">
              {pdfFile ? (
                <>
                  <strong>{pdfFile.name}</strong>
                  <span className="file-meta">
                    {(pdfFile.size / (1024 * 1024)).toFixed(2)} MB
                  </span>
                </>
              ) : (
                'Click to select a PDF file'
              )}
            </span>
          </label>
        </section>

        <section className="card">
          <h2>2. OpenAI Prompt</h2>
          <p className="card-text">
            Override or extend the system prompt for the <code>Message a model</code> node (e.g.{' '}
            <code>{'{{$json["prompt"]}}'}</code>).
          </p>
          <textarea
            className="prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Paste or edit the OpenAI prompt. Sent as `prompt` to the webhook."
            rows={10}
            disabled={status === 'running'}
          />
        </section>

        <section className="card action-card">
          <h2>3. Run Automation</h2>
          <p className="card-text">
            Start the full pipeline: extract PDF → AI lesson → topics → skyboxes → Firebase & Sheets.
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={handleRun}
            disabled={status === 'running' || !n8nConfigured}
          >
            {status === 'running' ? 'Running…' : 'Start Automation'}
          </button>
          {!n8nConfigured && (
            <p className="warning">
              Set <code>VITE_N8N_WEBHOOK_URL</code> in <code>.env</code> to enable this button.
            </p>
          )}
          <p className="hint">
            Runs this session: <strong>{runCount}</strong>
          </p>
        </section>

        <section className="card progress-card">
          <h2>Pipeline progress</h2>
          <p className="card-text">
            Current step in the PDF-to-VR-lesson workflow. Steps advance as the automation runs.
          </p>
          <ul className="pipeline-steps">
            {PIPELINE_STEPS.map((step, index) => (
              <li
                key={step.id}
                className={`pipeline-step pipeline-step--${stepStates[step.id]}`}
                aria-current={stepStates[step.id] === 'running' ? 'step' : undefined}
              >
                <span className="pipeline-step-icon">
                  {stepStates[step.id] === 'done' && '✓'}
                  {stepStates[step.id] === 'running' && (
                    <span className="pipeline-step-spinner" aria-hidden />
                  )}
                  {stepStates[step.id] === 'error' && '✕'}
                  {stepStates[step.id] === 'pending' && <span className="pipeline-step-dot" />}
                </span>
                <span className="pipeline-step-label">{step.label}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card logs-card">
          <h2>Execution & error logs</h2>
          <p className="card-text">
            Response and errors from n8n (e.g. from error-handling and WhatsApp nodes).
          </p>
          {logs.length === 0 ? (
            <div className="empty-logs">No runs yet. Trigger the automation to see logs.</div>
          ) : (
            <ul className="logs-list">
              {logs.map((log) => (
                <li key={log.id} className={`log-entry log-${log.status}`}>
                  <div className="log-header">
                    <span className="log-time">{log.time}</span>
                    <span className="log-status">
                      {log.status.toUpperCase()} • HTTP {log.httpStatus || 'n/a'}
                    </span>
                  </div>
                  <pre className="log-message">{log.message}</pre>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
};

export default App;
