import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCheck,
  Download,
  Loader2,
  MessageCircle,
  RefreshCw,
  Timer,
  Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { PageHeader } from '../components/layout/PageHeader';
import {
  downloadOpsCsv,
  fetchOpsDashboard,
  type OpsDashboard,
} from '../api/opsClient';
import { leadPhoneForMessaging } from '../api/sheetsClient';

function fmt(value: number | undefined): string {
  return new Intl.NumberFormat().format(value || 0);
}

function shortDate(value: unknown): string {
  const raw = String(value || '');
  if (!raw) return '';
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return raw;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function leadTimelineId(phone: string | null): string | null {
  if (!phone) return null;
  const normalized = phone.replace(/[^\d+]/g, '');
  if (!normalized) return null;
  return normalized.startsWith('+') ? normalized : `+${normalized}`;
}

export default function OpsDashboardPage() {
  const [data, setData] = useState<OpsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchOpsDashboard());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ops dashboard.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const statusRows = useMemo(
    () => Object.entries(data?.leadsByStatus || {}).sort((a, b) => b[1] - a[1]),
    [data]
  );
  const campaignRows = useMemo(
    () => Object.entries(data?.campaignByCity || {}).sort((a, b) => b[1].scraped - a[1].scraped).slice(0, 12),
    [data]
  );

  const onExport = async () => {
    setExporting(true);
    setError(null);
    try {
      downloadBlob(await downloadOpsCsv(), 'learnxr-leads-export.csv');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'CSV export failed.');
    } finally {
      setExporting(false);
    }
  };

  const kpis = data?.kpis;

  return (
    <div className="page-container space-y-6">
      <PageHeader title="Ops Dashboard" subtitle="Operational view for campaigns, WhatsApp delivery, follow-ups, and assignments.">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={() => void onExport()} disabled={exporting || !data?.canReadLeadRows}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            CSV
          </Button>
        </div>
      </PageHeader>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent className="pt-4"><Kpi icon={<Timer className="h-5 w-5" />} label="Active funnel runs" value={fmt(kpis?.activeFunnelRuns)} /></CardContent></Card>
        <Card><CardContent className="pt-4"><Kpi icon={<CheckCheck className="h-5 w-5" />} label="Delivered/read today" value={`${fmt(kpis?.messagesDeliveredToday)} / ${fmt(kpis?.messagesReadToday)}`} /></CardContent></Card>
        <Card><CardContent className="pt-4"><Kpi icon={<Users className="h-5 w-5" />} label="Total leads" value={fmt(kpis?.totalLeads)} /></CardContent></Card>
        <Card><CardContent className="pt-4"><Kpi icon={<AlertTriangle className="h-5 w-5" />} label="Failed WhatsApp" value={fmt(kpis?.failedWhatsApp)} tone="danger" /></CardContent></Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-4">
          <CardHeader><CardTitle>Leads By Status</CardTitle></CardHeader>
          <CardContent>
            {statusRows.length ? statusRows.map(([label, count]) => (
              <div key={label} className="flex items-center justify-between rounded-md bg-zinc-950/50 px-3 py-2">
                <span className="text-xs text-zinc-300">{label}</span>
                <Badge>{fmt(count)}</Badge>
              </div>
            )) : <EmptyState text={loading ? 'Loading statuses...' : 'No lead status data'} />}
          </CardContent>
        </Card>

        <Card className="lg:col-span-8">
          <CardHeader><CardTitle>Campaign Analytics By City</CardTitle></CardHeader>
          <CardContent className="overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  {['City', 'Scraped', 'Emailed', 'WA sent', 'Delivered', 'Read', 'Replied', 'Failed'].map((h) => <th key={h} className="pb-2 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80 text-zinc-300">
                {campaignRows.map(([city, row]) => (
                  <tr key={city}>
                    <td className="py-2 font-medium text-zinc-100">{city}</td>
                    <td>{fmt(row.scraped)}</td>
                    <td>{fmt(row.emailed)}</td>
                    <td>{fmt(row.whatsappSent)}</td>
                    <td>{fmt(row.delivered)}</td>
                    <td>{fmt(row.read)}</td>
                    <td>{fmt(row.replied)}</td>
                    <td className={row.failed ? 'text-red-300' : ''}>{fmt(row.failed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!campaignRows.length && <EmptyState text={loading ? 'Loading campaign analytics...' : 'No campaign data'} />}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Overdue Follow-Ups</CardTitle></CardHeader>
          <CardContent>
            {data?.followUps?.length ? data.followUps.slice(0, 8).map((lead, index) => {
              const phone = leadPhoneForMessaging(lead);
              const timelineId = leadTimelineId(phone);
              return (
                <div key={`${lead['School Name']}-${index}`} className="rounded-md bg-zinc-950/50 p-3">
                  <p className="truncate text-xs font-medium text-zinc-100">{String(lead['School Name'] || 'Unknown lead')}</p>
                  <p className="mt-1 text-[11px] text-zinc-500">{shortDate(lead.Next_Follow_up)}</p>
                  <div className="mt-2 flex flex-wrap gap-3">
                    {phone && <Link className="inline-flex items-center gap-1 text-[11px] text-indigo-300 hover:underline" to={`/twilio-messaging?contact=${encodeURIComponent(phone)}`}><MessageCircle className="h-3 w-3" /> Open chat</Link>}
                    {timelineId && <Link className="text-[11px] text-zinc-400 hover:text-zinc-200 hover:underline" to={`/ops/leads/${encodeURIComponent(timelineId)}`}>Timeline</Link>}
                  </div>
                </div>
              );
            }) : <EmptyState text="No overdue follow-ups" />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Failed WhatsApp Sends</CardTitle></CardHeader>
          <CardContent>
            {data?.failedMessages?.length ? data.failedMessages.slice(0, 8).map((item) => (
              <div key={String(item.id)} className="rounded-md bg-red-500/10 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-red-100">{String(item.to || 'Unknown recipient')}</span>
                  <Badge variant="danger">{String(item.phase || 'failed')}</Badge>
                </div>
                <p className="mt-1 text-[11px] text-red-200/80">{String(item.twilioMessage || item.mediaFilename || 'No message')}</p>
              </div>
            )) : <EmptyState text="No failed sends logged" />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Audit Log</CardTitle></CardHeader>
          <CardContent>
            {data?.recentAudit?.length ? data.recentAudit.slice(0, 8).map((event) => (
              <div key={event.id} className="rounded-md bg-zinc-950/50 p-3">
                <p className="text-xs font-medium text-zinc-200">{event.action}</p>
                <p className="mt-1 text-[11px] text-zinc-500">{event.actorEmail || 'System'} · {shortDate(event.createdAt)}</p>
              </div>
            )) : <EmptyState text="No audit events yet" />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="flex items-center gap-3">
      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tone === 'danger' ? 'bg-red-500/10 text-red-300' : 'bg-indigo-500/10 text-indigo-300'}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</p>
        <p className="mt-1 text-xl font-semibold text-zinc-100">{value}</p>
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="rounded-md bg-zinc-950/40 px-3 py-4 text-center text-xs text-zinc-500">{text}</p>;
}
