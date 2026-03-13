export type ExecutionStatus = 'idle' | 'running' | 'success' | 'error';

export interface RunResult {
  ok: boolean;
  httpStatus: number;
  data: unknown;
  errorMessage?: string;
}

const WEBHOOK_URL = import.meta.env.VITE_N8N_WEBHOOK_URL as string | undefined;

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

  const errorMessage =
    !response.ok
      ? (typeof body === 'object' && body !== null && 'message' in body
          ? String((body as any).message)
          : `Request failed with status ${response.status}`)
      : undefined;

  return {
    ok: response.ok,
    httpStatus: response.status,
    data: body,
    errorMessage
  };
}

