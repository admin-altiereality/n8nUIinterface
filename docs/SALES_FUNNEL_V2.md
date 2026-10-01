# Sales Funnel v2: email template testing and click-based targeting

This branch adds click insights to the webapp. Two companion n8n workflows go with it:
**Data Scrap + Email + Whatsapp Sales Funnel (v2)** and **Follow Up (v2)**.

The workflow exports are **not** stored in this repository. The repo is public, and the
exports contain internal IDs. They are shared privately.

## What changed in n8n (v2 copies; v1 stays untouched)

| Area | v1 behaviour | v2 behaviour |
|---|---|---|
| API keys | Google Places, ElevenLabs and OpenAI keys hard-coded in node parameters | Read from n8n credentials (Query Auth / Header Auth) |
| Re-scraping a city | Upsert on `School Name` reset Status, follow-ups and click tracking, then re-emailed the school | Existing schools (same `place_id`, same name + city, or same email) are skipped. Only new schools are appended. |
| Places results | 20 per city | Up to 60 (follows `next_page_token`) |
| City-start webhook | Replied "Workflow got started." (the UI could not poll) | Replies `{ executionId }`, so the Sales Funnel page shows live node progress |
| WhatsApp on city run | Read the whole sheet once per scraped school; messaged every city | Reads the sheet once; messages only the run's city |
| First email | One template, one WhatsApp button | 4 templates assigned by A/B testing, then Thompson sampling; each button is tagged `utm_content=<template>__<stage>__<button>` |
| Follow-ups | Untagged CTA | Same AI follow-ups; CTA tagged with template + `fu1/fu2/fu3`; pricing clickers get a pricing CTA |
| Click tracking | Counted every click, including email security scanners | Clicks ≤15 s after send, multi-link bursts and scanner user agents go to `Suspected_bot_clicks` and are not counted |
| Reply detection | Gmail thread lookup on a `Thread ID` that was never written; manual trigger only | IMAP trigger on the admin@ inbox; skips auto-replies; classifies intent; asks for human review below 60% confidence; logs `Reply_intent` |
| Pricing reply | Marked lead as `Drop` | Marked `Pricing requested` |
| Manual 1-week reminder | Every row matched (wrong column name + inverted condition); mixed data from another branch | Removed: the Follow Up workflow owns reminders |
| Weekly WhatsApp reminder | Resent the same template to every non-replier every week, with blank names | Once per lead, ≥7 days after the first message, skipping replied or dropped leads |

## New `school data` sheet columns

Add these headers to the **school data** tab before going live:

```
place_id, Email_template_id, Email_stage, Email_sent_at, Email_request_id,
Last_Clicked_Template, Last_Clicked_Stage, Clicked_Demo, Clicked_Pricing, Suspected_bot_clicks,
Reply_intent, Reply_confidence, Replied_at, Reply_snippet,
Whatsapp_reminder_count, Whatsapp_reminder_at, Whatsapp_reminder_sid
```

## Cutover checklist

1. **Back up first.** Keep the private backup exports of both v1 workflows. n8n's own version history also keeps them.
2. **Rotate the leaked keys.** Rotate the Google Maps, ElevenLabs and OpenAI keys that were hard-coded in v1. Create n8n credentials:
   - *Query Auth* `key=<Google key>`, used by `HTTP Request` and `HTTP Request1`
   - *Header Auth* `xi-api-key=<ElevenLabs key>`, used by `Voice Call (positive)`
   - The existing OpenAI Header Auth credential, used by `Classify Reply (OpenAI)`
   - *IMAP* for the admin@ mailbox, used by `Reply Inbox (IMAP)`. Set the `SINCE` date in its custom search to the cutover day.
3. **Import the v2 files.** In n8n: **Workflows → Import from file**, once for each v2 file. Open every node that shows a credential warning and pick the credential. This includes the Google Sheets, OpenAI, ZeptoMail, SendGrid, Twilio and Gmail credentials, which exports never include.
4. **Add the sheet columns** listed above.
5. **Test v2 beside v1.** v2 uses `-v2` webhook paths. Run the funnel with `VITE_N8N_SALES_FUNNEL_URL=https://n8n.altiereality.com/webhook-test/city-scrape-start-v2` and a small test city.
6. **Switch over.** Don't run v1 and v2 together, or the daily follow-ups and weekly reminders send twice.
   - **Deactivate** v1 Sales Funnel and v1 Follow Up.
   - **Remove `-v2`** from the three webhook paths in v2 so existing callers keep working: the city scrape, the website lead form and ZeptoMail events. Alternatively, keep `-v2` and update the callers, including the ZeptoMail webhook URL.
   - **Activate** both v2 workflows.
7. **Point the webapp at v2.**
   - **Workflow ID:** set `VITE_N8N_SALES_WORKFLOW_ID` (webapp) and `N8N_SALES_WORKFLOW_ID` (functions) to the new v2 workflow ID.
   - **Deploy:** run `npm run build`, then `firebase deploy --only hosting,functions`.

**Rollback:** deactivate the v2 workflows and reactivate the v1 workflows. The sheet columns added for v2 can stay; v1 ignores them.

## Webapp

The **Sales Funnel** page now has:
- **Hot Schools:** a click-intent score (demo 5, pricing 4, WhatsApp 4, website 3, video 2, plus extra clicks and replies, halving every 14 days) with reasons, an intent filter, and links to Messaging and Timeline.
- **Email Template Leaderboard:** sent, opened and unique clicks per template, CTR with a 90% Wilson interval, replies, and the top button.
- **City Funnel:** scraped → emailed → opened → clicked → replied, plus WhatsApp sends and hot leads per city.

The **Lead timeline** shows an Email Engagement card and the classified reply intent.
