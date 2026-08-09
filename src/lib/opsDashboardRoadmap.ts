/**
 * Phase 4 holistic ops capabilities (deferred — documented for follow-up).
 * Core phases 1–3 ship Twilio status, sales execution polling, and Sheets leads.
 */
export const OPS_DASHBOARD_ROADMAP = [
  {
    id: 'ops-home',
    title: 'Ops home (/dashboard)',
    detail: 'Role-aware KPIs: active funnel runs, messages delivered/read today, leads by Lead_status, failed WhatsApp, open follow-ups.',
  },
  {
    id: 'lead-timeline',
    title: 'Unified lead timeline',
    detail: 'Merge sheet row + Twilio thread + email reply status on one lead page.',
  },
  {
    id: 'wa-templates',
    title: 'WhatsApp templates / Content API',
    detail: 'Pick approved HSM templates in Messaging (required outside 24h window).',
  },
  {
    id: 'inbound-webhook',
    title: 'Inbound WhatsApp webhook',
    detail: 'Persist inbound messages to Firestore for live inbox without manual refresh; assignment/notes.',
  },
  {
    id: 'campaign-analytics',
    title: 'Campaign analytics',
    detail: 'Per-city: scraped → emailed → WhatsApp sent → delivered → read → replied.',
  },
  {
    id: 'sla-queue',
    title: 'SLA / follow-up queue',
    detail: 'Surface overdue Next_Follow_up from sheet; one-click open chat or re-run reminder.',
  },
  {
    id: 'agent-assignment',
    title: 'Agent assignment',
    detail: 'Claim threads (assignedTo) so multiple whatsapp_managers do not collide.',
  },
  {
    id: 'export-csv',
    title: 'Export',
    detail: 'CSV download of filtered leads from the dashboard.',
  },
  {
    id: 'alerting',
    title: 'Alerting',
    detail: 'Slack/email when execution errors or Twilio account is suspended.',
  },
  {
    id: 'audit-log',
    title: 'Audit log',
    detail: 'Who launched which city scrape / who sent which WhatsApp.',
  },
] as const;
