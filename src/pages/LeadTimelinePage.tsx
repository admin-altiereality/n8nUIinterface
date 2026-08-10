import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, Loader2, MessageSquare, RefreshCw, UserCheck } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { PageHeader } from '../components/layout/PageHeader';
import {
  fetchLeadTimeline,
  updateLeadAssignment,
  type LeadAssignment,
  type LeadTimeline,
  type LeadTimelineEvent,
} from '../api/opsClient';

function eventLabel(type: LeadTimelineEvent['type']): string {
  if (type === 'whatsapp_inbound') return 'Inbound WhatsApp';
  if (type === 'whatsapp_outbound') return 'Outbound WhatsApp';
  if (type === 'delivery_status') return 'Delivery status';
  return 'Audit event';
}

function shortDate(value: unknown): string {
  const raw = String(value || '');
  const t = Date.parse(raw);
  if (!raw || Number.isNaN(t)) return raw;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t));
}

function text(value: unknown, fallback = ''): string {
  return String(value ?? fallback);
}

export default function LeadTimelinePage() {
  const { id = '' } = useParams();
  const leadId = decodeURIComponent(id);
  const [data, setData] = useState<LeadTimeline | null>(null);
  const [assignment, setAssignment] = useState<LeadAssignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!leadId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchLeadTimeline(leadId);
      setData(next);
      setAssignment(next.assignment || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load timeline.');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => { void load(); }, [load]);

  const lead = data?.lead;
  const title = text(lead?.['School Name'], leadId || 'Lead');
  const timeline = useMemo(() => data?.timeline || [], [data]);

  const onAssignment = async (action: 'claim' | 'unclaim') => {
    setSaving(true);
    setError(null);
    try {
      setAssignment(await updateLeadAssignment(leadId, action));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Assignment update failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-container space-y-6">
      <PageHeader title={title} subtitle={`Unified timeline for ${leadId}`}>
        <div className="flex items-center gap-2">
          <Link to="/dashboard" className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-[11px] font-medium text-zinc-100 transition-all hover:bg-zinc-800/60">
            <ArrowLeft className="h-4 w-4" /> Dashboard
          </Link>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </PageHeader>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-4">
          <CardHeader><CardTitle>Lead</CardTitle></CardHeader>
          <CardContent>
            <Info label="School" value={lead?.['School Name']} />
            <Info label="Email" value={lead?.['Email ID']} />
            <Info label="City" value={lead?.City} />
            <Info label="Lead status" value={lead?.Lead_status} />
            <Info label="WhatsApp status" value={lead?.Whatsapp_status} />
            <Info label="Next follow-up" value={lead?.Next_Follow_up} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-4">
          <CardHeader><CardTitle>Assignment</CardTitle></CardHeader>
          <CardContent>
            {assignment?.assignedTo ? (
              <div className="rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-100">
                <div className="flex items-center gap-2 font-medium"><UserCheck className="h-4 w-4" /> Claimed</div>
                <p className="mt-2 text-xs text-emerald-200/80">{assignment.assignedToEmail || assignment.assignedToName}</p>
                <p className="text-[11px] text-emerald-200/60">{shortDate(assignment.assignedAt)}</p>
              </div>
            ) : (
              <p className="rounded-lg bg-zinc-950/50 p-3 text-sm text-zinc-400">Unassigned</p>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={() => void onAssignment('claim')} disabled={saving}>
                Claim
              </Button>
              <Button size="sm" variant="outline" onClick={() => void onAssignment('unclaim')} disabled={saving || !assignment?.assignedTo}>
                Unclaim
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-4">
          <CardHeader><CardTitle>Email Reply</CardTitle></CardHeader>
          <CardContent>
            <Info label="Reply status" value={lead?.Reply_Status} />
            <Info label="WhatsApp replied" value={lead?.whatsapp_replied} />
            <Info label="Reply category" value={lead?.whatsapp_reply_category} />
            <Info label="Reply message" value={lead?.whatsapp_reply_message} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
        <CardContent>
          {timeline.length ? timeline.map((event, index) => (
            <div key={`${event.type}-${index}`} className="flex gap-3 rounded-lg bg-zinc-950/50 p-3">
              <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-300">
                {event.type === 'delivery_status' ? <CheckCircle2 className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-zinc-100">{eventLabel(event.type)}</p>
                  <Badge variant="outline">{shortDate(event.at)}</Badge>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">
                  {text(event.data.body || event.data.twilioMessage || event.data.status || event.data.action || event.data.sid, 'No details')}
                </p>
              </div>
            </div>
          )) : <p className="rounded-md bg-zinc-950/40 px-3 py-4 text-center text-xs text-zinc-500">{loading ? 'Loading timeline...' : 'No timeline events yet'}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function Info({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 truncate text-sm text-zinc-200">{text(value, '-')}</p>
    </div>
  );
}
