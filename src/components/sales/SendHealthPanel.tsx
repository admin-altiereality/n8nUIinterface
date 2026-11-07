import React, { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, OctagonX } from 'lucide-react';
import type { SchoolLeadRow } from '../../api/sheetsClient';
import { formatWhen } from '../../lib/pipeline';
import { BOUNCE_STOP, BOUNCE_WATCH, MIN_SENDS, dailyActivity, sendHealth, topBounceReasons, type DayCount, type HealthVerdict } from '../../lib/sendHealth';

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const VERDICTS: Record<HealthVerdict, { label: string; className: string; icon: React.ReactNode }> = {
  good: { label: 'Healthy', className: 'text-emerald-300', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
  watch: { label: `Watch: over ${pct(BOUNCE_WATCH)} bounces`, className: 'text-amber-300', icon: <AlertTriangle className="h-3.5 w-3.5" /> },
  stop: { label: `Stop and clean the list: over ${pct(BOUNCE_STOP)} bounces`, className: 'text-red-400', icon: <OctagonX className="h-3.5 w-3.5" /> },
  too_few: { label: `Too few sends to judge (under ${MIN_SENDS})`, className: 'text-zinc-400', icon: <CircleHelp className="h-3.5 w-3.5" /> },
};

function Trend({ label, days, metric, now }: { label: string; days: DayCount[]; metric: 'found' | 'sent' | 'replies'; now: number }) {
  const total = days.reduce((n, d) => n + d[metric], 0);
  const max = Math.max(1, ...days.map((d) => d[metric]));
  return (
    <div>
      <p className="text-[10px] text-zinc-500">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-zinc-100">{total}</p>
      <div className="mt-1 flex h-8 items-end gap-0.5" role="img" aria-label={`${label}: ${total} in 14 days`}>
        {days.map((d) => (
          // The full column height is the hover target, so a zero day can still be read.
          <div key={d.day} className="group flex h-full flex-1 items-end" title={`${formatWhen(d.day, now).replace(/^(Today|Yesterday) .*/, '$1')}: ${d[metric]}`}>
            <div
              className="w-full rounded-t-[2px] bg-indigo-400/70 group-hover:bg-indigo-300"
              style={{ height: d[metric] ? `${Math.max(8, (d[metric] / max) * 100)}%` : '1px' }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SendHealthPanel({ leads, now }: { leads: SchoolLeadRow[]; now: number }) {
  const days = useMemo(() => dailyActivity(leads, now), [leads, now]);
  const health = useMemo(() => sendHealth(leads, now), [leads, now]);
  const reasons = useMemo(() => topBounceReasons(leads, now), [leads, now]);
  const overall = health[0];
  const verdict = overall ? VERDICTS[overall.verdict] : null;

  return (
    <div className="surface-card mb-6 grid gap-6 p-4 lg:grid-cols-2">
      <div>
        <h3 className="mb-3 text-xs font-semibold text-zinc-200">Last 14 days</h3>
        <div className="grid grid-cols-3 gap-4">
          <Trend label="Schools found" days={days} metric="found" now={now} />
          <Trend label="Emails sent" days={days} metric="sent" now={now} />
          <Trend label="Replies" days={days} metric="replies" now={now} />
        </div>
      </div>
      <div>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold text-zinc-200">Email health, last 30 days</h3>
          {verdict && (
            <span className={`inline-flex items-center gap-1 text-[11px] ${verdict.className}`}>
              {verdict.icon} {verdict.label}
            </span>
          )}
        </div>
        {!overall ? (
          <p className="text-[11px] text-zinc-500">No emails sent in the last 30 days.</p>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="text-zinc-500">
              <tr>
                <th scope="col" className="pb-1 text-left font-medium">Mailbox</th>
                {['Sent', 'Bounced', 'Opened', 'Replied'].map((h) => (
                  <th key={h} scope="col" className="pb-1 text-right font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums text-zinc-300">
              {health.map((m) => (
                <tr key={m.mailbox}>
                  <td className="max-w-[140px] truncate py-0.5 text-zinc-200">{m.mailbox}</td>
                  <td className="text-right">{m.sent}</td>
                  <td className="text-right">{pct(m.bounceRate)}</td>
                  <td className="text-right">{pct(m.openRate)}</td>
                  <td className="text-right">{pct(m.replyRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!!reasons.length && (
          <p className="mt-2 truncate text-[10px] text-zinc-500">
            Top bounces: {reasons.map((r) => `${r.reason} (${r.count})`).join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}
