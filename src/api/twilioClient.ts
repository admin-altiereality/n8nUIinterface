/**
 * Twilio Programmable Messaging:
 * - Local dev: Express in `src/index.js` → `http://localhost:3001/twilio/*` (or `VITE_UPLOAD_API_URL`)
 * - Production + Firebase Hosting preview: same-origin `/api/twilio/*` (Hosting rewrites to Cloud Function `api`)
 *
 * Docs: https://www.twilio.com/docs/messaging
 */

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

/** Path beginning with `/` e.g. `/health`, `/messages`, `/messages/SMxx` — full URL or same-origin path for fetch. */
function twilioUrl(pathAndQuery: string): string {
  const root = getTwilioRoot();
  const p = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  if (root.startsWith('http://') || root.startsWith('https://')) {
    return `${root.replace(/\/$/, '')}${p}`;
  }
  return `${root.replace(/\/$/, '')}${p}`;
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
  const r = await fetch(twilioUrl('/health'));
  const data = (await r.json().catch(() => ({}))) as TwilioHealth & { message?: string };
  if (!r.ok) {
    throw new Error(typeof data.message === 'string' ? data.message : 'Twilio health check failed');
  }
  return { ok: data.ok, accountHint: data.accountHint, source: data.source };
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

  const r = await fetch(twilioUrl(path));
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
  const r = await fetch(twilioUrl(`/messages/${encodeURIComponent(sid)}`));
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await r.json().catch(() => ({}))) as TwilioMessage & { message?: string };
  if (!r.ok) {
    const message = typeof (data as any).message === 'string' ? (data as any).message : 'Send failed';
    const code = (data as any).code ? ` (code: ${(data as any).code})` : '';
    if ((data as any).raw) {
      return Promise.reject(new Error(`${message}${code}`));
    }
    throw new Error(`${message}${code}`);
  }
  return data;
}
