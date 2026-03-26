/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { setGlobalOptions } from "firebase-functions";
import { onRequest } from "firebase-functions/https";
import * as logger from "firebase-functions/logger";
import cors from "cors";
import express from "express";
import { defineSecret, defineString } from "firebase-functions/params";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
setGlobalOptions({ maxInstances: 10 });

type N8nProxyConfig = {
  apiUrl?: string;
  apiKey?: string;
};

const n8nApiUrlSecret = defineSecret("N8N_API_URL_SECRET");
const n8nApiKeySecret = defineSecret("N8N_API_KEY_SECRET");

const twilioAccountSidSecret = defineSecret("TWILIO_ACCOUNT_SID");
const twilioAuthTokenSecret = defineSecret("TWILIO_AUTH_TOKEN");
/** Optional outbound defaults (set in `.env` for emulators or with `firebase functions:config:export` / Cloud console). */
const twilioMessagingServiceSidParam = defineString("TWILIO_MESSAGING_SERVICE_SID", { default: "" });
const twilioWhatsappFromParam = defineString("TWILIO_WHATSAPP_FROM", { default: "" });

function getN8nConfig(): N8nProxyConfig {
  return {
    apiUrl: n8nApiUrlSecret.value(),
    apiKey: n8nApiKeySecret.value(),
  };
}

function twilioBasicAuthHeader(accountSid: string, authToken: string): string {
  const token = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  return `Basic ${token}`;
}

function twilioPageTokenFromNextUri(nextUri: string | undefined): string | null {
  if (!nextUri || typeof nextUri !== "string") return null;
  const q = nextUri.includes("?") ? nextUri.split("?")[1]! : "";
  return new URLSearchParams(q).get("PageToken");
}

function getTwilioConfig():
  | { ok: true; accountSid: string; authToken: string; messagingServiceSid: string; whatsappFrom: string }
  | { ok: false } {
  const accountSid = twilioAccountSidSecret.value();
  const authToken = twilioAuthTokenSecret.value();
  if (!accountSid || !authToken) {
    return { ok: false };
  }
  return {
    ok: true,
    accountSid,
    authToken,
    messagingServiceSid: twilioMessagingServiceSidParam.value(),
    whatsappFrom: twilioWhatsappFromParam.value(),
  };
}

const app = express();
app.use(cors({ origin: true }));
app.options(/.*/, cors({ origin: true }));
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Explicitly handle CORS preflight for the proxy endpoints.
app.options("/api/n8n/executions", cors({ origin: true }));
app.options("/api/n8n/executions/:id", cors({ origin: true }));

app.get("/api/n8n/executions", async (req, res) => {
  const { apiUrl, apiKey } = getN8nConfig();
  if (!apiUrl || !apiKey) {
    return res.status(500).json({ message: "n8n proxy not configured (missing api url/key)." });
  }

  const takeRaw = typeof req.query.limit === "string" ? req.query.limit : typeof req.query.take === "string" ? req.query.take : "10";
  const takeNum = Number.parseInt(takeRaw, 10);
  const take = Number.isFinite(takeNum) ? Math.min(Math.max(takeNum, 1), 100) : 10;

  const workflowId =
    typeof req.query.workflowId === "string"
      ? req.query.workflowId
      : typeof req.query.workflow === "string"
      ? req.query.workflow
      : undefined;

  const base = apiUrl.replace(/\/$/, "");
  const workflowParam = workflowId ? `&workflowId=${encodeURIComponent(workflowId)}` : "";
  const url = `${base}/api/v1/executions?limit=${encodeURIComponent(take)}${workflowParam}`;

  try {
    const upstream = await fetch(url, {
      headers: { "X-N8N-API-KEY": apiKey },
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");

    // Try to pass through JSON
    try {
      return res.send(JSON.stringify(JSON.parse(text)));
    } catch {
      return res.send(text);
    }
  } catch (err) {
    logger.error("n8n executions proxy failed", err);
    return res.status(502).json({ message: "Failed to fetch executions from n8n." });
  }
});

app.get("/api/n8n/executions/:id", async (req, res) => {
  const { apiUrl, apiKey } = getN8nConfig();
  if (!apiUrl || !apiKey) {
    return res.status(500).json({ message: "n8n proxy not configured (missing api url/key)." });
  }

  const id = req.params.id;
  const base = apiUrl.replace(/\/$/, "");
  const url = `${base}/api/v1/executions/${encodeURIComponent(id)}?includeData=true`;

  try {
    const upstream = await fetch(url, {
      headers: { "X-N8N-API-KEY": apiKey },
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
    try {
      return res.send(JSON.stringify(JSON.parse(text)));
    } catch {
      return res.send(text);
    }
  } catch (err) {
    logger.error("n8n execution detail proxy failed", err);
    return res.status(502).json({ message: "Failed to fetch execution detail from n8n." });
  }
});

// ── Twilio Programmable Messaging (Hosting + preview channels: `/api/twilio/**` → this function)

app.options("/api/twilio/messages", cors({ origin: true }));
app.options("/api/twilio/messages/:sid", cors({ origin: true }));

app.get("/api/twilio/health", (_req, res) => {
  const t = getTwilioConfig();
  if (!t.ok) {
    return res.json({
      ok: false,
      accountHint: null,
      source: "firebase-functions",
    });
  }
  const hint =
    t.accountSid.length > 6 ? `${t.accountSid.slice(0, 2)}…${t.accountSid.slice(-4)}` : t.accountSid;
  return res.json({ ok: true, accountHint: hint, source: "firebase-functions" });
});

app.get("/api/twilio/messages", async (req, res) => {
  const t = getTwilioConfig();
  if (!t.ok) {
    return res.status(503).json({
      message:
        "Twilio is not configured. Set secrets TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN for the api function.",
    });
  }

  const pageSizeRaw = Number.parseInt(String(req.query.pageSize || "35"), 10);
  const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(100, Math.max(1, pageSizeRaw)) : 35;
  const pageToken = typeof req.query.pageToken === "string" ? req.query.pageToken : "";
  const dateSentAfter = typeof req.query.dateSentAfter === "string" ? req.query.dateSentAfter : "";

  const url = new URL(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(t.accountSid)}/Messages.json`
  );
  url.searchParams.set("PageSize", String(pageSize));
  if (pageToken) url.searchParams.set("PageToken", pageToken);
  if (dateSentAfter) url.searchParams.set("DateSent>", dateSentAfter);

  const auth = twilioBasicAuthHeader(t.accountSid, t.authToken);

  try {
    const apiRes = await fetch(url.toString(), { headers: { Authorization: auth } });
    const text = await apiRes.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return res.status(502).json({ message: "Unexpected Twilio response", raw: text.slice(0, 500) });
    }
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({
        message: (data.message as string) || (data.more_info as string) || "Twilio list messages failed",
        code: data.code,
      });
    }
    const nextPageToken = twilioPageTokenFromNextUri(data.next_page_uri as string | undefined);
    const messages = Array.isArray(data.messages) ? data.messages : [];
    return res.json({ messages, nextPageToken });
  } catch (err) {
    logger.error("Twilio list messages error", err);
    return res.status(502).json({ message: "Failed to reach Twilio API." });
  }
});

app.get("/api/twilio/messages/:sid", async (req, res) => {
  const t = getTwilioConfig();
  if (!t.ok) {
    return res.status(503).json({ message: "Twilio is not configured on this function." });
  }

  const { sid } = req.params;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    t.accountSid
  )}/Messages/${encodeURIComponent(sid)}.json`;
  const auth = twilioBasicAuthHeader(t.accountSid, t.authToken);

  try {
    const apiRes = await fetch(url, { headers: { Authorization: auth } });
    const text = await apiRes.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return res.status(502).json({ message: "Unexpected Twilio response", raw: text.slice(0, 500) });
    }
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({
        message: (data.message as string) || (data.more_info as string) || "Twilio fetch message failed",
        code: data.code,
      });
    }
    return res.json(data);
  } catch (err) {
    logger.error("Twilio get message error", err);
    return res.status(502).json({ message: "Failed to reach Twilio API." });
  }
});

app.post("/api/twilio/messages", async (req, res) => {
  const t = getTwilioConfig();
  if (!t.ok) {
    return res.status(503).json({ message: "Twilio is not configured on this function." });
  }

  const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
  const bodyText = typeof req.body?.body === "string" ? req.body.body : "";
  const mediaUrl = typeof req.body?.mediaUrl === "string" ? req.body.mediaUrl.trim() : "";
  let from =
    typeof req.body?.from === "string" && req.body.from.trim() ? req.body.from.trim() : "";
  let messagingServiceSid =
    typeof req.body?.messagingServiceSid === "string" && req.body.messagingServiceSid.trim()
      ? req.body.messagingServiceSid.trim()
      : "";

  if (!messagingServiceSid) messagingServiceSid = t.messagingServiceSid || "";
  if (!from) from = t.whatsappFrom || "";

  const hasBody = Boolean(String(bodyText || "").trim());
  const hasMedia = Boolean(mediaUrl);

  if (!to || (!hasBody && !hasMedia)) {
    return res.status(400).json({
      message: `Missing required fields (Twilio send): toPresent=${Boolean(to)} hasBody=${hasBody} hasMedia=${hasMedia}`,
    });
  }
  if (!messagingServiceSid && !from) {
    return res.status(400).json({
      message:
        "Provide `from` or `messagingServiceSid`, or set TWILIO_MESSAGING_SERVICE_SID / TWILIO_WHATSAPP_FROM on the api function.",
    });
  }

  const params = new URLSearchParams();
  params.set("To", to);
  // Twilio media sends are more reliable when Body is present (even a single space),
  // especially for WhatsApp/doc-style messages.
  if (hasBody) params.set("Body", bodyText);
  else if (hasMedia) params.set("Body", " ");
  if (messagingServiceSid) params.set("MessagingServiceSid", messagingServiceSid);
  else params.set("From", from);
  if (hasMedia) params.set("MediaUrl", mediaUrl);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    t.accountSid
  )}/Messages.json`;
  const auth = twilioBasicAuthHeader(t.accountSid, t.authToken);

  try {
    const apiRes = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const text = await apiRes.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return res.status(502).json({ message: "Unexpected Twilio response", raw: text.slice(0, 500) });
    }
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({
        message: (data.message as string) || (data.more_info as string) || "Twilio send failed",
        code: data.code,
        raw: data,
      });
    }
    return res.status(201).json(data);
  } catch (err) {
    logger.error("Twilio send message error", err);
    return res.status(502).json({ message: "Failed to reach Twilio API." });
  }
});

// Fallback: some hosting rewrites can change the effective path prefix.
// If the URL contains /n8n/executions, proxy it regardless of the exact Express route match.
app.get(/.*/, async (req, res) => {
  const originalUrl = req.originalUrl || req.url || '';
  // Let unknown /api/twilio/* fall through to 404
  if (originalUrl.includes("/api/twilio")) {
    return res.status(404).send(`Cannot GET ${req.path}`);
  }
  // Match both:
  // - /api/n8n/executions
  // - /api/n8n/executions/:id
  // (and any potential rewrite variants where /api prefix may differ)
  const m = originalUrl.match(/n8n\/executions(?:\/([^/?#]+))?/);
  if (!m) {
    return res.status(404).send(`Cannot GET ${req.path}`);
  }

  const { apiUrl, apiKey } = getN8nConfig();
  if (!apiUrl || !apiKey) {
    return res.status(500).json({ message: "n8n proxy not configured (missing api url/key)." });
  }

  const base = apiUrl.replace(/\/$/, "");
  const id = m[2];

  try {
    if (!id) {
      const takeRaw =
        typeof req.query.limit === "string"
          ? req.query.limit
          : typeof req.query.take === "string"
          ? req.query.take
          : "10";
      const takeNum = Number.parseInt(takeRaw, 10);
      const take = Number.isFinite(takeNum) ? Math.min(Math.max(takeNum, 1), 100) : 10;

      const workflowId =
        typeof req.query.workflowId === "string"
          ? req.query.workflowId
          : typeof req.query.workflow === "string"
          ? req.query.workflow
          : undefined;
      const workflowParam = workflowId ? `&workflowId=${encodeURIComponent(workflowId)}` : "";

      const url = `${base}/api/v1/executions?limit=${encodeURIComponent(take)}${workflowParam}`;
      const upstream = await fetch(url, { headers: { "X-N8N-API-KEY": apiKey } });
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
      try {
        return res.send(JSON.stringify(JSON.parse(text)));
      } catch {
        return res.send(text);
      }
    }

    const executionId = decodeURIComponent(id);
    const url = `${base}/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`;
    const upstream = await fetch(url, { headers: { "X-N8N-API-KEY": apiKey } });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
    try {
      return res.send(JSON.stringify(JSON.parse(text)));
    } catch {
      return res.send(text);
    }
  } catch (err) {
    logger.error("n8n proxy fallback failed", err);
    return res.status(502).json({ message: "Failed to proxy request to n8n." });
  }
});

export const api = onRequest(
  {
    secrets: [
      n8nApiUrlSecret,
      n8nApiKeySecret,
      twilioAccountSidSecret,
      twilioAuthTokenSecret,
    ],
  },
  app
);
