import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, Copy, ExternalLink, Loader2, Mail, MessageCircle, RefreshCw, ShieldOff } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';
import { LeadDrawer } from '../components/sales/LeadDrawer';
import { useAuth } from '../context/AuthContext';
import { leadPhoneForMessaging, type SchoolLeadRow } from '../api/sheetsClient';
import { DAY_MS, field, formatDuration, formatWhen, stageOf } from '../lib/pipeline';
import { checkDraft, draftReply, listReplies, type ReplyAction, type ReplyItem } from '../lib/replyDesk';
import { useAppSettings } from '../lib/useAppSettings';
import { useLeadUpdate } from '../lib/useLeadUpdate';
import { useSheetLeads } from '../lib/useSheetLeads';

const ACTION_LABELS: Record<ReplyAction, { label: string; variant: 'warning' | 'success' | 'danger' | 'secondary' }> = {
  read: { label: 'Needs you', variant: 'warning' },
  answer: { label: 'Draft ready', variant: 'success' },
  opt_out: { label: 'Opted out', variant: 'danger' },
  close: { label: 'Said no', variant: 'secondary' },
  auto: { label: 'Auto-reply', variant: 'secondary' },
};

const keyOf = (item: ReplyItem) => field(item.row, 'Lead_id') || field(item.row, 'School Name');

export default function RepliesPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const { leads, loading, error, fetchedAt, reload, replaceLead } = useSheetLeads({ refreshMs: 60_000 });
  const { update, busy, error: actionError } = useLeadUpdate(replaceLead);
  const settings = useAppSettings();
  const [showAll, setShowAll] = useState(false);
  const [selectedKey, setSelectedKey] = useState('');
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  const now = useMemo(() => Date.now(), [leads]);
  const replies = useMemo(() => listReplies(leads, now), [leads, now]);
  const openCount = replies.filter((r) => r.open).length;
  const visible = useMemo(() => (showAll ? replies : replies.filter((r) => r.open)), [replies, showAll]);
  const current = visible.find((r) => keyOf(r) === selectedKey) || visible[0] || null;
  const currentKey = current ? keyOf(current) : '';

  // A new draft only when the rep moves to another reply, so the minute refresh never wipes their edits.
  const sender = user?.name || 'LearnXR team';
  useEffect(() => {
    setDraft(current ? draftReply(current, sender) : '');
    setCopied(false);
  }, [currentKey, sender]);

  const issues = useMemo(() => (current?.action === 'answer' ? checkDraft(draft) : []), [current?.action, draft]);
  const blocked = issues.some((i) => i.level === 'block');

  const move = useCallback(
    (step: number) => {
      if (!visible.length) return;
      const at = Math.max(0, visible.findIndex((r) => keyOf(r) === currentKey));
      setSelectedKey(keyOf(visible[Math.min(visible.length - 1, Math.max(0, at + step))]));
    },
    [visible, currentKey]
  );

  const copyDraft = useCallback(async () => {
    if (!draft || blocked) return;
    await navigator.clipboard.writeText(draft);
    setCopied(true);
  }, [draft, blocked]);

  const markAnswered = useCallback(() => {
    if (!current || current.action === 'opt_out' || busy) return;
    const row = current.row;
    const due = new Date(Date.now() + 2 * DAY_MS).toISOString();
    const step = { Next_step: 'See if they answered', Next_step_due: due };
    const fields: Record<string, string> = { ...step };
    if (['New', 'Contacted'].includes(stageOf(row))) fields.Stage = 'Engaged';
    void update(row, { fields, touch: current.channel, note: 'Answered their reply' }, fields, 'answered');
  }, [current, busy, update]);

  const leadParam = searchParams.get('lead');
  const openLead = useMemo(
    () => (leadParam ? leads.find((row) => field(row, 'Lead_id') === leadParam) || null : null),
    [leads, leadParam]
  );
  const openDrawer = useCallback(
    (row: SchoolLeadRow) => {
      const id = field(row, 'Lead_id');
      if (id) setSearchParams({ lead: id });
    },
    [setSearchParams]
  );
  const closeDrawer = useCallback(() => setSearchParams({}), [setSearchParams]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (openLead || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === 'j') move(1);
      else if (key === 'k') move(-1);
      else if (key === 'c') void copyDraft();
      else if (key === 'a') markAnswered();
      else if (key === 'o' && current) openDrawer(current.row);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openLead, move, copyDraft, markAnswered, current, openDrawer]);

  const row = current?.row;
  const email = row ? field(row, 'Email ID') : '';
  const phone = row ? field(row, 'WhatsApp_number') || leadPhoneForMessaging(row) : null;
  const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Re: LearnXR')}&body=${encodeURIComponent(draft)}`;

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="Reply Desk" subtitle="Every reply from a school, what to do about it, and a draft to start from.">
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-zinc-700 p-0.5">
            {[false, true].map((all) => (
              <button
                key={String(all)}
                type="button"
                onClick={() => setShowAll(all)}
                className={`rounded-md px-3 py-1 text-[11px] font-medium ${
                  showAll === all ? 'bg-indigo-500/20 text-indigo-200' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {all ? `All ${replies.length}` : `Waiting ${openCount}`}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </PageHeader>

      {(error || actionError) && (
        <div className="mb-4 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          {actionError || error}
        </div>
      )}

      {!visible.length ? (
        <div className="surface-card p-8 text-center text-xs text-zinc-500">
          {loading && !leads.length ? 'Loading replies…' : showAll ? 'No replies yet.' : 'Nothing is waiting on you.'}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <div className="max-h-[70vh] space-y-1.5 overflow-y-auto pr-1">
            {visible.map((item) => {
              const active = keyOf(item) === currentKey;
              const tag = ACTION_LABELS[item.action];
              return (
                <button
                  key={keyOf(item)}
                  type="button"
                  onClick={() => setSelectedKey(keyOf(item))}
                  className={`w-full rounded-lg border p-2.5 text-left ${
                    active ? 'border-indigo-500/50 bg-indigo-500/10' : 'border-zinc-800 bg-zinc-800/40 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-medium text-zinc-100">{field(item.row, 'School Name') || 'Unknown school'}</p>
                    <Badge variant={item.open ? tag.variant : 'secondary'} className="flex-shrink-0 text-[9px]">
                      {item.open ? tag.label : 'Handled'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-zinc-500">
                    {item.at !== null ? `${formatWhen(item.at, now)} · ` : ''}
                    {item.text || 'No text saved'}
                  </p>
                </button>
              );
            })}
          </div>

          {current && row && (
            <div className="surface-card space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-zinc-100">{field(row, 'School Name') || 'Unknown school'}</h2>
                  <p className="text-[11px] text-zinc-500">
                    {[field(row, 'Principal Name'), field(row, 'City'), stageOf(row), field(row, 'Board')].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => openDrawer(row)}>
                  <ExternalLink className="h-3.5 w-3.5" /> Open lead
                </Button>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="mb-1 flex items-center gap-1.5 text-[10px] text-zinc-500">
                  {current.channel === 'whatsapp' ? <MessageCircle className="h-3 w-3" /> : <Mail className="h-3 w-3" />}
                  {current.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}
                  {current.at !== null && ` · ${formatWhen(current.at, now)}`}
                  {current.confidence !== null && ` · ${Math.round(current.confidence * 100)}% sure`}
                </p>
                <p className="whitespace-pre-wrap text-xs text-zinc-200">{current.text || 'The reply text was not saved.'}</p>
              </div>

              <p className="text-[11px] text-zinc-400">{current.reason}</p>
              {current.channel === 'whatsapp' && current.open && (
                <p className="text-[11px] text-amber-300">
                  {current.windowLeftMs !== null
                    ? `${formatDuration(current.windowLeftMs)} left to answer free-form on WhatsApp.`
                    : "WhatsApp's 24-hour window has closed, so only an approved template can go out."}
                </p>
              )}

              {current.action === 'opt_out' ? (
                current.open && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={() => void update(row, { fields: { Do_not_contact: 'manual' } }, { Do_not_contact: 'manual' }, 'dnc')}
                  >
                    <ShieldOff className="h-3.5 w-3.5" /> Mark do not contact
                  </Button>
                )
              ) : (
                <>
                  {current.action === 'answer' && (
                    <>
                      {!!settings?.replyTemplates.length && (
                        <select
                          aria-label="Use a saved reply"
                          className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-100"
                          value=""
                          onChange={(e) => {
                            const template = settings.replyTemplates[Number(e.target.value)];
                            if (template) setDraft(template.body);
                          }}
                        >
                          <option value="">Use a saved reply…</option>
                          {settings.replyTemplates.map((t, i) => (
                            <option key={t.title} value={i}>{t.title}</option>
                          ))}
                        </select>
                      )}
                      <Textarea rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Draft reply" className="text-xs" />
                      {issues.map((issue) => (
                        <p key={issue.message} className={`text-[11px] ${issue.level === 'block' ? 'text-red-400' : 'text-amber-300'}`}>
                          {issue.message}
                        </p>
                      ))}
                    </>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    {current.action === 'answer' && (
                      <Button variant="outline" size="sm" disabled={blocked} onClick={() => void copyDraft()}>
                        <Copy className="h-3.5 w-3.5" /> {copied ? 'Copied' : 'Copy'}
                      </Button>
                    )}
                    {current.action === 'answer' && current.channel === 'email' && email && !blocked && (
                      <a href={mailto} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800/60">
                        <Mail className="h-3.5 w-3.5" /> Open in mail
                      </a>
                    )}
                    {current.channel === 'whatsapp' && phone && (
                      <Link
                        to={`/twilio-messaging?contact=${encodeURIComponent(phone)}`}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-700 px-3 text-xs text-zinc-200 hover:bg-zinc-800/60"
                      >
                        <MessageCircle className="h-3.5 w-3.5" /> Open in Messaging
                      </Link>
                    )}
                    {current.open && (
                      <Button size="sm" disabled={Boolean(busy)} onClick={markAnswered}>
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Mark answered
                      </Button>
                    )}
                  </div>
                </>
              )}
              <p className="text-[10px] text-zinc-600">J / K move · C copy · A mark answered · O open lead. Nothing sends from this page.</p>
            </div>
          )}
        </div>
      )}

      {fetchedAt && <p className="mt-4 text-[10px] text-zinc-600">Updated {new Date(fetchedAt).toLocaleTimeString()} · refreshes every minute</p>}
      {openLead && <LeadDrawer lead={openLead} onClose={closeDrawer} onChange={replaceLead} />}
    </div>
  );
}
