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
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  throw new Error(data.message || data.error || fallback);
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
  const res = await fetchWithAuthRetry(opsUrl('/api/ops/dashboard'));
  if (!res.ok) await parseError(res, 'Failed to load ops dashboard');
  return (await res.json()) as OpsDashboard;
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

export type CityRunPreset = 'cbse' | 'icse' | 'ib' | 'international' | 'all';

/** Starts a city scrape through the backend, which calls n8n with the shared webhook key. */
export async function startCityRun(city: string, preset: CityRunPreset): Promise<{ executionId: string | null; city: string }> {
  const res = await fetchWithAuthRetry(opsUrl('/api/sales/city-runs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city, preset }),
  });
  if (!res.ok) await parseError(res, 'Failed to start the city run');
  return (await res.json()) as { executionId: string | null; city: string };
}

export type LeadPatch = {
  fields?: Record<string, string>;
  note?: string;
  /** Logs a first touch (call, WhatsApp or email) on the lead. */
  touch?: 'call' | 'whatsapp' | 'email';
  event?: 'no_show';
};

/** A refused lead update; `code` is the backend's error, e.g. `owner_conflict` with the current `owner`. */
export class LeadUpdateError extends Error {
  code: string;
  owner?: string;

  constructor(message: string, code: string, owner?: string) {
    super(message);
    this.name = 'LeadUpdateError';
    this.code = code;
    this.owner = owner;
  }
}

const LEAD_ERROR_MESSAGES: Record<string, string> = {
  owner_conflict: 'Someone else has already claimed this lead.',
  lost_reason_required: 'Pick a reason before marking the lead Lost.',
  not_found: 'This lead is no longer in the sheet.',
  too_long: 'That text is too long.',
  invalid_date: 'That date is not valid.',
  invalid_number: 'Enter a whole number.',
  forbidden_owner: 'Only admins can assign leads to someone else.',
  upstream_error: 'The sheet could not be updated. Try again in a minute.',
};

/** Updates whitelisted lead fields in the sheet and/or adds a note to the lead's activity. */
export async function patchLead(leadId: string, patch: LeadPatch): Promise<SchoolLeadRow | null> {
  const res = await fetchWithAuthRetry(opsUrl(`/api/leads/${encodeURIComponent(leadId)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = (await res.json().catch(() => ({}))) as { lead?: SchoolLeadRow | null; error?: string; owner?: string; message?: string };
  if (!res.ok) {
    const code = data.error || `http_${res.status}`;
    throw new LeadUpdateError(LEAD_ERROR_MESSAGES[code] || data.message || 'Could not update the lead.', code, data.owner);
  }
  return data.lead || null;
}

export type LeadActivityItem = {
  action: string;
  actorEmail: string | null;
  createdAt?: string;
  details: Record<string, unknown>;
};

export async function fetchLeadActivity(leadId: string): Promise<LeadActivityItem[]> {
  const res = await fetchWithAuthRetry(opsUrl(`/api/leads/${encodeURIComponent(leadId)}/activity`));
  if (!res.ok) await parseError(res, 'Failed to load lead activity');
  const data = (await res.json()) as { items?: LeadActivityItem[] };
  return Array.isArray(data.items) ? data.items : [];
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

// ---- Social Ads (Meta) ----

export type MetaRange = 'last_7d' | 'last_28d' | 'last_90d' | 'this_month';

export type MetaInsights = {
  spend: number;
  reach: number;
  impressions: number;
  clicks: number;
  leads: number;
  costPerLead: number | null;
};

export type MetaAdset = { id: string; name: string; status: string; effectiveStatus: string; dailyBudget: number | null };

export type MetaCampaign = {
  id: string;
  name: string;
  objective: string;
  status: string;
  effectiveStatus: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  createdAt: string;
  insights: MetaInsights;
  adsets: MetaAdset[];
};

export type MetaIgPost = {
  id: string;
  caption: string;
  mediaType: string;
  imageUrl?: string;
  permalink: string;
  timestamp: string;
  likes: number;
  comments: number;
};

export type MetaBoostRequest = {
  igMediaId: string;
  goal: 'visits' | 'engagement';
  dailyBudget: number;
  days: number;
  cities: string[];
  ageMin: number;
};

export type MetaBoostResult = { campaignId: string; adsetId: string; adId: string; name: string; previewHtml: string };

export async function fetchMetaOverview(range: MetaRange): Promise<MetaInsights & { accountId: string }> {
  const res = await fetchWithAuthRetry(opsUrl(`/api/meta/overview?range=${range}`));
  if (!res.ok) await parseError(res, 'Could not load Meta overview.');
  return res.json();
}

export async function fetchMetaCampaigns(
  range: MetaRange,
  fresh = false
): Promise<{ accountId: string; maxDailyBudget: number; campaigns: MetaCampaign[] }> {
  const res = await fetchWithAuthRetry(opsUrl(`/api/meta/campaigns?range=${range}${fresh ? '&fresh=1' : ''}`));
  if (!res.ok) await parseError(res, 'Could not load Meta campaigns.');
  return res.json();
}

export async function fetchMetaIgPosts(): Promise<MetaIgPost[]> {
  const res = await fetchWithAuthRetry(opsUrl('/api/meta/ig-media'));
  if (!res.ok) await parseError(res, 'Could not load Instagram posts.');
  return ((await res.json()) as { media: MetaIgPost[] }).media;
}

export async function updateMetaEntity(id: string, change: { status?: 'ACTIVE' | 'PAUSED'; dailyBudget?: number }): Promise<void> {
  const res = await fetchWithAuthRetry(opsUrl(`/api/meta/entities/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(change),
  });
  if (!res.ok) await parseError(res, 'Meta did not accept the change.');
}

export async function boostMetaIgPost(req: MetaBoostRequest): Promise<MetaBoostResult> {
  const res = await fetchWithAuthRetry(opsUrl('/api/meta/boost'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) await parseError(res, 'Could not create the boost.');
  return res.json();
}
