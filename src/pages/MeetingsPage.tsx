import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Video } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/button';
import { fetchBookings, type DemoBooking } from '../api/opsClient';
import { field } from '../lib/pipeline';
import { useSheetLeads } from '../lib/useSheetLeads';

type View = 'upcoming' | 'past' | 'cancelled';
const VIEWS: Record<View, string> = { upcoming: 'Upcoming', past: 'Past', cancelled: 'Cancelled or moved' };
const selectClass = 'h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-100';
const when = (iso: string) =>
  iso ? new Date(iso).toLocaleString('en-IN', { weekday: 'short', dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '—';

/** Demo meetings booked on cal.com (from emails, WhatsApp or the booking page), matched to their lead. */
export default function MeetingsPage() {
  const { leads, loading: leadsLoading, reload: reloadLeads } = useSheetLeads();
  const [bookings, setBookings] = useState<DemoBooking[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('upcoming');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBookings(await fetchBookings());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load meetings.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const now = useMemo(() => Date.now(), [bookings]);
  const rows = useMemo(() => {
    const byId = new Map(leads.map((row) => [field(row, 'Lead_id'), row]));
    const byEmail = new Map(leads.map((row) => [field(row, 'Email ID').toLowerCase(), row]));
    return bookings
      .filter((b) => {
        if (view === 'cancelled') return b.status !== 'booked';
        const ended = Date.parse(b.endTime || b.startTime) < now;
        return b.status === 'booked' && (view === 'past' ? ended : !ended);
      })
      .sort((a, b) => (view === 'upcoming' ? 1 : -1) * a.startTime.localeCompare(b.startTime))
      .map((b) => ({ b, lead: (b.leadId && byId.get(b.leadId)) || (b.email && byEmail.get(b.email)) || null }));
  }, [bookings, leads, view, now]);
  const upcoming = bookings.filter((b) => b.status === 'booked' && Date.parse(b.endTime || b.startTime) >= now).length;

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Meetings" subtitle="Demos booked on cal.com, newest bookings arrive within seconds.">
        <Button variant="outline" size="sm" onClick={() => { void load(); void reloadLeads(); }} disabled={loading || leadsLoading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </PageHeader>

      {error && <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error}</div>}

      <div className="surface-card mb-4 flex flex-wrap items-center gap-2 p-4">
        <select aria-label="Which meetings" className={selectClass} value={view} onChange={(e) => setView(e.target.value as View)}>
          {Object.entries(VIEWS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="text-xs text-zinc-300"><span className="font-semibold text-zinc-100">{upcoming}</span> upcoming</span>
      </div>

      <div className="surface-card overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-[11px]">
          <thead className="text-zinc-500">
            <tr className="border-b border-zinc-800">
              {['When (IST)', 'Who', 'School / lead', 'Status', ''].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ b, lead }) => (
              <tr key={b.uid} className="border-b border-zinc-800/60 text-zinc-300">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-zinc-100">{when(b.startTime)}</td>
                <td className="px-3 py-2">
                  <span className="font-medium text-zinc-100">{b.name || '—'}</span>
                  <span className="block text-zinc-500">{b.email}</span>
                </td>
                <td className="max-w-[260px] truncate px-3 py-2">
                  {lead ? (
                    <Link to={`/prospects?lead=${encodeURIComponent(field(lead, 'Lead_id'))}`} className="hover:underline">
                      {field(lead, 'School Name') || 'Lead'} <span className="text-zinc-500">{field(lead, 'City')}</span>
                    </Link>
                  ) : <span className="text-zinc-500">Not matched to a lead</span>}
                </td>
                <td className="px-3 py-2">{b.status === 'booked' ? 'Booked' : b.status === 'cancelled' ? 'Cancelled' : 'Moved'}</td>
                <td className="px-3 py-2">
                  {b.meetUrl && b.status === 'booked' && (
                    <a href={b.meetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-300 hover:underline">
                      <Video className="h-3 w-3" /> Join
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="p-6 text-center text-xs text-zinc-500">{loading ? 'Loading…' : 'No meetings here.'}</p>}
      </div>
      <p className="mt-2 text-[10px] text-zinc-600">Bookings are matched to a lead by the link they booked from, or else by email. Shown from 13 Nov 2026.</p>
    </div>
  );
}
