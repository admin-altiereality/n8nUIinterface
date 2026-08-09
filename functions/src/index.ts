/**
 * LearnXR agents API — n8n + Twilio proxies with Firebase Auth.
 */
// @ts-nocheck — Express 5 handler return typings conflict with firebase-functions overlays.

import { setGlobalOptions } from "firebase-functions/v2/options";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import cors from "cors";
import express from "express";
import { defineSecret } from "firebase-functions/params";
import { createHmac, timingSafeEqual } from "crypto";

setGlobalOptions({ maxInstances: 10 });

type N8nProxyConfig = {
  apiUrl?: string;
  apiKey?: string;
};

type AuthedUser = {
  uid: string;
  email?: string;
  role: string;
};

const n8nApiUrlSecret = defineSecret("N8N_API_URL_SECRET");
const n8nApiKeySecret = defineSecret("N8N_API_KEY_SECRET");

const twilioAccountSidSecret = defineSecret("TWILIO_ACCOUNT_SID");
const twilioAuthTokenSecret = defineSecret("TWILIO_AUTH_TOKEN");
const twilioMessagingServiceSidSecret = defineSecret("TWILIO_MESSAGING_SERVICE_SID_SECRET");
const twilioWhatsappFromSecret = defineSecret("TWILIO_WHATSAPP_FROM_SECRET");

const AUTH_FIREBASE_PROJECT_ID =
  process.env.AUTH_FIREBASE_PROJECT_ID || "learnxr-evoneuralai";

/** Roles allowed to use this agents platform at all (data-token + APIs). */
const AGENT_ROLES = new Set([
  "superadmin",
  "associate",
  "builder",
  "salesperson",
  "whatsapp_manager",
]);

const TWILIO_ROLES = new Set(["superadmin", "associate", "whatsapp_manager"]);
const N8N_ROLES = new Set(["superadmin", "associate", "builder"]);
/** Sales Funnel execution polling + Sheets leads (scoped away from full builder n8n access). */
const SALES_N8N_ROLES = new Set(["superadmin", "associate", "salesperson"]);
const SHEETS_ROLES = new Set(["superadmin", "associate", "salesperson"]);

const SALES_FUNNEL_WORKFLOW_ID =
  process.env.N8N_SALES_WORKFLOW_ID || "sLk0CAalsSlR5z4P";
const SHEETS_LEADS_WEBHOOK_URL =
  process.env.N8N_SHEETS_LEADS_WEBHOOK_URL ||
  "https://n8n.altiereality.com/webhook/sheet-leads-read";

const TWILIO_STATUS_COLLECTION = "twilioMessageStatus";
const TWILIO_STATUS_RANK: Record<string, number> = {
  queued: 0,
  accepted: 1,
  scheduled: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  undelivered: 100,
  failed: 100,
  canceled: 100,
};

const CORS_ALLOWED_ORIGINS = new Set([
  "https://agents.altiereality.com",
  "https://agents-altiereality-com.web.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin / non-browser
  if (CORS_ALLOWED_ORIGINS.has(origin)) return true;
  // Firebase Hosting preview channels for this site
  if (/^https:\/\/agents-altiereality-com--[\w-]+\.web\.app$/.test(origin)) return true;
  return false;
}

function adminAppModule() {
  return require("firebase-admin/app");
}

function adminAuthModule() {
  return require("firebase-admin/auth");
}

function adminFirestoreModule() {
  return require("firebase-admin/firestore");
}

function ensureAdminDefaultApp() {
  const { getApps, initializeApp } = adminAppModule();
  if (!getApps().length) {
    initializeApp();
  }
}

function getAuthProjectApp() {
  ensureAdminDefaultApp();
  const { getApps, initializeApp } = adminAppModule();
  const name = "auth-verifier";
  const existing = getApps().find((a) => a.name === name);
  return existing || initializeApp({ projectId: AUTH_FIREBASE_PROJECT_ID }, name);
}

function getAuthProjectVerifier() {
  const { getAuth: getAdminAuth } = adminAuthModule();
  return getAdminAuth(getAuthProjectApp());
}

function getAuthProjectDb() {
  const { getFirestore } = adminFirestoreModule();
  return getFirestore(getAuthProjectApp());
}

function getDataProjectAuth() {
  ensureAdminDefaultApp();
  const { getAuth: getAdminAuth } = adminAuthModule();
  return getAdminAuth();
}

function getDataProjectDb() {
  ensureAdminDefaultApp();
  const { getFirestore } = adminFirestoreModule();
  return getFirestore();
}

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
    messagingServiceSid: twilioMessagingServiceSidSecret.value(),
    whatsappFrom: twilioWhatsappFromSecret.value(),
  };
}

async function resolveRole(
  uid: string,
  decoded: Record<string, unknown>,
  idToken?: string
): Promise<string | null> {
  const claimRole = decoded.role || decoded.userRole;
  if (typeof claimRole === "string" && claimRole.trim()) return claimRole.trim();

  // Prefer local (lexrn1) mirror written during data-token exchange
  try {
    const local = await getDataProjectDb().collection("users").doc(uid).get();
    if (local.exists) {
      const d = local.data() || {};
      const r = d.role || d.userRole;
      if (typeof r === "string" && r.trim()) return r.trim();
    }
  } catch (err) {
    logger.warn("lexrn1 role lookup failed", err);
  }

  // Auth project via Admin SDK (needs SA access on learnxr-evoneuralai)
  try {
    const remote = await getAuthProjectDb().collection("users").doc(uid).get();
    if (remote.exists) {
      const d = remote.data() || {};
      const r = d.role || d.userRole;
      if (typeof r === "string" && r.trim()) return r.trim();
    }
  } catch (err) {
    logger.warn("auth-project admin role lookup failed", err);
  }

  // Fallback: read users/{uid} as the end-user (their token already allows own-doc read)
  if (idToken) {
    try {
      const url =
        `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(AUTH_FIREBASE_PROJECT_ID)}` +
        `/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
      if (resp.ok) {
        const doc = (await resp.json()) as {
          fields?: { role?: { stringValue?: string }; userRole?: { stringValue?: string } };
        };
        const r = doc.fields?.role?.stringValue || doc.fields?.userRole?.stringValue;
        if (typeof r === "string" && r.trim()) return r.trim();
      }
    } catch (err) {
      logger.warn("auth-project user-token role lookup failed", err);
    }
  }

  return null;
}

async function authenticateRequest(req: express.Request): Promise<AuthedUser | { error: string; status: number }> {
  const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) {
    return { error: "Missing Authorization Bearer token.", status: 401 };
  }

  const idToken = match[1];
  try {
    const decoded = await getAuthProjectVerifier().verifyIdToken(idToken);
    if (!decoded.uid) {
      return { error: "Invalid ID token.", status: 401 };
    }
    const role = await resolveRole(decoded.uid, decoded as unknown as Record<string, unknown>, idToken);
    if (!role || !AGENT_ROLES.has(role)) {
      return { error: "Forbidden: agent role required.", status: 403 };
    }
    return {
      uid: decoded.uid,
      email: typeof decoded.email === "string" ? decoded.email : undefined,
      role,
    };
  } catch (err) {
    logger.warn("authenticateRequest failed", err);
    return { error: "Unauthorized.", status: 401 };
  }
}

function requireRoles(allowed: Set<string>) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const auth = await authenticateRequest(req);
    if ("error" in auth) {
      return res.status(auth.status).json({ message: auth.error });
    }
    if (!allowed.has(auth.role)) {
      return res.status(403).json({ message: "Forbidden: insufficient role." });
    }
    (req as express.Request & { authedUser?: AuthedUser }).authedUser = auth;
    return next();
  };
}

function isAllowedMediaUrl(mediaUrl: string): boolean {
  try {
    const u = new URL(mediaUrl);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return (
      host === "firebasestorage.googleapis.com" ||
      host.endsWith(".firebasestorage.app") ||
      host === "storage.googleapis.com"
    );
  } catch {
    return false;
  }
}

function isValidWhatsAppRecipient(to: string): boolean {
  // whatsapp:+E164 or +E164
  return /^(whatsapp:)?\+[1-9]\d{7,14}$/i.test(to.trim());
}

function isValidTwilioMessageSid(sid: string): boolean {
  return /^SM[a-f0-9]{32}$/i.test(sid) || /^MM[a-f0-9]{32}$/i.test(sid);
}

function getPublicApiBase(req: express.Request): string {
  const proto = (req.get("x-forwarded-proto") || "https").split(",")[0]!.trim();
  const host = (req.get("x-forwarded-host") || req.get("host") || "agents.altiereality.com")
    .split(",")[0]!
    .trim();
  return `${proto}://${host}`;
}

function validateTwilioRequestSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: Record<string, string>
): boolean {
  if (!signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function shouldAdvanceTwilioStatus(prev: string | undefined, next: string): boolean {
  const n = String(next || "").toLowerCase();
  if (!n) return false;
  if (n === "failed" || n === "undelivered" || n === "canceled") return true;
  const prevRank = TWILIO_STATUS_RANK[String(prev || "").toLowerCase()] ?? -1;
  const nextRank = TWILIO_STATUS_RANK[n] ?? -1;
  return nextRank >= prevRank;
}

async function upsertTwilioMessageStatus(input: {
  sid: string;
  to?: string;
  from?: string;
  status: string;
  errorCode?: string | number | null;
  errorMessage?: string | null;
}): Promise<void> {
  const ref = getDataProjectDb().collection(TWILIO_STATUS_COLLECTION).doc(input.sid);
  const snap = await ref.get();
  const prev = snap.exists ? (snap.data() as Record<string, unknown>) : null;
  const prevStatus = prev && typeof prev.status === "string" ? prev.status : undefined;
  if (prev && !shouldAdvanceTwilioStatus(prevStatus, input.status)) {
    return;
  }
  const now = new Date().toISOString();
  const { FieldValue } = adminFirestoreModule();
  const historyEntry = {
    status: String(input.status).toLowerCase(),
    at: now,
    errorCode: input.errorCode ?? null,
  };
  await ref.set(
    {
      sid: input.sid,
      to: input.to ?? prev?.to ?? null,
      from: input.from ?? prev?.from ?? null,
      status: String(input.status).toLowerCase(),
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      updatedAt: now,
      statusHistory: FieldValue.arrayUnion(historyEntry),
    },
    { merge: true }
  );
}

const app = express();
app.use(
  cors({
    origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
  })
);
app.options(/.*/, cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * Bridge: Auth-project ID token → lexrn1 custom token (same uid), role-gated.
 */
app.options("/api/auth/data-token", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.post("/api/auth/data-token", async (req, res) => {
  const auth = await authenticateRequest(req);
  if ("error" in auth) {
    return res.status(auth.status).json({ message: auth.error });
  }

  try {
    // Mirror role onto lexrn1 for Storage/API role checks without cross-project reads later
    await getDataProjectDb()
      .collection("users")
      .doc(auth.uid)
      .set(
        {
          role: auth.role,
          email: auth.email || null,
          authProjectId: AUTH_FIREBASE_PROJECT_ID,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

    const customToken = await getDataProjectAuth().createCustomToken(auth.uid, {
      authProjectId: AUTH_FIREBASE_PROJECT_ID,
      role: auth.role,
    });
    return res.json({ customToken, uid: auth.uid, role: auth.role });
  } catch (err) {
    logger.error("data-token exchange failed", err);
    return res.status(401).json({ message: "Failed to exchange auth token." });
  }
});

app.options("/api/n8n/executions", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/n8n/executions/:id", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));

app.get("/api/n8n/executions", requireRoles(N8N_ROLES), async (req, res) => {
  const { apiUrl, apiKey } = getN8nConfig();
  if (!apiUrl || !apiKey) {
    return res.status(500).json({ message: "n8n proxy not configured (missing api url/key)." });
  }

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

app.get("/api/n8n/executions/:id", requireRoles(N8N_ROLES), async (req, res) => {
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

app.options("/api/n8n/sales-executions", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/n8n/sales-executions/:id", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));

app.get("/api/n8n/sales-executions", requireRoles(SALES_N8N_ROLES), async (req, res) => {
  const { apiUrl, apiKey } = getN8nConfig();
  if (!apiUrl || !apiKey) {
    return res.status(500).json({ message: "n8n proxy not configured (missing api url/key)." });
  }

  const takeRaw =
    typeof req.query.limit === "string"
      ? req.query.limit
      : typeof req.query.take === "string"
        ? req.query.take
        : "10";
  const takeNum = Number.parseInt(takeRaw, 10);
  const take = Number.isFinite(takeNum) ? Math.min(Math.max(takeNum, 1), 50) : 10;
  const workflowId =
    typeof req.query.workflowId === "string" && req.query.workflowId.trim()
      ? req.query.workflowId.trim()
      : SALES_FUNNEL_WORKFLOW_ID;

  const base = apiUrl.replace(/\/$/, "");
  const url = `${base}/api/v1/executions?limit=${encodeURIComponent(take)}&workflowId=${encodeURIComponent(workflowId)}`;

  try {
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
    logger.error("n8n sales executions proxy failed", err);
    return res.status(502).json({ message: "Failed to fetch sales executions from n8n." });
  }
});

app.get("/api/n8n/sales-executions/:id", requireRoles(SALES_N8N_ROLES), async (req, res) => {
  const { apiUrl, apiKey } = getN8nConfig();
  if (!apiUrl || !apiKey) {
    return res.status(500).json({ message: "n8n proxy not configured (missing api url/key)." });
  }

  const id = req.params.id;
  const base = apiUrl.replace(/\/$/, "");
  const url = `${base}/api/v1/executions/${encodeURIComponent(id)}?includeData=true`;

  try {
    const upstream = await fetch(url, { headers: { "X-N8N-API-KEY": apiKey } });
    const text = await upstream.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      res.status(upstream.status);
      res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
      return res.send(text);
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json(data);
    }
    const workflowData = data.workflowData as { id?: string } | undefined;
    const wfId =
      (typeof data.workflowId === "string" && data.workflowId) ||
      (workflowData && typeof workflowData.id === "string" ? workflowData.id : null);
    if (wfId && wfId !== SALES_FUNNEL_WORKFLOW_ID) {
      return res.status(403).json({ message: "Forbidden: execution is not a sales funnel run." });
    }
    return res.status(upstream.status).json(data);
  } catch (err) {
    logger.error("n8n sales execution detail proxy failed", err);
    return res.status(502).json({ message: "Failed to fetch sales execution detail from n8n." });
  }
});

app.options("/api/sheets/leads", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));

app.get("/api/sheets/leads", requireRoles(SHEETS_ROLES), async (req, res) => {
  const webhookUrl = SHEETS_LEADS_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.status(503).json({ message: "Sheets leads webhook is not configured." });
  }

  const url = new URL(webhookUrl);
  for (const key of ["city", "status", "leadStatus", "whatsappStatus", "q", "limit"] as const) {
    const val = req.query[key];
    if (typeof val === "string" && val.trim()) url.searchParams.set(key, val.trim());
  }

  try {
    const upstream = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const text = await upstream.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        message: "Unexpected sheets webhook response",
        raw: text.slice(0, 500),
      });
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json(
        typeof data === "object" && data
          ? data
          : { message: "Sheets leads fetch failed" }
      );
    }

    // Normalize: webhook may return { rows }, { data }, or a bare array
    let rows: unknown[] = [];
    if (Array.isArray(data)) rows = data;
    else if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.rows)) rows = obj.rows;
      else if (Array.isArray(obj.data)) rows = obj.data;
      else if (Array.isArray(obj.leads)) rows = obj.leads;
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    const city = typeof req.query.city === "string" ? req.query.city.trim().toLowerCase() : "";
    const status = typeof req.query.status === "string" ? req.query.status.trim().toLowerCase() : "";
    const leadStatus =
      typeof req.query.leadStatus === "string" ? req.query.leadStatus.trim().toLowerCase() : "";
    const whatsappStatus =
      typeof req.query.whatsappStatus === "string"
        ? req.query.whatsappStatus.trim().toLowerCase()
        : "";

    const filtered = rows.filter((row) => {
      if (!row || typeof row !== "object") return false;
      const r = row as Record<string, unknown>;
      const get = (k: string) => String(r[k] ?? "").toLowerCase();
      if (city && !get("City").includes(city)) return false;
      if (status && get("Status") !== status) return false;
      if (leadStatus && get("Lead_status") !== leadStatus) return false;
      if (whatsappStatus && get("Whatsapp_status") !== whatsappStatus) return false;
      if (q) {
        const hay = [
          get("School Name"),
          get("Email ID"),
          get("City"),
          get("Phone number"),
          get("Lead_status"),
          get("Whatsapp_status"),
        ].join(" ");
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const limitRaw = Number.parseInt(String(req.query.limit || "500"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 500;

    return res.json({
      ok: true,
      fetchedAt: new Date().toISOString(),
      total: filtered.length,
      rows: filtered.slice(0, limit),
    });
  } catch (err) {
    logger.error("sheets leads proxy failed", err);
    return res.status(502).json({ message: "Failed to fetch leads from sheets webhook." });
  }
});

app.options("/api/twilio/messages", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/twilio/messages/:sid", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/twilio/messages/:sid/status", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/twilio/statuses", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/twilio/status", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));

app.get("/api/twilio/health", requireRoles(TWILIO_ROLES), (_req, res) => {
  const t = getTwilioConfig();
  return res.json({
    ok: t.ok,
    source: "firebase-functions",
  });
});

app.get("/api/twilio/messages", requireRoles(TWILIO_ROLES), async (req, res) => {
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

app.get("/api/twilio/messages/:sid", requireRoles(TWILIO_ROLES), async (req, res) => {
  const t = getTwilioConfig();
  if (!t.ok) {
    return res.status(503).json({ message: "Twilio is not configured on this function." });
  }

  const { sid } = req.params;
  if (!isValidTwilioMessageSid(sid)) {
    return res.status(400).json({ message: "Invalid message SID." });
  }

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

app.get("/api/twilio/messages/:sid/status", requireRoles(TWILIO_ROLES), async (req, res) => {
  const { sid } = req.params;
  if (!isValidTwilioMessageSid(sid)) {
    return res.status(400).json({ message: "Invalid message SID." });
  }

  try {
    const snap = await getDataProjectDb().collection(TWILIO_STATUS_COLLECTION).doc(sid).get();
    if (snap.exists) {
      return res.json(snap.data());
    }

    // Fallback: live Twilio fetch + seed Firestore
    const t = getTwilioConfig();
    if (!t.ok) {
      return res.status(404).json({ message: "Status not found." });
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      t.accountSid
    )}/Messages/${encodeURIComponent(sid)}.json`;
    const auth = twilioBasicAuthHeader(t.accountSid, t.authToken);
    const apiRes = await fetch(url, { headers: { Authorization: auth } });
    const data = (await apiRes.json().catch(() => ({}))) as Record<string, unknown>;
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({
        message: (data.message as string) || "Twilio fetch message failed",
        code: data.code,
      });
    }
    const status = String(data.status || "unknown");
    await upsertTwilioMessageStatus({
      sid,
      to: typeof data.to === "string" ? data.to : undefined,
      from: typeof data.from === "string" ? data.from : undefined,
      status,
      errorCode: (data.error_code as string | number | null) ?? null,
      errorMessage: (data.error_message as string | null) ?? null,
    });
    const seeded = await getDataProjectDb().collection(TWILIO_STATUS_COLLECTION).doc(sid).get();
    return res.json(seeded.data() || { sid, status });
  } catch (err) {
    logger.error("Twilio status get error", err);
    return res.status(502).json({ message: "Failed to load message status." });
  }
});

app.get("/api/twilio/statuses", requireRoles(TWILIO_ROLES), async (req, res) => {
  const raw = typeof req.query.sids === "string" ? req.query.sids : "";
  const sids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(isValidTwilioMessageSid)
    .slice(0, 50);
  if (!sids.length) {
    return res.json({ statuses: {} });
  }

  try {
    const db = getDataProjectDb();
    const entries = await Promise.all(
      sids.map(async (sid) => {
        const snap = await db.collection(TWILIO_STATUS_COLLECTION).doc(sid).get();
        return [sid, snap.exists ? snap.data() : null] as const;
      })
    );
    const statuses: Record<string, unknown> = {};
    for (const [sid, data] of entries) {
      if (data) statuses[sid] = data;
    }
    return res.json({ statuses });
  } catch (err) {
    logger.error("Twilio batch status error", err);
    return res.status(502).json({ message: "Failed to load message statuses." });
  }
});

/** Twilio StatusCallback — form-urlencoded, signature-validated. */
app.post("/api/twilio/status", async (req, res) => {
  const t = getTwilioConfig();
  if (!t.ok) {
    return res.status(503).send("Twilio not configured");
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v == null) continue;
    params[k] = String(v);
  }

  const signature = req.get("x-twilio-signature") || undefined;
  const callbackUrl = `${getPublicApiBase(req)}/api/twilio/status`;
  if (!validateTwilioRequestSignature(t.authToken, signature, callbackUrl, params)) {
    // Fallback: some Hosting setups strip/alter the public URL — try without query
    logger.warn("Twilio status signature mismatch", { callbackUrl });
    return res.status(403).send("Invalid signature");
  }

  const sid = params.MessageSid || params.SmsSid || "";
  if (!isValidTwilioMessageSid(sid)) {
    return res.status(400).send("Invalid MessageSid");
  }

  try {
    await upsertTwilioMessageStatus({
      sid,
      to: params.To,
      from: params.From,
      status: params.MessageStatus || params.SmsStatus || "unknown",
      errorCode: params.ErrorCode || null,
      errorMessage: params.ErrorMessage || null,
    });
    return res.status(204).send();
  } catch (err) {
    logger.error("Twilio status callback write failed", err);
    return res.status(500).send("Failed to persist status");
  }
});

app.post("/api/twilio/messages", requireRoles(TWILIO_ROLES), async (req, res) => {
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
  if (!isValidWhatsAppRecipient(to)) {
    return res.status(400).json({ message: "Invalid recipient. Use whatsapp:+E164 or +E164." });
  }
  if (hasMedia && !isAllowedMediaUrl(mediaUrl)) {
    return res.status(400).json({
      message: "mediaUrl must be an https URL on Firebase Storage / Google Cloud Storage.",
    });
  }
  // Do not allow clients to override sender identity — use server secrets only
  messagingServiceSid = t.messagingServiceSid || "";
  from = t.whatsappFrom || "";
  if (!messagingServiceSid && !from) {
    return res.status(400).json({
      message:
        "Server sender not configured. Set TWILIO_MESSAGING_SERVICE_SID / TWILIO_WHATSAPP_FROM on the api function.",
    });
  }

  const statusCallback = `${getPublicApiBase(req)}/api/twilio/status`;

  const params = new URLSearchParams();
  params.set("To", to);
  if (hasBody) params.set("Body", bodyText);
  else if (hasMedia) params.set("Body", " ");
  if (messagingServiceSid) params.set("MessagingServiceSid", messagingServiceSid);
  else params.set("From", from);
  if (hasMedia) params.set("MediaUrl", mediaUrl);
  params.set("StatusCallback", statusCallback);
  for (const event of ["sent", "delivered", "read", "failed", "undelivered"]) {
    params.append("StatusCallbackEvent", event);
  }

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
      });
    }

    const sid = typeof data.sid === "string" ? data.sid : "";
    if (sid && isValidTwilioMessageSid(sid)) {
      try {
        await upsertTwilioMessageStatus({
          sid,
          to: typeof data.to === "string" ? data.to : to,
          from: typeof data.from === "string" ? data.from : from || undefined,
          status: typeof data.status === "string" ? data.status : "queued",
          errorCode: (data.error_code as string | number | null) ?? null,
          errorMessage: (data.error_message as string | null) ?? null,
        });
      } catch (seedErr) {
        logger.warn("Failed to seed Twilio status doc", seedErr);
      }
    }

    return res.status(201).json(data);
  } catch (err) {
    logger.error("Twilio send message error", err);
    return res.status(502).json({ message: "Failed to reach Twilio API." });
  }
});

// Auth-gated fallback for hosting rewrite path variants (n8n only)
app.get(/.*/, async (req, res) => {
  const originalUrl = req.originalUrl || req.url || "";
  if (originalUrl.includes("/api/twilio") || originalUrl.includes("/api/sheets")) {
    return res.status(404).send(`Cannot GET ${req.path}`);
  }

  const salesMatch = originalUrl.match(/n8n\/sales-executions(?:\/([^/?#]+))?/);
  if (salesMatch) {
    const auth = await authenticateRequest(req);
    if ("error" in auth) {
      return res.status(auth.status).json({ message: auth.error });
    }
    if (!SALES_N8N_ROLES.has(auth.role)) {
      return res.status(403).json({ message: "Forbidden: insufficient role." });
    }
    // Re-route conceptually: callers should hit explicit routes; keep 404 for odd paths
    return res.status(404).json({ message: "Use /api/n8n/sales-executions" });
  }

  const m = originalUrl.match(/n8n\/executions(?:\/([^/?#]+))?/);
  if (!m) {
    return res.status(404).send(`Cannot GET ${req.path}`);
  }

  const auth = await authenticateRequest(req);
  if ("error" in auth) {
    return res.status(auth.status).json({ message: auth.error });
  }
  if (!N8N_ROLES.has(auth.role)) {
    return res.status(403).json({ message: "Forbidden: insufficient role." });
  }

  const { apiUrl, apiKey } = getN8nConfig();
  if (!apiUrl || !apiKey) {
    return res.status(500).json({ message: "n8n proxy not configured (missing api url/key)." });
  }

  const base = apiUrl.replace(/\/$/, "");
  const id = m[1];

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
    invoker: "public",
    secrets: [
      n8nApiUrlSecret,
      n8nApiKeySecret,
      twilioAccountSidSecret,
      twilioAuthTokenSecret,
      twilioMessagingServiceSidSecret,
      twilioWhatsappFromSecret,
    ],
  },
  app
);
