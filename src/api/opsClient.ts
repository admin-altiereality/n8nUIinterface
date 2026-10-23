import { getAuthIdToken } from '../lib/firebase';
import type { SchoolLeadRow } from './sheetsClient';

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

async function authHeaders(extra?: HeadersInit, forceRefresh = false): Promise<HeadersInit> {
  const token = await getAuthIdToken(forceRefresh);
  if (!token) throw new Error('Not signed in. Please log in again.');
  return { ...(extra || {}), Authorization: `Bearer ${token}` };
}

async function fetchWithAuthRetry(url: string, init?: RequestInit): Promise<Response> {
  const first = await fetch(url, { ...init, headers: await authHeaders(init?.headers) });
  if (first.status !== 401) return first;
  return fetch(url, { ...init, headers: await authHeaders(init?.headers, true) });
}

function opsUrl(path: string): string {
  const base = getProxyBase();
  if (base === null && !import.meta.env.PROD) {
    throw new Error('Ops API unavailable in local dev without VITE_API_PROXY_URL.');
  }
  return `${base || ''}${path}`;
}

async function parseError(res: Response, fallback: string): Promise<never> {
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  throw new Error(data.message || fallback);
}

export type OpsKpis = {
  activeFunnelRuns: number;
  messagesDeliveredToday: number;
  messagesReadToday: number;
  failedWhatsApp: number;
  openFollowUps: number;
  totalLeads: number;
  inboundToday: number;
};

export type LeadAssignment = {
  id?: string;
  threadId?: string;
  assignedTo?: string | null;
  assignedToEmail?: string | null;
  assignedToName?: string | null;
  assignedAt?: string;
  notes?: string | null;
};

export type OpsAuditEvent = {
  id: string;
  action: string;
  actorEmail?: string | null;
  actorRole?: string | null;
  targetId?: string | null;
  createdAt?: string;
  details?: Record<string, unknown>;
};

export type OpsDashboard = {
  ok: boolean;
  fetchedAt: string;
  role: string | null;
  kpis: OpsKpis;
  leadsByStatus: Record<string, number>;
  /** Lead counts by sheet `Source`; rows without one count as "Outreach". */
  leadsBySource?: Record<string, number>;
  campaignByCity: Record<string, Record<string, number>>;
  followUps: SchoolLeadRow[];
  failedMessages: Array<Record<string, unknown>>;
  assignments: LeadAssignment[];
  recentAudit: OpsAuditEvent[];
  canReadLeadRows: boolean;
};

export type AdsCampaign = {
  id: string;
  name: string;
  status: string;
  daily_budget_inr: number;
  spend_mtd_inr: number;
  leads_mtd: number;
  cpl_inr: number | null;
};

/** Contract of the n8n ads-performance webhook, proxied as-is by `GET /api/ops/ads`. */
export type AdsPerformance = {
  month: string;
  cap_inr: number;
  spend_mtd_inr: number;
  leads_mtd: number;
  cpl_inr: number | null;
  paused_by_guard: boolean;
  campaigns: AdsCampaign[];
};

export type LeadTimelineEvent = {
  type: 'whatsapp_inbound' | 'whatsapp_outbound' | 'delivery_status' | 'audit';
  at?: string;
  data: Record<string, unknown>;
};

export type LeadTimeline = {
  ok: boolean;
  leadId: string;
  lead: SchoolLeadRow | null;
  assignment: LeadAssignment | null;
  timeline: LeadTimelineEvent[];
};

export async function fetchOpsDashboard(): Promise<OpsDashboard> {
  const res = await fetchWithAuthRetry(opsUrl('/api/ops/dashboard'));
  if (!res.ok) await parseError(res, 'Failed to load ops dashboard');
  return (await res.json()) as OpsDashboard;
}

export async function fetchAdsPerformance(): Promise<AdsPerformance> {
  const res = await fetchWithAuthRetry(opsUrl('/api/ops/ads'));
  if (!res.ok) await parseError(res, 'Failed to load ads performance');
  return (await res.json()) as AdsPerformance;
}

export async function fetchLeadTimeline(leadId: string): Promise<LeadTimeline> {
  const res = await fetchWithAuthRetry(opsUrl(`/api/ops/leads/${encodeURIComponent(leadId)}/timeline`));
  if (!res.ok) await parseError(res, 'Failed to load lead timeline');
  return (await res.json()) as LeadTimeline;
}

export async function fetchLeadAssignment(threadId: string): Promise<LeadAssignment | null> {
  const res = await fetchWithAuthRetry(opsUrl(`/api/ops/assignments/${encodeURIComponent(threadId)}`));
  if (!res.ok) await parseError(res, 'Failed to load assignment');
  const data = (await res.json()) as { assignment?: LeadAssignment | null };
  return data.assignment || null;
}

export async function updateLeadAssignment(threadId: string, action: 'claim' | 'unclaim'): Promise<LeadAssignment | null> {
  const res = await fetchWithAuthRetry(opsUrl(`/api/ops/assignments/${encodeURIComponent(threadId)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) await parseError(res, 'Failed to update assignment');
  const data = (await res.json()) as { assignment?: LeadAssignment | null };
  return data.assignment || null;
}

export async function writeOpsAuditEvent(input: {
  action: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const res = await fetchWithAuthRetry(opsUrl('/api/ops/audit'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseError(res, 'Failed to write audit event');
}

export function opsExportUrl(): string {
  return opsUrl('/api/ops/export.csv');
}

export async function downloadOpsCsv(): Promise<Blob> {
  const res = await fetchWithAuthRetry(opsExportUrl());
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to export CSV');
  }
  return await res.blob();
}
