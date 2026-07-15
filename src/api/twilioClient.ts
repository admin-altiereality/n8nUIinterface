/**
 * Twilio Programmable Messaging:
 * - Local dev: Express in `src/index.js` → `http://localhost:3001/twilio/*` (or `VITE_UPLOAD_API_URL`)
 * - Production + Firebase Hosting preview: same-origin `/api/twilio/*` (Hosting rewrites to Cloud Function `api`)
 *
 * All `/api/twilio/*` calls require a Firebase Auth Bearer token.
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

export type TwilioHealth = {
  ok: boolean;
  accountHint: string | null;
  source?: string;
};

export type ListMessagesResult = {
  messages: TwilioMessage[];
  nextPageToken: string | null;
};

export async function fetchTwilioHealth(): Promise<TwilioHealth> {
  const r = await fetch(twilioUrl('/health'), { headers: await authHeaders() });
  const data = (await r.json().catch(() => ({}))) as TwilioHealth & { message?: string };
  if (!r.ok) {
    throw new Error(typeof data.message === 'string' ? data.message : 'Twilio health check failed');
  }
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
  const data = (await r.json().catch(() => ({}))) as ListMessagesResult & { message?: string };
  if (!r.ok) {
    throw new Error(typeof data.message === 'string' ? data.message : 'Failed to list messages');
  }
  return {
    messages: Array.isArray(data.messages) ? data.messages : [],
    nextPageToken: data.nextPageToken ?? null,
  };
}

export async function getTwilioMessage(sid: string): Promise<TwilioMessage> {
  const r = await fetch(twilioUrl(`/messages/${encodeURIComponent(sid)}`), {
    headers: await authHeaders(),
  });
  const data = (await r.json().catch(() => ({}))) as TwilioMessage & { message?: string };
  if (!r.ok) {
    throw new Error(typeof data.message === 'string' ? data.message : 'Failed to load message');
  }
  return data;
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
  const data = (await r.json().catch(() => ({}))) as TwilioMessage & { message?: string };
  if (!r.ok) {
    const message = typeof (data as { message?: string }).message === 'string'
      ? (data as { message: string }).message
      : 'Send failed';
    const code = (data as { code?: string | number }).code
      ? ` (code: ${(data as { code: string | number }).code})`
      : '';
    throw new Error(`${message}${code}`);
  }
  return data;
}
