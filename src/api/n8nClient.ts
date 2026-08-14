import { getAuthIdToken } from '../lib/firebase';

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
      runData?: Record<string, Array<{
        startTime: number;
        executionTime?: number;
        data?: {
          main?: any[][];
        };
        error?: {
          message?: string;
          stack?: string;
          description?: string;
        };
      }>>;
      error?: {
        message: string;
        stack?: string;
      };
    };
  };
}

export interface N8nExecutionListItem {
  id: string;
  startedAt: string;
  stoppedAt?: string;
  status: 'running' | 'success' | 'error' | 'waiting';
  mode?: string;
  workflowId?: string;
  source?: string;
}

export type SalesExecutionsMeta = {
  source: 'n8n' | 'firestore' | 'unknown';
  warning?: string;
};

export let lastSalesExecutionsMeta: SalesExecutionsMeta = { source: 'unknown' };

const WEBHOOK_URL = import.meta.env.VITE_N8N_WEBHOOK_URL as string | undefined;
const API_PROXY_URL = import.meta.env.VITE_API_PROXY_URL as string | undefined;

function isProxyUsable(url: string | undefined): boolean {
  if (!url) return false;
  return !url.includes('localhost') && !url.includes('127.0.0.1');
}

function getProxyBase(): string | null {
  if (isProxyUsable(API_PROXY_URL)) return API_PROXY_URL!.replace(/\/$/, '');
  if (import.meta.env.PROD) return '';
  return null;
}

async function authHeaders(forceRefresh = false): Promise<HeadersInit> {
  const token = await getAuthIdToken(forceRefresh);
  if (!token) {
    throw new Error('Not signed in. Please log in again.');
  }
  return { Authorization: `Bearer ${token}` };
}

async function fetchWithAuthRetry(url: string, init?: RequestInit): Promise<Response> {
  const first = await fetch(url, { ...init, headers: { ...(init?.headers || {}), ...(await authHeaders()) } });
  if (first.status !== 401) return first;
  return fetch(url, { ...init, headers: { ...(init?.headers || {}), ...(await authHeaders(true)) } });
}

/**
 * True if we can poll execution status via the authenticated backend proxy.
 * Never use a browser-exposed n8n API key.
 */
export const canPollExecution = getProxyBase() !== null || Boolean(import.meta.env.PROD);

if (!WEBHOOK_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    'VITE_N8N_WEBHOOK_URL is not set. Configure it in a .env file to connect the UI to your n8n workflow.'
  );
}

export async function triggerAutomation(params: {
  pdfFile: File | null;
  prompt: string;
  language: string;
  curriculum: string;
  classLevel: string;
  subject: string;
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
  formData.append('language', params.language);
  formData.append('curriculum', params.curriculum);
  formData.append('class', params.classLevel);
  formData.append('subject', params.subject);

  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    body: formData
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // ignore
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

/** Poll n8n execution status via authenticated Cloud Function proxy. */
export async function getExecutionStatus(executionId: string): Promise<N8nExecution | null> {
  const proxyBase = getProxyBase();
  if (proxyBase === null && !import.meta.env.PROD) {
    return null;
  }
  const base = proxyBase === null ? '' : proxyBase;
  const proxyUrl = `${base}/api/n8n/executions/${encodeURIComponent(executionId)}`;

  try {
    const res = await fetchWithAuthRetry(proxyUrl);
    if (!res.ok) return null;
    return (await res.json()) as N8nExecution;
  } catch {
    return null;
  }
}

export async function fetchExecutionDetail(executionId: string): Promise<N8nExecution | null> {
  return getExecutionStatus(executionId);
}

/** Fetch a list of recent n8n executions (via authenticated backend proxy). */
export async function listExecutions(
  limit = 10,
  workflowId?: string | null
): Promise<N8nExecutionListItem[] | null> {
  const proxyBase = getProxyBase();
  if (proxyBase === null && !import.meta.env.PROD) {
    return null;
  }
  const base = proxyBase === null ? '' : proxyBase;
  const workflowParam = workflowId ? `&workflowId=${encodeURIComponent(workflowId)}` : '';
  const proxyUrl = `${base}/api/n8n/executions?limit=${encodeURIComponent(limit)}${workflowParam}`;

  try {
    const res = await fetchWithAuthRetry(proxyUrl);
    if (!res.ok) {
      lastSalesExecutionsMeta = { source: 'unknown', warning: `Execution API failed (${res.status}).` };
      return null;
    }
    const json = (await res.json()) as {
      data?: N8nExecutionListItem[];
      source?: string;
      warning?: string;
    } | N8nExecutionListItem[];
    if (Array.isArray(json)) {
      lastSalesExecutionsMeta = { source: 'n8n' };
      return json;
    }
    if (json && Array.isArray(json.data)) {
      lastSalesExecutionsMeta = {
        source: json.source === 'firestore' ? 'firestore' : 'n8n',
        warning: json.warning,
      };
      return json.data;
    }
    lastSalesExecutionsMeta = { source: 'unknown', warning: 'Execution API returned an unexpected response.' };
    return null;
  } catch (e) {
    lastSalesExecutionsMeta = {
      source: 'unknown',
      warning: e instanceof Error ? e.message : 'Execution API request failed.',
    };
    return null;
  }
}

/** Sales-scoped execution list (salesperson-allowed Cloud Function route). */
export async function listSalesExecutions(
  limit = 10,
  workflowId?: string | null
): Promise<N8nExecutionListItem[] | null> {
  const proxyBase = getProxyBase();
  if (proxyBase === null && !import.meta.env.PROD) {
    return null;
  }
  const base = proxyBase === null ? '' : proxyBase;
  const workflowParam = workflowId ? `&workflowId=${encodeURIComponent(workflowId)}` : '';
  const proxyUrl = `${base}/api/n8n/sales-executions?limit=${encodeURIComponent(limit)}${workflowParam}`;

  try {
    const res = await fetchWithAuthRetry(proxyUrl);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: N8nExecutionListItem[] } | N8nExecutionListItem[];
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.data)) return json.data;
    return null;
  } catch {
    return null;
  }
}

export async function getSalesExecutionStatus(executionId: string): Promise<N8nExecution | null> {
  const proxyBase = getProxyBase();
  if (proxyBase === null && !import.meta.env.PROD) {
    return null;
  }
  const base = proxyBase === null ? '' : proxyBase;
  const proxyUrl = `${base}/api/n8n/sales-executions/${encodeURIComponent(executionId)}`;

  try {
    const res = await fetchWithAuthRetry(proxyUrl);
    if (!res.ok) return null;
    return (await res.json()) as N8nExecution;
  } catch {
    return null;
  }
}
