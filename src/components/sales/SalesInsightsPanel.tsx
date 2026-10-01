import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Flame, FlaskConical, MapPin } from 'lucide-react';
import { Badge } from '../ui/badge';
import { leadPhoneForMessaging, type SchoolLeadRow } from '../../api/sheetsClient';
import {
  INTENT_LABELS,
  cityFunnels,
  hotLeads,
  templateStats,
  type Intent,
} from '../../lib/leadInsights';

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const MIN_SENDS_FOR_VERDICT = 30;

type Props = {
  leads: SchoolLeadRow[];
  onSelectLead: (row: SchoolLeadRow) => void;
};

export function SalesInsightsPanel({ leads, onSelectLead }: Props) {
  const [intentFilter, setIntentFilter] = useState<Intent | ''>('');
  // Re-anchor score decay whenever a new set of leads is loaded.
  const now = useMemo(() => Date.now(), [leads]);

  const hot = useMemo(() => hotLeads(leads, 50, now), [leads, now]);
  const hotFiltered = useMemo(
    () => (intentFilter ? hot.filter((h) => h.intents.includes(intentFilter)) : hot).slice(0, 15),
    [hot, intentFilter]
  );
  const templates = useMemo(() => templateStats(leads), [leads]);
  const cities = useMemo(() => cityFunnels(leads, now), [leads, now]);

  const tracked = templates.filter((t) => t.templateId !== 't00_legacy');
  const leader = tracked.find((t) => t.sends >= MIN_SENDS_FOR_VERDICT);
  const runnerUpHigh = leader
    ? Math.max(0, ...tracked.filter((t) => t !== leader && t.sends >= MIN_SENDS_FOR_VERDICT).map((t) => t.ctrHigh))
    : 0;
  const leaderIsClear = Boolean(leader && leader.ctrLow > runnerUpHigh);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 mt-6">
      <div className="surface-card p-5 xl:col-span-5">
        <div className="flex items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-2">
            <Flame className="w-4 h-4 text-orange-400" />
            <h3 className="text-sm font-semibold text-zinc-100">Hot Schools</h3>
          </div>
          <select
            value={intentFilter}
            onChange={(e) => setIntentFilter(e.target.value as Intent | '')}
            className="h-7 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-[11px] text-zinc-300"
            aria-label="Filter by clicked intent"
          >
            <option value="">All intents</option>
            {(Object.keys(INTENT_LABELS) as Intent[]).map((i) => (
              <option key={i} value={i}>
                Clicked {INTENT_LABELS[i]}
              </option>
            ))}
          </select>
        </div>
        <p className="text-[10px] text-zinc-600 mb-3">
          Score = button intent (demo 5, pricing 4, WhatsApp 4, website 3, video 2) + extra clicks + replies, halving every 14 days.
          Scanner clicks are excluded.
        </p>
        <div className="space-y-2 max-h-[420px] overflow-y-auto">
          {hotFiltered.map((h, idx) => {
            const phone = leadPhoneForMessaging(h.row);
            return (
              <div
                key={`${String(h.row['Email ID'] || '')}-${idx}`}
                role="button"
                tabIndex={0}
                onClick={() => onSelectLead(h.row)}
                onKeyDown={(e) => e.key === 'Enter' && onSelectLead(h.row)}
                className="w-full text-left p-3 rounded-lg bg-zinc-800/40 border border-zinc-800 hover:border-zinc-700 cursor-pointer"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-zinc-100 truncate">{String(h.row['School Name'] || 'Unknown school')}</p>
                    <p className="text-[10px] text-zinc-500 truncate">
                      {String(h.row.City || '—')} · {h.reasons.join(' · ') || 'engaged'}
                    </p>
                  </div>
                  <Badge variant={h.score >= 8 ? 'danger' : h.score >= 4 ? 'warning' : 'secondary'} className="text-[10px] flex-shrink-0">
                    {h.score}
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {h.intents.map((i) => (
                    <Badge key={i} variant="info" className="text-[9px]">
                      {INTENT_LABELS[i]}
                    </Badge>
                  ))}
                  {phone && (
                    <>
                      <Link
                        to={`/twilio-messaging?contact=${encodeURIComponent(phone)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="ml-auto text-[10px] text-sky-400 hover:underline"
                      >
                        Message
                      </Link>
                      <Link
                        to={`/ops/leads/${encodeURIComponent(phone)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-[10px] text-zinc-400 hover:underline"
                      >
                        Timeline
                      </Link>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {!hotFiltered.length && (
            <p className="text-[11px] text-zinc-600 text-center py-6">
              No engaged schools yet. Clicks appear here once ZeptoMail events reach the v2 tracking webhook.
            </p>
          )}
        </div>
      </div>

      <div className="xl:col-span-7 space-y-6">
        <div className="surface-card p-5">
          <div className="flex items-center gap-2 mb-1">
            <FlaskConical className="w-4 h-4 text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-100">Email Template Leaderboard</h3>
          </div>
          <p className="text-[10px] text-zinc-600 mb-3">
            Unique click-through per first-email template with a 90% interval. n8n shifts new sends toward the leader
            automatically (Thompson sampling) after {MIN_SENDS_FOR_VERDICT} sends each.
            {leader && (
              <span className={leaderIsClear ? 'text-emerald-400' : 'text-amber-400'}>
                {' '}
                {leaderIsClear
                  ? `${leader.label} is clearly ahead.`
                  : 'No clear winner yet — intervals overlap.'}
              </span>
            )}
          </p>
          <div className="overflow-auto rounded-lg border border-zinc-800">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-zinc-900 text-zinc-500">
                <tr className="border-b border-zinc-800">
                  <th className="px-3 py-2 font-medium">Template</th>
                  <th className="px-3 py-2 font-medium text-right">Sent</th>
                  <th className="px-3 py-2 font-medium text-right">Opened</th>
                  <th className="px-3 py-2 font-medium text-right">Clicked</th>
                  <th className="px-3 py-2 font-medium text-right">CTR (90% CI)</th>
                  <th className="px-3 py-2 font-medium text-right">Replied</th>
                  <th className="px-3 py-2 font-medium">Top button</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => {
                  const top = Object.entries(t.buttons).sort((a, b) => b[1] - a[1])[0];
                  return (
                    <tr key={t.templateId} className="border-b border-zinc-800/60">
                      <td className="px-3 py-2 text-zinc-200">
                        <span className="block">{t.label}</span>
                        <span className="text-[9px] text-zinc-600 font-mono">{t.templateId}</span>
                      </td>
                      <td className="px-3 py-2 text-right text-zinc-300">{t.sends}</td>
                      <td className="px-3 py-2 text-right text-zinc-400">{t.opened}</td>
                      <td className="px-3 py-2 text-right text-zinc-300">{t.clicked}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <span className="text-zinc-100 font-medium">{pct(t.ctr)}</span>
                        <span className="text-zinc-600"> ({pct(t.ctrLow)}–{pct(t.ctrHigh)})</span>
                      </td>
                      <td className="px-3 py-2 text-right text-zinc-300">
                        {t.replied} <span className="text-zinc-600">({pct(t.replyRate)})</span>
                      </td>
                      <td className="px-3 py-2 text-zinc-400">{top ? `${top[0].replace('btn_', '')} (${top[1]})` : '—'}</td>
                    </tr>
                  );
                })}
                {!templates.length && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-zinc-600">
                      No emailed leads in the loaded rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="surface-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <MapPin className="w-4 h-4 text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-100">City Funnel</h3>
          </div>
          <div className="overflow-auto max-h-[260px] rounded-lg border border-zinc-800">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
                <tr className="border-b border-zinc-800">
                  {['City', 'Scraped', 'Emailed', 'Opened', 'Clicked', 'Replied', 'WhatsApp', 'Hot'].map((h) => (
                    <th key={h} className={`px-3 py-2 font-medium ${h === 'City' ? '' : 'text-right'}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cities.map((c) => (
                  <tr key={c.city} className="border-b border-zinc-800/60">
                    <td className="px-3 py-2 text-zinc-200">{c.city}</td>
                    <td className="px-3 py-2 text-right text-zinc-400">{c.scraped}</td>
                    <td className="px-3 py-2 text-right text-zinc-400">{c.emailed}</td>
                    <td className="px-3 py-2 text-right text-zinc-400">{c.opened}</td>
                    <td className="px-3 py-2 text-right text-zinc-300">
                      {c.clicked}
                      {c.emailed > 0 && <span className="text-zinc-600"> ({pct(c.clicked / c.emailed)})</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300">{c.replied}</td>
                    <td className="px-3 py-2 text-right text-zinc-400">{c.whatsapp}</td>
                    <td className="px-3 py-2 text-right">
                      {c.hot > 0 ? <Badge variant="warning" className="text-[9px]">{c.hot}</Badge> : <span className="text-zinc-600">0</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
