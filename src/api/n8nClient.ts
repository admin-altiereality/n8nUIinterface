export type ExecutionStatus = 'idle' | 'running' | 'success' | 'error';

export interface RunResult {
  ok: boolean;
  httpStatus: number;
  data: unknown;
  errorMessage?: string;
  executionId?: string;
}

/** Pipeline steps shown in the UI (order matches typical PDF-to-VR workflow). */
export const PIPELINE_STEPS = [
  { id: 'receive', label: 'Receive PDF & prompt' },
  { id: 'extract', label: 'Extract text from PDF' },
  { id: 'ai', label: 'Generate lesson (OpenAI)' },
  { id: 'topics', label: 'Parse & split topics' },
  { id: 'skybox', label: 'Generate skyboxes' },
  { id: 'save', label: 'Save to Firebase & Sheets' }
] as const;

export type PipelineStepId = (typeof PIPELINE_STEPS)[number]['id'];

/** n8n execution status from API (optional polling). */
export interface N8nExecution {
  id: string;
  finished: boolean;
  status: 'running' | 'success' | 'error' | 'waiting';
  startedAt: string;
  stoppedAt?: string;
  data?: {
    resultData?: {
      runData?: Record<string, Array<{ startTime: number; executionTime?: number }>>;
    };
  };
}

const WEBHOOK_URL = import.meta.env.VITE_N8N_WEBHOOK_URL as string | undefined;
const N8N_API_URL = import.meta.env.VITE_N8N_API_URL as string | undefined;
const N8N_API_KEY = import.meta.env.VITE_N8N_API_KEY as string | undefined;

/** True if we can poll execution status (needs VITE_N8N_API_URL + VITE_N8N_API_KEY). */
export const canPollExecution = Boolean(N8N_API_URL && N8N_API_KEY);

if (!WEBHOOK_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    'VITE_N8N_WEBHOOK_URL is not set. Configure it in a .env file to connect the UI to your n8n workflow.'
  );
}

export async function triggerAutomation(params: {
  pdfFile: File | null;
  prompt: string;
}): Promise<RunResult> {
  if (!WEBHOOK_URL) {
    return {
      ok: false,
      httpStatus: 0,
      data: null,
      errorMessage: 'N8N webhook URL is not configured on the frontend.'
    };
  }

  const formData = new FormData();
  if (params.pdfFile) {
    formData.append('file', params.pdfFile, params.pdfFile.name);
  }
  formData.append('prompt', params.prompt);

  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    body: formData
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // ignore JSON parse errors; body stays null
  }

  const data = body as Record<string, unknown> | null;
  const executionId =
    data && typeof data.executionId === 'string' ? data.executionId : undefined;

  const errorMessage =
    !response.ok
      ? (data && typeof data.message === 'string'
          ? data.message
          : `Request failed with status ${response.status}`)
      : undefined;

  return {
    ok: response.ok,
    httpStatus: response.status,
    data: body,
    errorMessage,
    executionId
  };
}

/** Poll n8n execution status (optional: set VITE_N8N_API_URL and VITE_N8N_API_KEY). */
export async function getExecutionStatus(executionId: string): Promise<N8nExecution | null> {
  if (!N8N_API_URL || !N8N_API_KEY) return null;
  const base = N8N_API_URL.replace(/\/$/, '');
  const url = `${base}/api/v1/executions/${executionId}`;
  try {
    const res = await fetch(url, {
      headers: { 'X-N8N-API-KEY': N8N_API_KEY }
    });
    if (!res.ok) return null;
    return (await res.json()) as N8nExecution;
  } catch {
    return null;
  }
}
