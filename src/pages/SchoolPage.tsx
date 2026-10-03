import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Briefcase, FileText, Globe, Mail, MessageCircle, RefreshCw, Settings2, StickyNote, UserPlus } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { LeadDrawer } from '../components/sales/LeadDrawer';
import { fetchSchool, type School360, type TimelineEvent } from '../api/opsClient';
import { SOURCE_LABELS, field, formatWhen, ownerLabel, type LeadSource } from '../lib/pipeline';
import { useSheetLeads } from '../lib/useSheetLeads';

const KINDS: Array<{ key: TimelineEvent['kind'] | 'all'; label: string }> = [
  { key: 'all', label: 'Everything' },
  { key: 'email', label: 'Email' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'form', label: 'Forms' },
  { key: 'deal', label: 'Deal' },
  { key: 'note', label: 'Notes & calls' },
];

const ICONS: Record<TimelineEvent['kind'], React.ReactNode> = {
  lead: <UserPlus className="h-3.5 w-3.5 text-indigo-300" />,
  email: <Mail className="h-3.5 w-3.5 text-sky-300" />,
  whatsapp: <MessageCircle className="h-3.5 w-3.5 text-emerald-300" />,
  form: <FileText className="h-3.5 w-3.5 text-pink-300" />,
  deal: <Briefcase className="h-3.5 w-3.5 text-amber-300" />,
  note: <StickyNote className="h-3.5 w-3.5 text-zinc-300" />,
  system: <Settings2 className="h-3.5 w-3.5 text-zinc-500" />,
};

export default function SchoolPage() {
  const { orgKey = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [school, setSchool] = useState<School360 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<(typeof KINDS)[number]['key']>('all');
  const { leads, replaceLead } = useSheetLeads();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSchool(await fetchSchool(orgKey));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this school.');
    } finally {
      setLoading(false);
    }
  }, [orgKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const events = useMemo(() => (school?.events || []).filter((e) => kind === 'all' || e.kind === kind), [school, kind]);
  const nameById = useMemo(() => new Map((school?.contacts || []).map((c) => [c.leadId, c.name || c.email || c.phone])), [school]);

  const leadParam = searchParams.get('lead');
  const openLead = useMemo(() => (leadParam ? leads.find((row) => field(row, 'Lead_id') === leadParam) || null : null), [leads, leadParam]);
  const openContact = (leadId: string) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('lead', leadId);
      return next;
    });
  const closeDrawer = useCallback(
    () =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('lead');
        return next;
      }),
    [setSearchParams]
  );

  const now = Date.now();

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title={school?.name || 'School'} subtitle={[school?.city, school?.board].filter(Boolean).join(' · ') || 'Every contact and every touch in one place'}>
        <div className="flex items-center gap-2">
          <Link to="/pipeline" className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200">
            <ArrowLeft className="h-3.5 w-3.5" /> Pipeline
          </Link>
          {school?.website && (
            <a href={/^https?:/.test(school.website) ? school.website : `https://${school.website}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11px] text-sky-400 hover:underline">
              <Globe className="h-3.5 w-3.5" /> Website
            </a>
          )}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </PageHeader>

      {error && <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">{error}</div>}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="surface-card h-fit p-4">
          <h2 className="mb-3 text-xs font-semibold text-zinc-200">Contacts ({school?.contacts.length ?? 0})</h2>
          <div className="space-y-2">
            {(school?.contacts || []).map((c) => (
              <button
                key={c.leadId}
                type="button"
                onClick={() => openContact(c.leadId)}
                className="w-full rounded-lg border border-zinc-800 bg-zinc-800/40 p-3 text-left text-[11px] hover:border-zinc-700"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-zinc-100">{c.name || c.email || c.phone || c.leadId}</span>
                  <Badge variant="secondary">{c.stage}</Badge>
                </div>
                <p className="mt-0.5 truncate text-zinc-500">{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</p>
                <p className="mt-0.5 text-zinc-500">
                  {SOURCE_LABELS[c.source as LeadSource] || c.source}
                  {c.owner && ` · ${ownerLabel(c.owner.toLowerCase())}`}
                </p>
              </button>
            ))}
            {!school && !error && <p className="text-[11px] text-zinc-500">Loading…</p>}
          </div>
        </div>

        <div className="surface-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-semibold text-zinc-200">Timeline</h2>
            <div className="flex flex-wrap gap-1">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => setKind(k.key)}
                  className={`rounded-full border px-2.5 py-0.5 text-[10px] ${
                    kind === k.key ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200' : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
          <ol className="relative space-y-3 border-l border-zinc-800 pl-5">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`} className="relative">
                <span className="absolute -left-[27px] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900">
                  {ICONS[e.kind]}
                </span>
                <div className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                  <span className="font-medium text-zinc-100">{e.title}</span>
                  <span className="text-zinc-500">{formatWhen(Date.parse(e.at), now)}</span>
                  {e.leadId && (school?.contacts.length ?? 0) > 1 && <span className="text-zinc-600">· {nameById.get(e.leadId) || e.leadId}</span>}
                  {e.actor && <span className="text-zinc-600">· by {ownerLabel(e.actor.toLowerCase())}</span>}
                </div>
                {e.detail && <p className="mt-0.5 whitespace-pre-wrap text-[11px] text-zinc-400">{e.detail}</p>}
              </li>
            ))}
            {school && !events.length && <li className="text-[11px] text-zinc-500">Nothing here yet.</li>}
          </ol>
        </div>
      </div>

      {openLead && <LeadDrawer lead={openLead} onClose={closeDrawer} onChange={replaceLead} />}
    </div>
  );
}
