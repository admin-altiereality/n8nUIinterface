import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarCheck, CalendarX, Copy, Loader2, MessageCircle, Phone, X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { useAuth } from '../../context/AuthContext';
import { fetchLeadActivity, type LeadActivityItem } from '../../api/opsClient';
import { leadPhoneForMessaging, type SchoolLeadRow } from '../../api/sheetsClient';
import {
  LOST_REASONS,
  STAGES,
  bookingLink,
  field,
  formatDuration,
  formatWhen,
  ownerLabel,
  stageOf,
  timeOf,
  whatsappWindowLeftMs,
} from '../../lib/pipeline';
import { useLeadUpdate } from '../../lib/useLeadUpdate';

type Props = {
  lead: SchoolLeadRow;
  onClose: () => void;
  /** Receives the lead as it should look now: optimistically, then the sheet's copy (or the original on failure). */
  onChange: (lead: SchoolLeadRow) => void;
};

const EDITABLE = ['Stage', 'Lost_reason', 'Deal_value', 'Students', 'Package', 'Next_step', 'Next_step_due'] as const;
type Form = Record<(typeof EDITABLE)[number], string>;

const FIELD_LABELS: Record<string, string> = {
  Stage: 'Stage',
  Lost_reason: 'Lost reason',
  Deal_value: 'Deal value',
  Students: 'Students',
  Package: 'Package',
  Next_step: 'Next step',
  Next_step_due: 'Due',
  Owner: 'Owner',
  Do_not_contact: 'Do not contact',
  WhatsApp_number: 'WhatsApp',
  Demo_at: 'Demo',
};

const CONTACT_FIELDS = ['Principal Name', 'Email ID', 'Phone number', 'WhatsApp_number', 'City', 'XR_status', 'Status', 'Email_sent_at', 'Follow_up_count'];

/** ISO time → value for <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function formFrom(lead: SchoolLeadRow): Form {
  return {
    Stage: stageOf(lead),
    Lost_reason: field(lead, 'Lost_reason'),
    Deal_value: field(lead, 'Deal_value'),
    Students: field(lead, 'Students'),
    Package: field(lead, 'Package'),
    Next_step: field(lead, 'Next_step'),
    Next_step_due: toLocalInput(field(lead, 'Next_step_due')),
  };
}

/** One line per activity item, or null for entries that only repeat another (a call's touch stamp sits next to its note). */
function describeActivity(item: LeadActivityItem): string | null {
  if (item.action === 'lead.note') return String(item.details.text || '');
  if (item.action !== 'lead.update') return item.action;
  const fields = (item.details.fields || {}) as Record<string, string>;
  if ('First_touch_at' in fields && Object.keys(fields).length === 1) return null;
  const parts = Object.entries(fields)
    .filter(([key]) => FIELD_LABELS[key])
    .map(([key, value]) => {
      const t = Date.parse(value);
      const shown = !value ? 'cleared' : /_due$|_at$/.test(key) && !Number.isNaN(t) ? formatWhen(t) : value;
      return `${FIELD_LABELS[key]}: ${shown}`;
    });
  return parts.join(' · ') || 'Updated the lead';
}

export function LeadDrawer({ lead, onClose, onChange }: Props) {
  const { user } = useAuth();
  const me = (user?.email || '').toLowerCase();
  const leadId = field(lead, 'Lead_id');
  const { update, busy, error, setError } = useLeadUpdate(onChange);
  const [form, setForm] = useState<Form>(() => formFrom(lead));
  const [note, setNote] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [activity, setActivity] = useState<LeadActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // Start a fresh form for a different lead; background refreshes of the same lead keep edits in progress.
  useEffect(() => {
    setForm(formFrom(lead));
    setNote('');
    setInfo(null);
    setError(null);
  }, [leadId]);

  const loadActivity = useCallback(async () => {
    if (!leadId) return;
    setActivityLoading(true);
    try {
      setActivity(await fetchLeadActivity(leadId));
    } catch {
      setActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (patch: Parameters<typeof update>[1], optimistic: Partial<SchoolLeadRow> = {}, action = 'save') => {
    setInfo(null);
    const ok = await update(lead, patch, optimistic, action);
    if (ok) void loadActivity();
    return ok;
  };

  const baseline = useMemo(() => formFrom(lead), [lead]);
  const changes = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of EDITABLE) {
      if (form[key] === baseline[key]) continue;
      out[key] = key === 'Next_step_due' && form[key] ? new Date(form[key]).toISOString() : form[key].trim();
    }
    if (out.Stage === 'Lost') out.Lost_reason = form.Lost_reason;
    if (form.Stage !== 'Lost') delete out.Lost_reason;
    return out;
  }, [form, baseline]);
  const dirty = Object.keys(changes).length > 0;
  const needsLostReason = form.Stage === 'Lost' && !form.Lost_reason;

  const save = async () => {
    if (await run({ fields: changes }, changes)) setInfo('Saved');
  };

  const addNote = async () => {
    const text = note.trim();
    if (text && (await run({ note: text }, {}, 'note'))) setNote('');
  };

  const owner = field(lead, 'Owner').toLowerCase();
  const stage = stageOf(lead);
  const phone = field(lead, 'WhatsApp_number') || leadPhoneForMessaging(lead);
  const replied = timeOf(lead, 'Replied_at');
  const windowLeft = whatsappWindowLeftMs(lead);
  const isBusy = (action: string) => busy === `${leadId}:${action}`;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={`Lead: ${field(lead, 'School Name')}`}
        className="h-full w-full max-w-md overflow-y-auto border-l border-zinc-800 bg-zinc-900 shadow-xl animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-900/95 px-5 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-zinc-100">{field(lead, 'School Name') || 'Lead'}</h2>
              <p className="text-[11px] text-zinc-500">
                {field(lead, 'City') || '—'} · <span className="text-zinc-300">{stage}</span>
              </p>
            </div>
            <button type="button" onClick={onClose} className="p-1 text-zinc-500 hover:text-zinc-300" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-[11px] text-zinc-400">
              {owner ? (
                <>
                  Owner: <span className="text-zinc-200">{owner === me ? 'you' : ownerLabel(owner)}</span>
                </>
              ) : (
                'Nobody has claimed this lead'
              )}
            </span>
            {(!owner || owner === me) && (
              <Button
                size="sm"
                variant={owner ? 'outline' : 'primary'}
                disabled={Boolean(busy)}
                onClick={() =>
                  void run({ fields: { Owner: owner ? '' : 'me' } }, { Owner: owner ? '' : me }, 'claim')
                }
              >
                {isBusy('claim') && <Loader2 className="h-3 w-3 animate-spin" />}
                {owner ? 'Unclaim' : 'Claim'}
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-5 px-5 py-4">
          <div className="flex flex-wrap gap-2">
            {phone && (
              <a
                href={`tel:${phone}`}
                onClick={() => void run({ touch: 'call', note: 'Called' }, {}, 'call')}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-[11px] text-zinc-100 hover:bg-zinc-800/60"
              >
                <Phone className="h-3.5 w-3.5" /> Call
              </a>
            )}
            {phone && (
              <Link
                to={`/twilio-messaging?contact=${encodeURIComponent(phone)}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-[11px] text-zinc-100 hover:bg-zinc-800/60"
              >
                <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
              </Link>
            )}
            {leadId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(bookingLink(leadId))
                    .then(() => setInfo('Booking link copied'))
                    .catch(() => setInfo(bookingLink(leadId)))
                }
              >
                <Copy className="h-3.5 w-3.5" /> Booking link
              </Button>
            )}
            {stage === 'Demo booked' && (
              <>
                <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void run({ fields: { Stage: 'Demo done' } }, { Stage: 'Demo done' }, 'done')}>
                  <CalendarCheck className="h-3.5 w-3.5" /> Demo done
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(
                      { event: 'no_show' },
                      { Stage: 'Engaged', Next_step: 'Rebook the demo (they missed it)', Next_step_due: new Date().toISOString() },
                      'no_show'
                    )
                  }
                >
                  <CalendarX className="h-3.5 w-3.5" /> No-show
                </Button>
              </>
            )}
          </div>

          {(error || info) && (
            <p className={`text-[11px] ${error ? 'text-amber-400' : 'text-emerald-400'}`}>{error || info}</p>
          )}
          {!leadId && (
            <p className="text-[11px] text-amber-400">This row has no Lead_id yet, so changes can't be saved here.</p>
          )}

          {replied !== null && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <p className="text-[11px] text-emerald-300">
                Replied{field(lead, 'Reply_channel') ? ` on ${field(lead, 'Reply_channel')}` : ''}
                {field(lead, 'Reply_intent') ? ` · ${field(lead, 'Reply_intent')}` : ''} · {formatWhen(replied)}
              </p>
              {field(lead, 'Reply_snippet') && (
                <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-200">“{field(lead, 'Reply_snippet')}”</p>
              )}
              {windowLeft !== null && (
                <p className="mt-1 text-[10px] text-amber-300">
                  WhatsApp reply window: {formatDuration(windowLeft)} left to answer free-form
                </p>
              )}
            </div>
          )}

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Stage</Label>
                <Select value={form.Stage} onChange={(e) => setForm({ ...form, Stage: e.target.value })}>
                  {STAGES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
              {form.Stage === 'Lost' ? (
                <div className="space-y-1">
                  <Label>Lost reason</Label>
                  <Select value={form.Lost_reason} onChange={(e) => setForm({ ...form, Lost_reason: e.target.value })}>
                    <option value="">Pick one…</option>
                    {LOST_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : (
                <div className="space-y-1">
                  <Label>Deal value (₹, excl. GST)</Label>
                  <Input inputMode="numeric" value={form.Deal_value} onChange={(e) => setForm({ ...form, Deal_value: e.target.value.replace(/\D/g, '') })} />
                </div>
              )}
              <div className="space-y-1">
                <Label>Students</Label>
                <Input inputMode="numeric" value={form.Students} onChange={(e) => setForm({ ...form, Students: e.target.value.replace(/\D/g, '') })} />
              </div>
              <div className="space-y-1">
                <Label>Package</Label>
                <Input maxLength={60} value={form.Package} onChange={(e) => setForm({ ...form, Package: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Next step</Label>
              <Input
                maxLength={140}
                placeholder="e.g. Call the principal about the demo slot"
                value={form.Next_step}
                onChange={(e) => setForm({ ...form, Next_step: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Due</Label>
              <Input type="datetime-local" value={form.Next_step_due} onChange={(e) => setForm({ ...form, Next_step_due: e.target.value })} />
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={!dirty || needsLostReason || !leadId || Boolean(busy)}>
                {isBusy('save') && <Loader2 className="h-3 w-3 animate-spin" />} Save
              </Button>
              {dirty && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setForm(baseline)}>
                  Discard
                </Button>
              )}
              {needsLostReason && <span className="text-[10px] text-amber-400">Pick a reason first.</span>}
            </div>
          </form>

          <div className="space-y-2">
            <Label>Note</Label>
            <Textarea
              className="min-h-[70px]"
              placeholder="What happened on the call, what they asked for…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button size="sm" variant="secondary" disabled={!note.trim() || !leadId || Boolean(busy)} onClick={() => void addNote()}>
              {isBusy('note') && <Loader2 className="h-3 w-3 animate-spin" />} Add note
            </Button>
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold text-zinc-200">Activity</h3>
            {activityLoading && !activity.length ? (
              <p className="text-[11px] text-zinc-600">Loading…</p>
            ) : activity.length ? (
              <ul className="space-y-2">
                {activity.map((item, i) => {
                  const text = describeActivity(item);
                  if (text === null) return null;
                  const at = item.createdAt ? Date.parse(item.createdAt) : NaN;
                  return (
                    <li key={`${item.createdAt}-${i}`} className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                      <p className="whitespace-pre-wrap text-[11px] text-zinc-200">{text}</p>
                      <p className="mt-0.5 text-[10px] text-zinc-600">
                        {item.actorEmail ? ownerLabel(item.actorEmail) : 'system'}
                        {!Number.isNaN(at) && ` · ${formatWhen(at)}`}
                      </p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[11px] text-zinc-600">No activity yet.</p>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold text-zinc-200">Contact</h3>
            <dl className="space-y-1.5 text-[11px]">
              {CONTACT_FIELDS.filter((key) => field(lead, key)).map((key) => (
                <div key={key} className="flex gap-3">
                  <dt className="w-32 flex-shrink-0 text-zinc-500">{key}</dt>
                  <dd className="break-all text-zinc-200">
                    {key === 'Email ID' ? (
                      <a className="text-sky-400 hover:underline" href={`mailto:${field(lead, key)}`}>
                        {field(lead, key)}
                      </a>
                    ) : (
                      field(lead, key)
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {field(lead, 'Do_not_contact') && (
              <Badge variant="danger" className="mt-2 text-[10px]">
                Do not contact ({field(lead, 'Do_not_contact').split(':')[0]})
              </Badge>
            )}
          </div>

          <details className="text-[11px]">
            <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">All sheet fields</summary>
            <dl className="mt-2 space-y-1.5">
              {Object.keys(lead)
                .filter((key) => field(lead, key))
                .sort()
                .map((key) => (
                  <div key={key} className="flex gap-3 border-b border-zinc-800/60 pb-1">
                    <dt className="w-40 flex-shrink-0 text-zinc-500">{key}</dt>
                    <dd className="break-all text-zinc-300">{field(lead, key)}</dd>
                  </div>
                ))}
            </dl>
          </details>
        </div>
      </aside>
    </div>
  );
}
