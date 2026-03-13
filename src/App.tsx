import React, { useMemo, useState } from 'react';
import { ExecutionStatus, RunResult, triggerAutomation } from './api/n8nClient';

interface LogEntry {
  id: number;
  time: string;
  status: ExecutionStatus;
  httpStatus: number;
  message: string;
  raw?: unknown;
}

const App: React.FC = () => {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState<string>('');
  const [status, setStatus] = useState<ExecutionStatus>('idle');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [runCount, setRunCount] = useState(0);

  const n8nConfigured = useMemo(
    () => Boolean(import.meta.env.VITE_N8N_WEBHOOK_URL),
    []
  );

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setPdfFile(file);
  };

  const appendLog = (result: RunResult, statusOverride: ExecutionStatus) => {
    const now = new Date();
    const message =
      result.errorMessage ??
      (typeof result.data === 'object' && result.data !== null && 'error' in result.data
        ? String((result.data as any).error)
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

    setStatus('running');
    setRunCount((prev) => prev + 1);

    try {
      const result = await triggerAutomation({ pdfFile, prompt });
      const finalStatus: ExecutionStatus = result.ok ? 'success' : 'error';
      setStatus(finalStatus);
      appendLog(result, finalStatus);
    } catch (error) {
      const fallback: RunResult = {
        ok: false,
        httpStatus: 0,
        data: null,
        errorMessage:
          error instanceof Error ? error.message : 'Unknown error triggering automation.'
      };
      setStatus('error');
      appendLog(fallback, 'error');
    }
  };

  return (
    <div className="app-root">
      <header className="app-header">
        <div>
          <h1>LearnXR Lesson Builder</h1>
          <p className="subtitle">
            Upload a chapter PDF, tweak the OpenAI prompt, and trigger your self‑hosted n8n
            pipeline.
          </p>
        </div>
        <div className="status-pill">
          <span className={`dot dot-${status}`} />
          <span className="status-label">
            {status === 'idle' && 'Idle'}
            {status === 'running' && 'Running'}
            {status === 'success' && 'Last run: success'}
            {status === 'error' && 'Last run: error'}
          </span>
        </div>
      </header>

      <main className="layout">
        <section className="card">
          <h2>1. PDF Upload</h2>
          <p className="card-text">
            Choose the chapter PDF that should be processed. The backend n8n workflow should store
            or forward this file to your configured Google Drive folder.
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
          {!pdfFile && (
            <p className="hint">
              The file will be sent to n8n as <code>file</code> in a multipart request.
            </p>
          )}
        </section>

        <section className="card">
          <h2>2. OpenAI Prompt</h2>
          <p className="card-text">
            Override or extend the system prompt used in your <code>Message a model</code> node.
            Make sure your n8n workflow reads this from the incoming payload (for example,
            <code>{'{{$json["prompt"]}}'}</code>).
          </p>
          <textarea
            className="prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Paste or edit the OpenAI prompt here. This text will be sent as `prompt` to your n8n webhook."
            rows={12}
            disabled={status === 'running'}
          />
          <p className="hint">
            Frontend sends this as <code>prompt</code> along with the PDF. You can keep your
            existing hard‑coded prompt and append this text inside n8n if you prefer.
          </p>
        </section>

        <section className="card action-card">
          <h2>3. Run Automation</h2>
          <p className="card-text">
            When you click the button, the app calls your configured n8n webhook URL and starts the
            full pipeline (PDF extraction, lesson generation, skybox, Firebase, Sheets, and
            WhatsApp alerts).
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
              Set <code>VITE_N8N_WEBHOOK_URL</code> in a <code>.env</code> file to enable this
              button.
            </p>
          )}
          <p className="hint">
            Runs so far in this session: <strong>{runCount}</strong>
          </p>
        </section>

        <section className="card logs-card">
          <h2>Execution & Error Logs</h2>
          <p className="card-text">
            These logs show the raw response from n8n, including any error objects your workflow
            returns (for example, from the error handling and WhatsApp notification nodes).
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

