# LearnXR sales engine: how it fits together

The engine is four n8n workflows plus the dashboard (Firebase Hosting with one Cloud Function, `api`). The Google
Sheet "school data" is the single list of leads.

```
                    ┌──────────────── Dashboard (agents.altiereality.com) ────────────────┐
                    │ Sales Home · Pipeline · Campaigns · Messaging · Social Ads           │
                    └───────┬───────────────┬──────────────┬───────────────┬───────────────┘
                            │ /api/*  (Cloud Function `api`, Firebase Auth + agentRole)   │
        city run ───────────┘               │ read/write   │ WhatsApp      │ Meta Marketing API
                            ▼               ▼              ▼               ▼
                 Sales • Outbound     Sales • Leads   Twilio ──┐     Instagram/Facebook ads
                 (scrape + emails)    (sheet gateway)          │      lead ads ──┐
                            │               ▲                  ▼                 ▼
                            │               │            Sales • Inbound ◀─ /api/meta/webhook
                            ▼               │   (WhatsApp, website form, ZeptoMail, Meta leads)
                     Google Sheet ◀─────────┘                  │
                            all workflows ── errors / hot leads ──▶ Sales • Alerts ──▶ email
```

## The four workflows

| Workflow | ID | Triggers | What it does |
|---|---|---|---|
| **Sales • Outbound** | `6pBPEDzIfj8939GG` | webhook `city-scrape-start-v3`; schedule Mon–Sat 10:30 IST | **City run:** Places search → filter junk and known schools → read each school's site → AI facts checked word-for-word against the page → fit score → append to the sheet → first email (ZeptoMail, unsubscribe link). **Follow-ups:** due, non-DNC, still-Contacted rows get follow-ups 1–3. Both share the 20/day cold-email cap, and follow-ups take at most 12 of it. |
| **Sales • Inbound** | `bq3CxiN0PNkkPS3H` | webhooks `sales-events`, `learnxr-website-lead`, `zeptomail-events` | **WhatsApp** replies and STOP: rules plus gpt-4o-mini classify → update the lead → alert reps. **Website form** and **Meta lead ads:** add a row at Stage Engaged → "call now" alert. **ZeptoMail:** delivered, opened, clicked and bounced are written onto the row. |
| **Sales • Leads** | `Kr0OoK8tBQsMwdhq` | sub-workflow; webhooks `sheet-leads-read`, `sheet-lead-update` | The only gateway to the sheet. The dashboard reads leads here. Drawer edits and Inbound updates go through "Update Lead", which checks Owner claims (409 on conflict) and never overwrites first-milestone timestamps. |
| **Sales • Alerts** | `X4VKYxULlC9eIwAF` | Error Trigger; webhook `sales-alert` | Emails hot leads and any workflow failure from admin@ to gaurav@. It is the error workflow of every sales flow, which is why it stays separate. |

Every webhook needs the `X-Altie-Key` header (n8n credential "Altie Function Key", Firebase secret
`N8N_WEBHOOK_SECRET`). Only the Cloud Function calls them, except `learnxr-website-lead` (the website form) and
`zeptomail-events` (ZeptoMail).

## A lead's life

1. **Found.** A rep picks a city and board on **Campaigns**. Outbound adds qualified schools at `Stage=New` and emails
   the best ones the same day.
2. **Contacted.** The first email sets `Stage=Contacted` and `Email_sent_at`. Follow-ups go out on following weekdays
   until the lead replies, unsubscribes (`/u/:leadId` → DNC), bounces, or moves past Contacted.
3. **Engaged / Hot.** A WhatsApp reply, a website form, a Meta lead form, or a demo or pricing click marks the lead
   hot and sends an alert. The lead shows at the top of the **Sales Home** Today queue.
4. **Worked.** A rep claims the lead (Owner) and messages it from **Messaging**: free text inside WhatsApp's 24-hour
   window, approved templates outside it. The rep then moves it through Demo → Proposal → Won/Lost in the lead drawer.
   **Pipeline** shows every stage.
5. **Measured.** Sales Home shows the open pipeline, won this month, demos, speed to lead, and cost per demo, using
   Meta ad spend once Social Ads is connected.

## Social Ads (Instagram and Facebook)

- **Page:** `/social`, for superadmin and associate. Only superadmin can pause or resume, edit budgets, or boost.
- **What it shows:** spend, reach, clicks, leads and cost per lead; a campaign and ad-set table; recent Instagram posts
  with **Boost**.
- **How a boost works:**
  1. It creates campaign → ad set (Instagram feed, stories and explore; chosen cities or all of India) → ad from the
     post, with the campaign **paused**.
  2. The page shows Meta's preview.
  3. Spending starts only after **Activate** and a confirm.
- **Budget limit:** daily budgets above `META_MAX_DAILY_BUDGET_INR` (default ₹2,000) are refused. Every change is
  written to the ops audit log.
- **Lead ads:** Meta calls `POST /api/meta/webhook`, which is signature-checked. The function fetches the lead and
  hands it to Inbound in the website form's shape. It becomes a row (XR_keywords contains `instagram_lead_ad` or
  `facebook_lead_ad`) and triggers a "New Meta lead ad" alert.
- **Claude's Meta Ads MCP** is for setup checks, deeper analysis (benchmarks, anomalies, A/B tests) and checking the
  page's numbers. The dashboard itself only uses the Marketing API (Graph `v26.0`).

### One-time Meta setup (owner: you)

1. **Ad account, Page and Instagram** (status 2026-10-03)
   - The dashboard uses the personal ad account `784451571902986` (INR) with the **Altie Reality** Page
     `112468273892432`. This works for Facebook Page ads and for reporting.
   - Instagram **@learn__xr** `17841455631811431` belongs to the altie_reality business (`297072588008378`). A
     business-owned Instagram account can only be connected to ad accounts inside that business, and Meta currently
     blocks altie_reality from creating or adding one ("maximum number of ad accounts for a new business portfolio").
     Until that lifts, boost @learn__xr posts in the Instagram app or in Ads Manager by hand.
   - When the limit lifts (a check is scheduled for 2026-10-17):
     - create an INR ad account inside altie_reality;
     - use **Connect assets** to add the Altie Reality Page and @learn__xr;
     - add the account under Integrations → **ads MCP server**;
     - set `META_AD_ACCOUNT_ID` to the new account's ID and switch to a system-user token.
2. **developers.facebook.com → Create app (Business)**
   - Add **Marketing API** and **Webhooks**. Note the **App secret**.
3. **Token.** On the personal ad account, use a long-lived **user** token from Graph API Explorer (about 60 days, then renew). After moving to a business ad account, use **Business Settings → System users → Add** (Admin) instead:
   - Assign the ad account (Manage campaigns), the Page and the Instagram account. A personal ad account can only be assigned to a system user once it has been added to the business; if that isn't possible, generate a long-lived **user** token from the app instead.
   - **Generate token** for the app with these scopes, set never to expire: `ads_management`, `ads_read`,
     `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `leads_retrieval`,
     `instagram_basic`.
4. **Set the function secrets.** Before the next functions deploy, all three must exist. Use `unset` for any you don't
   have yet.
   ```bash
   firebase functions:secrets:set META_SYSTEM_TOKEN --project lexrn1
   ```
   ```bash
   firebase functions:secrets:set META_APP_SECRET --project lexrn1
   ```
   ```bash
   firebase functions:secrets:set META_VERIFY_TOKEN --project lexrn1
   ```
   These defaults are already in the code; override them in `functions/.env` only if needed: `META_AD_ACCOUNT_ID`, `META_PAGE_ID`, `META_MAX_DAILY_BUDGET_INR` and
   `META_BOOST_LINK`.
5. **Lead ads**
   - Accept the Lead Gen terms for the Page (facebook.com/legal/leadgen/tos).
   - Create an Instant Form with full name, school name, city, phone, email and job title.
   - App → Webhooks → **Page** → callback `https://agents.altiereality.com/api/meta/webhook`, verify token =
     `META_VERIFY_TOKEN` → subscribe to `leadgen`.
   - Subscribe the Page to the app: `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen` with the Page token.
     Claude can do this for you.
6. **Deploy:** `firebase deploy --only functions,hosting --project lexrn1`. Then send a test lead with Meta's Lead Ads
   Testing Tool and check that the row and the alert arrive.

## Dashboard pages (2026-10-03)

| Page | For | What it does |
|---|---|---|
| Sales Home `/sales` | sales | Today queue and KPIs. Source chips (Instagram ad, Facebook ad, website, WhatsApp, cold email) narrow everything. The **Channels** table shows leads → engaged → demos → won and cost per lead, demo and deal for each source. |
| Pipeline `/pipeline` | sales | Every school by stage, with a source filter and source badges. |
| School `/schools/:orgKey` | sales | Every contact at a school and one timeline: city run or form, emails, opens, clicks, replies, WhatsApp both ways, notes, stage changes, demo, proposal, won/lost, unsubscribe. The lead drawer links to it. |
| Social Ads `/social` | superadmin, associate | Meta ad numbers, live or as the daily snapshot Claude pulls through the Meta Ads MCP. |
| Admin `/admin` | superadmin | Health of the 4 workflows (manual editor runs don't count), cold emails today vs. the cap, WhatsApp failures, approved templates, Meta mode. **Settings:** monthly target, monthly cost per channel, email cap and follow-up share, test/live for auto-replies and the WhatsApp welcome, Meta budget ceiling, alert recipients. |

**How Settings reach n8n.** Settings are stored in Firestore `settings/app`, and n8n reads them from
`GET /api/internal/settings` (X-Altie-Key):
- Outbound `Load Settings` and `Load Settings (follow-ups)` set the caps;
- Inbound `Load Settings` sets the auto-reply mode;
- Alerts `Load Recipients` sets who gets alerts.

Every one falls back to the old built-in values if the call fails.

**Lead source.** The sheet columns `Lead_source`, `Lead_campaign`, `Lead_form` and `Leadgen_id` are written by:
- Outbound, which sets `cold_email`;
- the Inbound form path, which sets `website`, `instagram_ad` or `facebook_ad`.

A form lead with an email or phone we already have updates that school's row (Engaged, hot, next step) instead of
adding a new row. The same Meta lead seen twice is skipped.
