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

async function authHeaders(extra?: HeadersInit): Promise<HeadersInit> {
  const token = await getAuthIdToken();
  if (!token) throw new Error('Not signed in. Please log in again.');
  return { ...(extra || {}), Authorization: `Bearer ${token}` };
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
  campaignByCity: Record<string, Record<string, number>>;
  followUps: SchoolLeadRow[];
  failedMessages: Array<Record<string, unknown>>;
  assignments: LeadAssignment[];
  recentAudit: OpsAuditEvent[];
  canReadLeadRows: boolean;
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
  const res = await fetch(opsUrl('/api/ops/dashboard'), { headers: await authHeaders() });
  if (!res.ok) await parseError(res, 'Failed to load ops dashboard');
  return (await res.json()) as OpsDashboard;
}

export async function fetchLeadTimeline(leadId: string): Promise<LeadTimeline> {
  const res = await fetch(opsUrl(`/api/ops/leads/${encodeURIComponent(leadId)}/timeline`), {
    headers: await authHeaders(),
  });
  if (!res.ok) await parseError(res, 'Failed to load lead timeline');
  return (await res.json()) as LeadTimeline;
}

export async function fetchLeadAssignment(threadId: string): Promise<LeadAssignment | null> {
  const res = await fetch(opsUrl(`/api/ops/assignments/${encodeURIComponent(threadId)}`), {
    headers: await authHeaders(),
  });
  if (!res.ok) await parseError(res, 'Failed to load assignment');
  const data = (await res.json()) as { assignment?: LeadAssignment | null };
  return data.assignment || null;
}

export async function updateLeadAssignment(threadId: string, action: 'claim' | 'unclaim'): Promise<LeadAssignment | null> {
  const res = await fetch(opsUrl(`/api/ops/assignments/${encodeURIComponent(threadId)}`), {
    method: 'PATCH',
    headers: await authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action }),
  });
  if (!res.ok) await parseError(res, 'Failed to update assignment');
  const data = (await res.json()) as { assignment?: LeadAssignment | null };
  return data.assignment || null;
}

export function opsExportUrl(): string {
  return opsUrl('/api/ops/export.csv');
}

export async function downloadOpsCsv(): Promise<Blob> {
  const res = await fetch(opsExportUrl(), { headers: await authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || 'Failed to export CSV');
  }
  return await res.blob();
}
