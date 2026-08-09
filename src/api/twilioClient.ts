/**
 * Twilio Programmable Messaging:
 * - Local dev: Express in `src/index.js` → `http://localhost:3001/twilio/*` (or `VITE_UPLOAD_API_URL`)
 * - Production + Firebase Hosting preview: same-origin `/api/twilio/*` (Hosting rewrites to Cloud Function `api`)
 *
 * All `/api/twilio/*` calls require a Firebase Auth Bearer token (except StatusCallback).
 */

import { getAuthIdToken } from '../lib/firebase';

function isProxyUsable(url: string | undefined): boolean {
  if (!url) return false;
  return !url.includes('localhost') && !url.includes('127.0.0.1');
}

/** API root for Twilio proxy routes (either absolute `http(s)://…/twilio` or relative `/api/twilio`). */
function getTwilioRoot(): string {
  if (import.meta.env.PROD) {
    return '/api/twilio';
  }

  const proxy = import.meta.env.VITE_API_PROXY_URL as string | undefined;
  if (isProxyUsable(proxy)) {
    return `${proxy!.replace(/\/$/, '')}/api/twilio`;
  }

  const upload =
    (import.meta.env.VITE_UPLOAD_API_URL as string | undefined) || 'http://localhost:3001';
  return `${upload.replace(/\/$/, '')}/twilio`;
}

function twilioUrl(pathAndQuery: string): string {
  const root = getTwilioRoot();
  const p = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  if (root.startsWith('http://') || root.startsWith('https://')) {
    return `${root.replace(/\/$/, '')}${p}`;
  }
  return `${root.replace(/\/$/, '')}${p}`;
}

async function authHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const token = await getAuthIdToken();
  if (!token) {
    throw new Error('Not signed in. Please log in again.');
  }
  return {
    ...(extra || {}),
    Authorization: `Bearer ${token}`,
  };
}

export type TwilioMessage = {
  sid: string;
  account_sid?: string;
  to?: string;
  from?: string;
  body?: string;
  status?: string;
  direction?: string;
  date_created?: string;
  date_sent?: string | null;
  date_updated?: string;
  error_code?: string | number | null;
  error_message?: string | null;
  num_segments?: string;
  uri?: string;
  media?: Array<{
    content_type?: string;
    filename?: string;
    preview_url?: string;
    media_url?: string;
    uri?: string;
  }>;
};

export type TwilioMessageStatusDoc = {
  sid: string;
  to?: string | null;
  from?: string | null;
  status: string;
  errorCode?: string | number | null;
  errorMessage?: string | null;
  updatedAt?: string;
  statusHistory?: Array<{ status: string; at: string; errorCode?: string | number | null }>;
};

export type TwilioHealth = {
  ok: boolean;
  accountHint: string | null;
  source?: string;
};

export type ListMessagesResult = {
  messages: TwilioMessage[];
  nextPageToken: string | null;
};

export class TwilioApiError extends Error {
  status: number;
  code?: string | number;

  constructor(message: string, status: number, code?: string | number) {
    super(message);
    this.name = 'TwilioApiError';
    this.status = status;
    this.code = code;
  }
}

function isTwilioSuspendedStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

export function isTwilioAccountUnavailableError(err: unknown): boolean {
  return err instanceof TwilioApiError && isTwilioSuspendedStatus(err.status);
}

export function isTwilioStatusTerminal(status: string | undefined): boolean {
  const s = String(status || '').toLowerCase();
  return s === 'delivered' || s === 'read' || s === 'failed' || s === 'undelivered' || s === 'canceled';
}

async function parseTwilioError(r: Response, fallback: string): Promise<never> {
  const data = (await r.json().catch(() => ({}))) as {
    message?: string;
    code?: string | number;
  };
  const message = typeof data.message === 'string' ? data.message : fallback;
  throw new TwilioApiError(message, r.status, data.code);
}

export async function fetchTwilioHealth(): Promise<TwilioHealth> {
  const r = await fetch(twilioUrl('/health'), { headers: await authHeaders() });
  if (!r.ok) {
    await parseTwilioError(r, 'Twilio health check failed');
  }
  const data = (await r.json().catch(() => ({}))) as TwilioHealth;
  return { ok: data.ok, accountHint: data.accountHint ?? null, source: data.source };
}

export async function listTwilioMessages(options: {
  pageSize?: number;
  pageToken?: string;
  dateSentAfter?: string;
}): Promise<ListMessagesResult> {
  const q = new URLSearchParams();
  if (options.pageSize != null) q.set('pageSize', String(options.pageSize));
  if (options.pageToken) q.set('pageToken', options.pageToken);
  if (options.dateSentAfter) q.set('dateSentAfter', options.dateSentAfter);
  const qs = q.toString();
  const path = qs ? `/messages?${qs}` : '/messages';

  const r = await fetch(twilioUrl(path), { headers: await authHeaders() });
  if (!r.ok) {
    await parseTwilioError(r, 'Failed to list messages');
  }
  const data = (await r.json().catch(() => ({}))) as ListMessagesResult;
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    nextPageToken: data.nextPageToken ?? null,
  };
}

export async function getTwilioMessage(sid: string): Promise<TwilioMessage> {
  const r = await fetch(twilioUrl(`/messages/${encodeURIComponent(sid)}`), {
    headers: await authHeaders(),
  });
  if (!r.ok) {
    await parseTwilioError(r, 'Failed to load message');
  }
  return (await r.json().catch(() => ({}))) as TwilioMessage;
}

export async function getTwilioMessageStatus(sid: string): Promise<TwilioMessageStatusDoc | null> {
  const r = await fetch(twilioUrl(`/messages/${encodeURIComponent(sid)}/status`), {
    headers: await authHeaders(),
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    await parseTwilioError(r, 'Failed to load message status');
  }
  return (await r.json().catch(() => null)) as TwilioMessageStatusDoc | null;
}

export async function fetchTwilioStatuses(
  sids: string[]
): Promise<Record<string, TwilioMessageStatusDoc>> {
  const unique = [...new Set(sids.filter(Boolean))].slice(0, 50);
  if (!unique.length) return {};
  const q = new URLSearchParams({ sids: unique.join(',') });
  const r = await fetch(twilioUrl(`/statuses?${q.toString()}`), {
    headers: await authHeaders(),
  });
  if (!r.ok) {
    await parseTwilioError(r, 'Failed to load message statuses');
  }
  const data = (await r.json().catch(() => ({}))) as {
    statuses?: Record<string, TwilioMessageStatusDoc>;
  };
  return data.statuses && typeof data.statuses === 'object' ? data.statuses : {};
}

export async function sendTwilioMessage(payload: {
  to: string;
  body: string;
  from?: string;
  messagingServiceSid?: string;
  mediaUrl?: string;
}): Promise<TwilioMessage> {
  const r = await fetch(twilioUrl('/messages'), {
    method: 'POST',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      to: payload.to,
      body: payload.body,
      mediaUrl: payload.mediaUrl,
      // from / messagingServiceSid are ignored server-side (server secrets only)
    }),
  });
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as {
      message?: string;
      code?: string | number;
    };
    const message = typeof data.message === 'string' ? data.message : 'Send failed';
    const code = data.code ? ` (code: ${data.code})` : '';
    throw new TwilioApiError(`${message}${code}`, r.status, data.code);
  }
  return (await r.json().catch(() => ({}))) as TwilioMessage;
}
