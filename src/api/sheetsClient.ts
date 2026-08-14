/**
 * Google Sheets leads via authenticated Cloud Function proxy
 * (`GET /api/sheets/leads` → n8n sheet-leads-read webhook).
 */

import { getAuthIdToken } from '../lib/firebase';

function isProxyUsable(url: string | undefined): boolean {
  if (!url) return false;
  return !url.includes('localhost') && !url.includes('127.0.0.1');
}

function getProxyBase(): string | null {
  if (import.meta.env.PROD) return '';
  const proxy = import.meta.env.VITE_API_PROXY_URL as string | undefined;
  if (isProxyUsable(proxy)) return proxy!.replace(/\/$/, '');
  return null;
}

async function authHeaders(forceRefresh = false): Promise<HeadersInit> {
  const token = await getAuthIdToken(forceRefresh);
  if (!token) throw new Error('Not signed in. Please log in again.');
  return { Authorization: `Bearer ${token}` };
}

async function fetchWithAuthRetry(url: string): Promise<Response> {
  const first = await fetch(url, { headers: await authHeaders() });
  if (first.status !== 401) return first;
  return fetch(url, { headers: await authHeaders(true) });
}

export type SchoolLeadRow = Record<string, unknown> & {
  'School Name'?: string;
  'Email ID'?: string;
  City?: string;
  Status?: string;
  Lead_status?: string;
  Reply_Status?: string;
  'Phone number'?: string;
  Whatsapp_status?: string;
  Whatsapp_message_sid?: string;
  whatsapp_sent_at?: string;
  whatsapp_replied?: string;
  whatsapp_reply_message?: string;
  whatsapp_reply_category?: string;
  Follow_up_count?: string;
  Last_Follow_up?: string;
  Next_Follow_up?: string;
  XR_status?: string;
};

export type FetchLeadsResult = {
  ok: boolean;
  fetchedAt: string;
  total: number;
  rows: SchoolLeadRow[];
};

export type FetchLeadsOptions = {
  city?: string;
  status?: string;
  leadStatus?: string;
  whatsappStatus?: string;
  q?: string;
  limit?: number;
};

export async function fetchSheetLeads(options: FetchLeadsOptions = {}): Promise<FetchLeadsResult> {
  const proxyBase = getProxyBase();
  if (proxyBase === null && !import.meta.env.PROD) {
    throw new Error('Sheets proxy unavailable in local dev without VITE_API_PROXY_URL.');
  }
  const base = proxyBase === null ? '' : proxyBase;
  const q = new URLSearchParams();
  if (options.city) q.set('city', options.city);
  if (options.status) q.set('status', options.status);
  if (options.leadStatus) q.set('leadStatus', options.leadStatus);
  if (options.whatsappStatus) q.set('whatsappStatus', options.whatsappStatus);
  if (options.q) q.set('q', options.q);
  if (options.limit != null) q.set('limit', String(options.limit));
  const qs = q.toString();
  const url = `${base}/api/sheets/leads${qs ? `?${qs}` : ''}`;

  const res = await fetchWithAuthRetry(url);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message || `Failed to load leads (${res.status})`);
  }
  const data = (await res.json()) as FetchLeadsResult;
  return {
    ok: Boolean(data.ok),
    fetchedAt: data.fetchedAt || new Date().toISOString(),
    total: typeof data.total === 'number' ? data.total : Array.isArray(data.rows) ? data.rows.length : 0,
    rows: Array.isArray(data.rows) ? (data.rows as SchoolLeadRow[]) : [],
  };
}

export function leadPhoneForMessaging(row: SchoolLeadRow): string | null {
  const raw = String(row['Phone number'] || row.to_number || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  return digits.startsWith('+') ? digits : digits.length === 10 ? `+91${digits}` : `+${digits}`;
}
