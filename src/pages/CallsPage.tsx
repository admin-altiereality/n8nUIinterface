import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, PhoneCall, Play, RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { fetchVoiceCalls, fetchVoiceRecording, requestAiCall, type VoiceCall, type VoiceTotals, type AppSettings } from '../api/opsClient';
import { field, formatWhen } from '../lib/pipeline';
import { useSheetLeads } from '../lib/useSheetLeads';
import { voiceDecision } from '../lib/voiceGate';

const OUTCOME_LABEL: Record<VoiceCall['outcome'], { label: string; className: string }> = {
  demo_booked: { label: 'Demo booked', className: 'text-emerald-300' },
  interested: { label: 'Interested', className: 'text-sky-300' },
  callback: { label: 'Callback', className: 'text-amber-300' },
  not_interested: { label: 'Not interested', className: 'text-zinc-400' },
  wrong_person: { label: 'Wrong person', className: 'text-zinc-400' },
  opted_out: { label: 'Opted out', className: 'text-red-300' },
  no_conversation: { label: 'No answer', className: 'text-zinc-500' },
};

const MODE_BADGE: Record<AppSettings['voiceMode'], string> = {
  off: 'AI calling is off',
  test: 'Test mode: test numbers only',
  live: 'Live: opted-in leads',
};

const minutes = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const istDayStartIso = () => {
  const ist = new Date(Date.now() + 5.5 * 3_600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3_600_000).toISOString();
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="surface-card stat-card">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="text-[10px] text-zinc-500">{sub}</span>}
    </div>
  );
}

function CallRow({ call }: { call: VoiceCall }) {
  const [open, setOpen] = useState(false);
  const [audio, setAudio] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const outcome = OUTCOME_LABEL[call.outcome];
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio); }, [audio]);

  const play = async () => {
    setLoadingAudio(true);
    setAudioError(null);
    try {
      setAudio(await fetchVoiceRecording(call.id));
    } catch (e) {
      setAudioError(e instanceof Error ? e.message : 'Recording unavailable.');
    } finally {
      setLoadingAudio(false);
    }
  };

  return (
    <li className="py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-zinc-100">
            <Link to={`/pipeline?lead=${encodeURIComponent(call.leadId)}`} className="font-medium hover:underline">
              {call.orgName || call.leadId}
            </Link>
            <span className="text-zinc-500"> · {call.audience === 'partner' ? 'Channel partner' : 'School'} · …{call.toLast4}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-400">{call.summary || (call.terminal ? 'No summary.' : 'Call in progress…')}</p>
        </div>
        <div className="flex-shrink-0 text-right text-[10px] text-zinc-500">
          <p className={`text-[11px] font-medium ${outcome.className}`}>
            {outcome.label}
            {call.interest ? ` · ${call.interest}/5` : ''}
          </p>
          <p>
            {formatWhen(Date.parse(call.createdAt))} · {minutes(call.seconds)}
            {call.voice ? ` · ${call.voice}` : ''}
          </p>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-3 text-[10px]">
        {call.transcript && (
          <button type="button" onClick={() => setOpen(!open)} className="text-sky-400 hover:underline">
            {open ? 'Hide transcript' : 'Transcript'}
          </button>
        )}
        {call.hasRecording && !audio && (
          <button type="button" onClick={() => void play()} disabled={loadingAudio} className="inline-flex items-center gap-1 text-sky-400 hover:underline">
            {loadingAudio ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />} Recording
          </button>
        )}
        {audioError && <span className="text-red-300">{audioError}</span>}
      </div>
      {audio && <audio src={audio} controls autoPlay className="mt-2 h-8 w-full max-w-md" />}
      {open && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-[11px] text-zinc-400">
          {call.transcript}
        </pre>
      )}
    </li>
  );
}

export default function CallsPage() {
  const [data, setData] = useState<{ calls: VoiceCall[]; month: VoiceTotals; settings: AppSettings } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calling, setCalling] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { leads } = useSheetLeads({ refreshMs: 120_000 });

  const load = useCallback(() => {
    setError(null);
    fetchVoiceCalls().then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Could not load AI calls.'));
  }, []);
  useEffect(load, [load]);

  // Leads the agent will call next, or is waiting on, with the reason; skipped leads aren't listed.
  const queue = useMemo(() => {
    if (!data) return [];
    const today = istDayStartIso();
    const usage = { callsToday: data.calls.filter((c) => c.createdAt >= today).length, minutesThisMonth: data.month.minutes };
    return leads
      .map((row) => ({ row, decision: voiceDecision(row, data.settings, usage) }))
      .filter(({ decision }) => decision.status !== 'skip')
      .sort((a, b) => (a.decision.status === 'call' ? -1 : 0) - (b.decision.status === 'call' ? -1 : 0))
      .slice(0, 30);
  }, [leads, data]);

  const callNow = async (leadId: string) => {
    setCalling(leadId);
    setNotice(null);
    try {
      const r = await requestAiCall(leadId);
      setNotice(r.reason ? `Not called: ${r.reason}` : 'Call started. It appears below when it ends.');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not start the call.');
    } finally {
      setCalling(null);
    }
  };

  const m = data?.month;
  const budget = data?.settings.voiceMonthlyMinuteBudget || 0;

  return (
    <div className="page-container animate-fade-in">
      <PageHeader title="AI Calls" subtitle="Anika, the AI calling agent, calls people who enquired and books demos.">
        <div className="flex items-center gap-2">
          {data && <Badge variant="outline">{MODE_BADGE[data.settings.voiceMode]}</Badge>}
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </PageHeader>

      {error && <div className="mb-4 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{error}</div>}
      {notice && <div className="mb-4 rounded-md border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-200">{notice}</div>}
      {!data && !error && <div className="surface-card p-6 text-center text-xs text-zinc-500">Loading AI calls…</div>}

      {data && m && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Calls this month" value={String(m.calls)} />
            <Stat label="Conversations" value={String(m.conversations)} sub={m.calls ? `${Math.round((m.conversations / m.calls) * 100)}% answered` : undefined} />
            <Stat label="Demos booked" value={String(m.demosBooked)} />
            <Stat label="Minutes used" value={`${m.minutes} / ${budget}`} />
            <Stat label="Spend (approx.)" value={`₹${m.costInr.toLocaleString('en-IN')}`} sub={m.optedOut ? `${m.optedOut} opted out` : undefined} />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <section className="surface-card p-4 lg:col-span-2">
              <h2 className="mb-1 text-sm font-semibold text-zinc-100">Recent calls</h2>
              {!data.calls.length && <p className="text-[11px] text-zinc-500">No AI calls yet.</p>}
              <ul className="divide-y divide-zinc-800">
                {data.calls.map((c) => (
                  <CallRow key={c.id} call={c} />
                ))}
              </ul>
            </section>

            <div className="space-y-6">
              <section className="surface-card p-4">
                <h2 className="mb-1 text-sm font-semibold text-zinc-100">Up next</h2>
                <p className="mb-2 text-[10px] text-zinc-500">
                  Only people who enquired in the last 7 days, or asked for a callback; Mon–Sat {data.settings.voiceHours.start}:00–{data.settings.voiceHours.end}:00 IST; 2 attempts at most.
                </p>
                {!queue.length && <p className="text-[11px] text-zinc-500">Nobody is due.</p>}
                <ul className="divide-y divide-zinc-800">
                  {queue.map(({ row, decision }) => {
                    const id = field(row, 'Lead_id');
                    return (
                      <li key={id} className="flex items-center justify-between gap-2 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs text-zinc-100">{field(row, 'School Name') || 'Unknown'}</p>
                          <p className={`text-[10px] ${decision.status === 'call' ? 'text-emerald-300' : 'text-zinc-500'}`}>{decision.reason}</p>
                        </div>
                        {decision.status === 'call' && (
                          <Button variant="outline" size="sm" disabled={calling === id} onClick={() => void callNow(id)}>
                            {calling === id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PhoneCall className="h-3.5 w-3.5" />}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="surface-card p-4">
                <h2 className="mb-2 text-sm font-semibold text-zinc-100">Voices this month</h2>
                {!Object.keys(m.byVoice).length && <p className="text-[11px] text-zinc-500">No calls yet.</p>}
                <table className="w-full text-left text-[11px]">
                  <tbody className="divide-y divide-zinc-800 text-zinc-300">
                    {Object.entries(m.byVoice).map(([voice, v]) => (
                      <tr key={voice}>
                        <td className="py-1.5 capitalize">{voice}</td>
                        <td className="py-1.5 text-zinc-500">{v.calls} calls</td>
                        <td className="py-1.5 text-zinc-500">{v.conversations} talked</td>
                        <td className="py-1.5 text-emerald-300">{v.demosBooked} demos</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
