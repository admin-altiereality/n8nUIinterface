import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useSheetLeads } from '../lib/useSheetLeads';
import { SEGMENTS, VERIFY_LABELS, buildContacts, type Segment, type VerifyStatus } from '../lib/salesOps';

const selectClass = 'h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-100';
const ROWS_SHOWN = 300;
const VERIFY_TONE: Record<VerifyStatus, string> = {
  verified: 'text-emerald-300',
  site: 'text-zinc-200',
  catch_all: 'text-amber-300',
  unverified: 'text-zinc-500',
  none: 'text-zinc-600',
};

/** Every person the city runs found, with how sure we are of their email. */
export default function ContactsPage() {
  const { leads, loading, error, reload } = useSheetLeads();
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState<Segment | ''>('');
  const [verify, setVerify] = useState<VerifyStatus | ''>('');

  const all = useMemo(() => buildContacts(leads), [leads]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((c) => (!segment || c.segment === segment) && (!verify || c.verify === verify)
      && (!q || [c.name, c.org, c.city, c.email, c.role].some((v) => v.toLowerCase().includes(q))));
  }, [all, query, segment, verify]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(Object.keys(VERIFY_LABELS).map((k) => [k, 0])) as Record<VerifyStatus, number>;
    for (const r of rows) c[r.verify]++;
    return c;
  }, [rows]);

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Contacts" subtitle="Everyone the city runs found, up to two people per organisation, with how each email was found.">
        <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </PageHeader>

      {error && <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error}</div>}

      <div className="surface-card mb-4 space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input placeholder="Search name, organisation, email…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 w-60 text-xs" />
          <select aria-label="Segment" className={selectClass} value={segment} onChange={(e) => setSegment(e.target.value as Segment | '')}>
            <option value="">All segments</option>
            {Object.entries(SEGMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select aria-label="Email status" className={selectClass} value={verify} onChange={(e) => setVerify(e.target.value as VerifyStatus | '')}>
            <option value="">Any email status</option>
            {Object.entries(VERIFY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <p className="text-xs text-zinc-300">
          <span className="font-semibold text-zinc-100">{rows.length}</span> contacts
          {(Object.keys(VERIFY_LABELS) as VerifyStatus[]).map((k) => counts[k] ? <span key={k} className="text-zinc-500"> · {counts[k]} {VERIFY_LABELS[k].toLowerCase()}</span> : null)}
        </p>
      </div>

      <div className="surface-card overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-[11px]">
          <thead className="text-zinc-500">
            <tr className="border-b border-zinc-800">
              {['Name', 'Role', 'Organisation', 'Segment', 'Email', 'Email status', 'Phone'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, ROWS_SHOWN).map((c, i) => (
              <tr key={`${c.leadId}-${c.name}-${i}`} className="border-b border-zinc-800/60 text-zinc-300">
                <td className="px-3 py-2 font-medium text-zinc-100">{c.name || '—'}</td>
                <td className="px-3 py-2">{c.role || '—'}</td>
                <td className="max-w-[240px] truncate px-3 py-2">
                  {c.leadId ? <Link to={`/prospects?lead=${encodeURIComponent(c.leadId)}`} className="hover:underline">{c.org}</Link> : c.org}
                  <span className="ml-1 text-zinc-500">{c.city}</span>
                </td>
                <td className="px-3 py-2">{SEGMENTS[c.segment]}</td>
                <td className="max-w-[220px] truncate px-3 py-2">{c.email || '—'}</td>
                <td className={`px-3 py-2 ${VERIFY_TONE[c.verify]}`}>{VERIFY_LABELS[c.verify]}</td>
                <td className="px-3 py-2 tabular-nums">{c.phone || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="p-6 text-center text-xs text-zinc-500">{loading ? 'Loading…' : 'No contacts match.'}</p>}
      </div>
      {rows.length > ROWS_SHOWN && <p className="mt-2 text-[10px] text-zinc-600">Showing {ROWS_SHOWN} of {rows.length}; narrow the filters to see more.</p>}
      <p className="mt-2 text-[10px] text-zinc-600">Guessed addresses (principal@, info@…) are only kept when Reoon confirms them; catch-all domains accept any address, so those go out last.</p>
    </div>
  );
}
