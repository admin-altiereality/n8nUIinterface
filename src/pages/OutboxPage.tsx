import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/button';
import { useSheetLeads } from '../lib/useSheetLeads';
import { OUTCOMES, SEGMENTS, SENT_KINDS, VERIFY_LABELS, buildOutbox, type Outcome, type Segment, type SentKind } from '../lib/salesOps';

const selectClass = 'h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-100';
const ROWS_SHOWN = 300;
const when = (t: number) => new Date(t).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const OUTCOME_TONE: Record<Outcome, string> = {
  replied: 'text-emerald-300',
  bounced: 'text-red-300',
  clicked: 'text-sky-300',
  opened: 'text-sky-200',
  delivered: 'text-zinc-300',
  sent: 'text-zinc-500',
};

/** Every cold email the automation sent, newest first: review after the fact (nothing waits here for approval). */
export default function OutboxPage() {
  const { leads, loading, error, reload } = useSheetLeads();
  const [days, setDays] = useState(14);
  const [segment, setSegment] = useState<Segment | ''>('');
  const [kind, setKind] = useState<SentKind | ''>('');
  const [outcome, setOutcome] = useState<Outcome | ''>('');

  const now = useMemo(() => Date.now(), [leads]);
  const all = useMemo(() => buildOutbox(leads, now, days), [leads, now, days]);
  const rows = useMemo(
    () => all.filter((e) => (!segment || e.segment === segment) && (!kind || e.kind === kind) && (!outcome || e.outcome === outcome)),
    [all, segment, kind, outcome]
  );
  const counts = useMemo(() => {
    const c = Object.fromEntries(Object.keys(OUTCOMES).map((k) => [k, 0])) as Record<Outcome, number>;
    for (const e of rows) c[e.outcome]++;
    return c;
  }, [rows]);

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Outbox" subtitle="Every cold email sent, with what happened to it. Message text isn't stored, only who got which email.">
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </PageHeader>

      {error && <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error}</div>}

      <div className="surface-card mb-4 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Period" className={selectClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 14, 30].map((d) => <option key={d} value={d}>{d === 1 ? 'Last 24 hours' : `Last ${d} days`}</option>)}
          </select>
          <select aria-label="Segment" className={selectClass} value={segment} onChange={(e) => setSegment(e.target.value as Segment | '')}>
            <option value="">All segments</option>
            {Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select aria-label="Email" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as SentKind | '')}>
            <option value="">Any email</option>
            {Object.entries(SENT_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select aria-label="Outcome" className={selectClass} value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome | '')}>
            <option value="">Any outcome</option>
            {Object.entries(OUTCOMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <p className="text-xs text-zinc-300">
          <span className="font-semibold text-zinc-100">{rows.length}</span> emails
          {(Object.keys(OUTCOMES) as Outcome[]).map((k) => counts[k] ? <span key={k} className="text-zinc-500"> · {counts[k]} {OUTCOMES[k].toLowerCase()}</span> : null)}
        </p>
      </div>

      <div className="surface-card overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-[11px]">
          <thead className="text-zinc-500">
            <tr className="border-b border-zinc-800">
              {['Sent', 'Email', 'Organisation', 'Segment', 'To', 'Address', 'Outcome'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROWS_SHOWN).map((e) => (
              <tr key={`${e.leadId}-${e.kind}-${e.sentAt}`} className="border-b border-zinc-800/60 text-zinc-300">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{when(e.sentAt)}</td>
                <td className="px-3 py-2">{SENT_KINDS[e.kind]}</td>
                <td className="max-w-[240px] truncate px-3 py-2 font-medium text-zinc-100">
                  {e.leadId ? <Link to={`/prospects?lead=${encodeURIComponent(e.leadId)}`} className="hover:underline">{e.org}</Link> : e.org}
                  <span className="ml-1 font-normal text-zinc-500">{e.city}</span>
                </td>
                <td className="px-3 py-2">{SEGMENTS[e.segment]}</td>
                <td className="max-w-[220px] truncate px-3 py-2">{e.to}</td>
                <td className="px-3 py-2 text-zinc-400">{VERIFY_LABELS[e.verify]}</td>
                <td className={`px-3 py-2 font-medium ${OUTCOME_TONE[e.outcome]}`}>{OUTCOMES[e.outcome]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="p-6 text-center text-xs text-zinc-500">{loading ? 'Loading…' : 'No emails sent in this period.'}</p>}
      </div>
      {rows.length > ROWS_SHOWN && <p className="mt-2 text-[10px] text-zinc-600">Showing the latest {ROWS_SHOWN} of {rows.length}.</p>}
      <p className="mt-2 text-[10px] text-zinc-600">The sheet keeps each lead's first email and latest follow-up, so earlier follow-ups to the same lead don't appear separately.</p>
    </div>
  );
}
