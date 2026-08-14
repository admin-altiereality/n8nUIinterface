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
const OPS_ROLES = new Set(["superadmin", "associate", "salesperson", "whatsapp_manager"]);

const SALES_FUNNEL_WORKFLOW_ID =
  process.env.N8N_SALES_WORKFLOW_ID || "sLk0CAalsSlR5z4P";
const SHEETS_LEADS_WEBHOOK_URL =
  process.env.N8N_SHEETS_LEADS_WEBHOOK_URL ||
  "https://n8n.altiereality.com/webhook/sheet-leads-read";

const TWILIO_STATUS_COLLECTION = "twilioMessageStatus";
const TWILIO_OUTBOUND_LOGS_COLLECTION = "twilioOutboundLogs";
const TWILIO_INBOUND_COLLECTION = "twilioInboundMessages";
const LEAD_ASSIGNMENTS_COLLECTION = "leadAssignments";
const OPS_AUDIT_COLLECTION = "opsAuditLog";
const DEFAULT_WHATSAPP_QUICK_REPLY_TEMPLATE_SID = "HX9fab5aaad062c64423df7a312c84e6af";
const DEFAULT_QUICK_REPLY_TEMPLATE_NAME = "LearnXR quick reply";
const MEDIA_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;
const SUPPORTED_MEDIA_CONTENT_TYPE = /^(image\/|video\/|audio\/|application\/pdf$)/i;
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
const ALERT_STATE_COLLECTION = "opsAlertState";
const OPS_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const TWILIO_FAILURE_THRESHOLD = 5;

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

function sanitizeMediaFilename(filename: string | undefined): string {
  const raw = String(filename || "document").trim() || "document";
  return (
    raw
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[\\/:*?"<>|#?&]+/g, "-")
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .trim() || "document"
  );
}

function contentDispositionFilename(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isValidTwilioContentSid(sid: string): boolean {
  return /^HX[a-f0-9]{32}$/i.test(sid.trim());
}

function getPublicMediaUrl(req: express.Request, mediaUrl: string, filename: string): string {
  const base = getPublicApiBase(req).replace(/\/$/, "");
  return `${base}/api/twilio/media/${encodeURIComponent(filename)}?url=${encodeURIComponent(mediaUrl)}`;
}

function readTemplateVariables(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[1-9]\d{0,2}$/.test(key)) continue;
    if (typeof val !== "string") continue;
    out[key] = val.slice(0, 1500);
  }
  return out;
}

async function preflightMediaUrl(publicMediaUrl: string): Promise<{
  ok: true;
  contentType: string;
  contentLength: number;
} | {
  ok: false;
  status: number;
  message: string;
}> {
  try {
    const upstream = await fetch(publicMediaUrl);
    if (!upstream.ok) {
      return { ok: false, status: upstream.status, message: "Media proxy URL is not reachable." };
    }
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const body = Buffer.from(await upstream.arrayBuffer());
    if (!SUPPORTED_MEDIA_CONTENT_TYPE.test(contentType)) {
      return { ok: false, status: 415, message: `Unsupported media type: ${contentType}` };
    }
    if (body.length > MEDIA_SIZE_LIMIT_BYTES) {
      return { ok: false, status: 413, message: "Media is too large for WhatsApp send." };
    }
    return { ok: true, contentType, contentLength: body.length };
  } catch (err) {
    logger.warn("media preflight failed", err);
    return { ok: false, status: 502, message: "Media proxy preflight failed." };
  }
}

function isValidWhatsAppRecipient(to: string): boolean {
  // whatsapp:+E164 or +E164
  return /^(whatsapp:)?\+[1-9]\d{7,14}$/i.test(to.trim());
}

function isValidTwilioMessageSid(sid: string): boolean {
  return /^SM[a-f0-9]{32}$/i.test(sid) || /^MM[a-f0-9]{32}$/i.test(sid);
}

function getAuthedUser(req: express.Request): AuthedUser | undefined {
  return (req as express.Request & { authedUser?: AuthedUser }).authedUser;
}

function safeText(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim();
}

function normalizeWhatsAppAddress(value: unknown): string {
  return safeText(value).replace(/^whatsapp:/i, "").trim();
}

function leadKeyFromPhone(value: unknown): string {
  const normalized = normalizeWhatsAppAddress(value).replace(/[^\d+]/g, "");
  if (!normalized) return "unknown";
  return normalized.startsWith("+") ? normalized : `+${normalized}`;
}

function roleCanUseSheets(role: string): boolean {
  return role === "superadmin" || role === "associate" || role === "salesperson";
}

function docDataWithId(doc: unknown): Record<string, unknown> {
  const d = doc as { id: string; data: () => Record<string, unknown> | undefined };
  return { id: d.id, ...(d.data() || {}) };
}

async function writeOpsAudit(input: {
  action: string;
  auth?: AuthedUser;
  targetId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await getDataProjectDb().collection(OPS_AUDIT_COLLECTION).add({
      action: input.action,
      actorUid: input.auth?.uid || null,
      actorEmail: input.auth?.email || null,
      actorRole: input.auth?.role || null,
      targetId: input.targetId || null,
      details: input.details || {},
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn("ops audit write failed", err);
  }
}

async function sendOpsAlert(input: {
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const webhookUrl = process.env.OPS_ALERT_EMAIL_WEBHOOK_URL || "";
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        source: "learnxr-agents-api",
        createdAt: new Date().toISOString(),
      }),
    });
    await writeOpsAudit({ action: "alert.sent", details: { type: input.type, severity: input.severity } });
  } catch (err) {
    logger.warn("ops alert webhook failed", err);
  }
}

async function sendRateLimitedOpsAlert(
  key: string,
  input: {
    type: string;
    severity: "info" | "warning" | "critical";
    message: string;
    details?: Record<string, unknown>;
  },
  cooldownMs = OPS_ALERT_COOLDOWN_MS
): Promise<void> {
  try {
    const ref = getDataProjectDb().collection(ALERT_STATE_COLLECTION).doc(key);
    const snap = await ref.get();
    const lastSentAt = snap.exists ? parseMaybeDate((snap.data() || {}).lastSentAt) : 0;
    if (lastSentAt && Date.now() - lastSentAt < cooldownMs) return;
    await sendOpsAlert(input);
    await ref.set(
      {
        key,
        type: input.type,
        severity: input.severity,
        lastSentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    logger.warn("rate-limited ops alert failed", err);
  }
}

async function writeTwilioDiagnostic(input: {
  phase: string;
  status: "attempt" | "success" | "failed";
  auth?: AuthedUser;
  to?: string;
  templateSid?: string;
  mediaFilename?: string;
  publicMediaUrl?: string;
  twilioHttpStatus?: number | null;
  twilioCode?: unknown;
  twilioMessage?: unknown;
  twilioMoreInfo?: unknown;
  messageSid?: string | null;
}): Promise<string | null> {
  try {
    const ref = await getDataProjectDb().collection(TWILIO_OUTBOUND_LOGS_COLLECTION).add({
      phase: input.phase,
      status: input.status,
      actorUid: input.auth?.uid || null,
      actorEmail: input.auth?.email || null,
      actorRole: input.auth?.role || null,
      to: input.to || null,
      templateSid: input.templateSid || null,
      mediaFilename: input.mediaFilename || null,
      publicMediaUrl: input.publicMediaUrl || null,
      twilioHttpStatus: input.twilioHttpStatus ?? null,
      twilioCode: input.twilioCode ?? null,
      twilioMessage: input.twilioMessage ?? null,
      twilioMoreInfo: input.twilioMoreInfo ?? null,
      messageSid: input.messageSid || null,
      createdAt: new Date().toISOString(),
    });
    return ref.id;
  } catch (err) {
    logger.warn("twilio diagnostic write failed", err);
    return null;
  }
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

function twilioSignatureUrlCandidates(req: express.Request, path: string): string[] {
  const base = getPublicApiBase(req).replace(/\/$/, "");
  const originalPath = (req.originalUrl || req.url || path).split("?")[0] || path;
  const host = (req.get("host") || "").split(",")[0]!.trim();
  const forwardedProto = (req.get("x-forwarded-proto") || "https").split(",")[0]!.trim();
  const candidates = new Set<string>([
    `${base}${path}`,
    `${base}${originalPath}`,
    `https://agents-altiereality-com.web.app${path}`,
    `https://agents-altiereality-com.web.app${originalPath}`,
    `https://agents.altiereality.com${path}`,
    `https://agents.altiereality.com${originalPath}`,
    `https://us-central1-lexrn1.cloudfunctions.net/api${path}`,
    `https://us-central1-lexrn1.cloudfunctions.net/api${originalPath}`,
    `https://api-l77silc7tq-uc.a.run.app${path}`,
    `https://api-l77silc7tq-uc.a.run.app${originalPath}`,
  ]);
  if (host) {
    candidates.add(`${forwardedProto}://${host}${path}`);
    candidates.add(`${forwardedProto}://${host}${originalPath}`);
    candidates.add(`https://${host}${path}`);
    candidates.add(`https://${host}${originalPath}`);
  }
  for (const value of [...candidates]) {
    candidates.add(`${value}/`);
  }
  return [...candidates];
}

function validateTwilioRequestForAnyUrl(
  authToken: string,
  signature: string | undefined,
  urls: string[],
  params: Record<string, string>
): boolean {
  return urls.some((url) => validateTwilioRequestSignature(authToken, signature, url, params));
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

function isFailedTwilioStatus(value: unknown): boolean {
  return ["failed", "undelivered", "canceled"].includes(safeText(value).toLowerCase());
}

async function maybeAlertTwilioFailureThreshold(): Promise<void> {
  try {
    const since = new Date(Date.now() - OPS_ALERT_COOLDOWN_MS).toISOString();
    const snap = await getDataProjectDb()
      .collection(TWILIO_STATUS_COLLECTION)
      .where("updatedAt", ">=", since)
      .limit(200)
      .get();
    const failures = snap.docs.map((d) => d.data() || {}).filter((d) => isFailedTwilioStatus(d.status));
    if (failures.length < TWILIO_FAILURE_THRESHOLD) return;
    await sendRateLimitedOpsAlert("twilio_failure_threshold", {
      type: "twilio.failure_threshold",
      severity: "warning",
      message: `${failures.length} WhatsApp delivery failures were logged in the last hour.`,
      details: {
        threshold: TWILIO_FAILURE_THRESHOLD,
        failures: failures.slice(0, 10).map((f) => ({
          sid: f.sid || null,
          to: f.to || null,
          status: f.status || null,
          errorCode: f.errorCode || null,
        })),
      },
    });
  } catch (err) {
    logger.warn("twilio failure threshold alert check failed", err);
  }
}

function bestTwilioStatusByPhone(statuses: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const byPhone = new Map<string, Record<string, unknown>>();
  for (const status of statuses) {
    const phone = leadKeyFromPhone(status.to || status.from);
    if (!phone || phone === "unknown") continue;
    const prev = byPhone.get(phone);
    if (!prev) {
      byPhone.set(phone, status);
      continue;
    }
    const prevRank = TWILIO_STATUS_RANK[safeText(prev.status).toLowerCase()] ?? -1;
    const nextRank = TWILIO_STATUS_RANK[safeText(status.status).toLowerCase()] ?? -1;
    const prevTime = parseMaybeDate(prev.updatedAt);
    const nextTime = parseMaybeDate(status.updatedAt);
    if (nextRank > prevRank || (nextRank === prevRank && nextTime >= prevTime)) {
      byPhone.set(phone, status);
    }
  }
  return byPhone;
}

function inboundByPhone(inbound: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const byPhone = new Map<string, Record<string, unknown>>();
  for (const message of inbound) {
    const phone = leadKeyFromPhone(message.from || message.From);
    if (!phone || phone === "unknown") continue;
    const prev = byPhone.get(phone);
    if (!prev || parseMaybeDate(message.createdAt) >= parseMaybeDate(prev.createdAt)) {
      byPhone.set(phone, message);
    }
  }
  return byPhone;
}

function filterLeadRows(rows: unknown[], query: Record<string, unknown>): Record<string, unknown>[] {
  const q = safeText(query.q).toLowerCase();
  const city = safeText(query.city).toLowerCase();
  const status = safeText(query.status).toLowerCase();
  const leadStatus = safeText(query.leadStatus).toLowerCase();
  const whatsappStatus = safeText(query.whatsappStatus).toLowerCase();

  return rows.filter((row): row is Record<string, unknown> => {
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
}

async function fetchSheetLeadRows(query: Record<string, unknown> = {}): Promise<{
  fetchedAt: string;
  rows: Record<string, unknown>[];
}> {
  const webhookUrl = SHEETS_LEADS_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("Sheets leads webhook is not configured.");
  }
  const url = new URL(webhookUrl);
  for (const key of ["city", "status", "leadStatus", "whatsappStatus", "q", "limit"] as const) {
    const val = query[key];
    if (typeof val === "string" && val.trim()) url.searchParams.set(key, val.trim());
  }

  const upstream = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const text = await upstream.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Unexpected sheets webhook response: ${text.slice(0, 120)}`);
  }
  if (!upstream.ok) {
    const message =
      data && typeof data === "object" && typeof (data as Record<string, unknown>).message === "string"
        ? String((data as Record<string, unknown>).message)
        : "Sheets leads fetch failed";
    throw new Error(message);
  }

  let rows: unknown[] = [];
  if (Array.isArray(data)) rows = data;
  else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.rows)) rows = obj.rows;
    else if (Array.isArray(obj.data)) rows = obj.data;
    else if (Array.isArray(obj.leads)) rows = obj.leads;
  }
  return { fetchedAt: new Date().toISOString(), rows: filterLeadRows(rows, query) };
}

function leadCity(row: Record<string, unknown>): string {
  return safeText(row.City || row.city || "Unknown", "Unknown") || "Unknown";
}

function leadStatus(row: Record<string, unknown>): string {
  return safeText(row.Lead_status || row.leadStatus || "Unknown", "Unknown") || "Unknown";
}

function whatsappStatus(row: Record<string, unknown>): string {
  return safeText(row.Whatsapp_status || row.whatsappStatus || "unknown", "unknown").toLowerCase();
}

function parseMaybeDate(value: unknown): number {
  const raw = safeText(value);
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

function isOverdueFollowUp(row: Record<string, unknown>): boolean {
  const t = parseMaybeDate(row.Next_Follow_up);
  return Boolean(t && t <= Date.now());
}

function csvEscape(value: unknown): string {
  const raw = String(value ?? "");
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  const headers = [
    "School Name",
    "Email ID",
    "City",
    "Status",
    "Lead_status",
    "Phone number",
    "Whatsapp_status",
    "Whatsapp_message_sid",
    "Twilio_status",
    "Twilio_error_code",
    "Twilio_error_message",
    "Twilio_updated_at",
    "Last_inbound_at",
    "Next_Follow_up",
    "assignedTo",
  ];
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return `${lines.join("\n")}\n`;
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

async function listStoredSalesExecutions(take: number): Promise<Array<Record<string, unknown>>> {
  const snap = await getDataProjectDb()
    .collection("salesFunnelRuns")
    .orderBy("createdAt", "desc")
    .limit(take)
    .get();
  return snap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: safeText(data.n8nExecutionId) || safeText(data.id) || doc.id,
      startedAt: safeText(data.startedAt) || safeText(data.createdAt),
      stoppedAt: safeText(data.stoppedAt) || undefined,
      status: safeText(data.status) || (data.ok === false ? "error" : "success"),
      mode: safeText(data.mode) || safeText(data.endpointMode) || "ui-trigger",
      workflowId: SALES_FUNNEL_WORKFLOW_ID,
      source: "firestore",
      runId: safeText(data.id) || doc.id,
    };
  });
}

async function getStoredSalesExecution(id: string): Promise<Record<string, unknown> | null> {
  const direct = await getDataProjectDb().collection("salesFunnelRuns").doc(id).get();
  let snap = direct.exists ? direct : null;
  if (!snap) {
    const byN8n = await getDataProjectDb()
      .collection("salesFunnelRuns")
      .where("n8nExecutionId", "==", id)
      .limit(1)
      .get();
    snap = byN8n.docs[0] || null;
  }
  if (!snap) return null;
  const data = snap.data() || {};
  return {
    id: safeText(data.n8nExecutionId) || safeText(data.id) || snap.id,
    finished: safeText(data.status).toLowerCase() !== "waiting",
    status: safeText(data.status) || (data.ok === false ? "error" : "success"),
    startedAt: safeText(data.startedAt) || safeText(data.createdAt),
    stoppedAt: safeText(data.stoppedAt) || undefined,
    workflowId: SALES_FUNNEL_WORKFLOW_ID,
    mode: safeText(data.mode) || safeText(data.endpointMode) || "ui-trigger",
    source: "firestore",
    data: {
      resultData: {
        runData: {},
      },
    },
    storedRun: data,
  };
}

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
    if (!upstream.ok) {
      const fallback = await listStoredSalesExecutions(take);
      logger.warn("n8n sales executions upstream failed; returning Firestore fallback", {
        status: upstream.status,
        fallbackCount: fallback.length,
      });
      await sendRateLimitedOpsAlert("n8n_sales_api_unavailable", {
        type: "n8n.execution_api_unavailable",
        severity: "warning",
        message: "n8n sales executions API returned a non-OK response; Firestore fallback is active.",
        details: { status: upstream.status, workflowId, fallbackCount: fallback.length },
      });
      return res.json({
        data: fallback,
        source: "firestore",
        warning: "n8n execution API is unavailable; showing stored sales funnel runs.",
      });
    }
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
    try {
      return res.send(JSON.stringify(JSON.parse(text)));
    } catch {
      return res.send(text);
    }
  } catch (err) {
    logger.error("n8n sales executions proxy failed", err);
    const fallback = await listStoredSalesExecutions(take);
    await sendRateLimitedOpsAlert("n8n_sales_api_unreachable", {
      type: "n8n.execution_api_unreachable",
      severity: "warning",
      message: "n8n sales executions API could not be reached; Firestore fallback is active.",
      details: { workflowId, fallbackCount: fallback.length },
    });
    return res.json({
      data: fallback,
      source: "firestore",
      warning: "n8n execution API is unreachable; showing stored sales funnel runs.",
    });
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
      const fallback = await getStoredSalesExecution(id);
      if (fallback) {
        logger.warn("n8n sales execution detail upstream failed; returning Firestore fallback", {
          status: upstream.status,
          id,
        });
        return res.json(fallback);
      }
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
    const fallback = await getStoredSalesExecution(id);
    if (fallback) return res.json(fallback);
    return res.status(502).json({ message: "Failed to fetch sales execution detail from n8n." });
  }
});

app.options("/api/sheets/leads", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));

app.get("/api/sheets/leads", requireRoles(SHEETS_ROLES), async (req, res) => {
  try {
    const result = await fetchSheetLeadRows(req.query as Record<string, unknown>);
    const limitRaw = Number.parseInt(String(req.query.limit || "500"), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 2000) : 500;
    return res.json({
      ok: true,
      fetchedAt: result.fetchedAt,
      total: result.rows.length,
      rows: result.rows.slice(0, limit),
    });
  } catch (err) {
    logger.error("sheets leads proxy failed", err);
    return res.status(502).json({ message: err instanceof Error ? err.message : "Failed to fetch leads from sheets webhook." });
  }
});

app.options("/api/ops/dashboard", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/ops/export.csv", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/ops/leads/:id/timeline", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/ops/assignments/:threadId", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/ops/audit", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));

app.get("/api/ops/dashboard", requireRoles(OPS_ROLES), async (req, res) => {
  const auth = getAuthedUser(req);
  try {
    const canReadLeadRows = auth ? roleCanUseSheets(auth.role) : false;
    const leadsResult = canReadLeadRows
      ? await fetchSheetLeadRows({ ...req.query, limit: "2000" } as Record<string, unknown>)
      : { fetchedAt: new Date().toISOString(), rows: [] as Record<string, unknown>[] };
    const db = getDataProjectDb();
    const [statusSnap, outboundSnap, inboundSnap, assignmentSnap, auditSnap, runsSnap] = await Promise.all([
      db.collection(TWILIO_STATUS_COLLECTION).limit(500).get(),
      db.collection(TWILIO_OUTBOUND_LOGS_COLLECTION).orderBy("createdAt", "desc").limit(200).get(),
      db.collection(TWILIO_INBOUND_COLLECTION).orderBy("createdAt", "desc").limit(200).get(),
      db.collection(LEAD_ASSIGNMENTS_COLLECTION).limit(500).get(),
      db.collection(OPS_AUDIT_COLLECTION).orderBy("createdAt", "desc").limit(50).get(),
      db.collection("salesFunnelRuns").orderBy("createdAt", "desc").limit(100).get().catch(() => ({ docs: [] })),
    ]);
    const statuses = statusSnap.docs.map(docDataWithId);
    const outbound = outboundSnap.docs.map(docDataWithId);
    const inbound = inboundSnap.docs.map(docDataWithId);
    const statusByPhone = bestTwilioStatusByPhone(statuses);
    const assignments = assignmentSnap.docs.map(docDataWithId);
    const today = new Date().toISOString().slice(0, 10);
    const deliveredToday = statuses.filter((s) => {
      const st = safeText(s.status).toLowerCase();
      return (st === "delivered" || st === "read") && safeText(s.updatedAt).startsWith(today);
    }).length;
    const readToday = statuses.filter((s) => safeText(s.status).toLowerCase() === "read" && safeText(s.updatedAt).startsWith(today)).length;
    const failedStatusRows = statuses
      .filter((s) => ["failed", "undelivered", "canceled"].includes(safeText(s.status).toLowerCase()))
      .sort((a, b) => parseMaybeDate(b.updatedAt) - parseMaybeDate(a.updatedAt));
    const failedWhatsApp = failedStatusRows.length;
    const leadsByStatus: Record<string, number> = {};
    const campaignByCity: Record<string, Record<string, number>> = {};
    for (const lead of leadsResult.rows) {
      const status = leadStatus(lead);
      leadsByStatus[status] = (leadsByStatus[status] || 0) + 1;
      const city = leadCity(lead);
      const bucket = campaignByCity[city] || {
        scraped: 0,
        emailed: 0,
        whatsappSent: 0,
        delivered: 0,
        read: 0,
        replied: 0,
        failed: 0,
      };
      bucket.scraped += 1;
      if (safeText(lead.Reply_Status) || safeText(lead.email_sent_at)) bucket.emailed += 1;
      const phone = leadKeyFromPhone(lead["Phone number"] || lead.to_number);
      const twilioStatus = statusByPhone.get(phone);
      const wa = twilioStatus ? safeText(twilioStatus.status).toLowerCase() : whatsappStatus(lead);
      if (wa) bucket.whatsappSent += wa === "unknown" ? 0 : 1;
      if (wa === "delivered") bucket.delivered += 1;
      if (wa === "read") bucket.read += 1;
      if (safeText(lead.whatsapp_replied).toLowerCase() === "true" || safeText(lead.whatsapp_reply_message)) bucket.replied += 1;
      if (wa === "failed" || wa === "undelivered") bucket.failed += 1;
      campaignByCity[city] = bucket;
    }
    const openFollowUps = leadsResult.rows.filter(isOverdueFollowUp).length;
    const activeFunnelRuns = (runsSnap.docs || []).filter((d) => {
      const data = d.data ? d.data() : {};
      const st = safeText(data.status).toLowerCase();
      return st === "running" || st === "waiting";
    }).length;
    return res.json({
      ok: true,
      fetchedAt: leadsResult.fetchedAt,
      role: auth?.role || null,
      kpis: {
        activeFunnelRuns,
        messagesDeliveredToday: deliveredToday,
        messagesReadToday: readToday,
        failedWhatsApp,
        openFollowUps,
        totalLeads: leadsResult.rows.length,
        inboundToday: inbound.filter((m) => safeText(m.createdAt).startsWith(today)).length,
      },
      leadsByStatus,
      campaignByCity,
      followUps: leadsResult.rows.filter(isOverdueFollowUp).slice(0, 25),
      failedMessages: failedStatusRows.slice(0, 25),
      assignments,
      recentAudit: auditSnap.docs.map(docDataWithId),
      canReadLeadRows,
    });
  } catch (err) {
    logger.error("ops dashboard failed", err);
    return res.status(502).json({ message: err instanceof Error ? err.message : "Failed to load ops dashboard." });
  }
});

app.post("/api/ops/audit", requireRoles(OPS_ROLES), async (req, res) => {
  const auth = getAuthedUser(req);
  const action = safeText(req.body?.action);
  if (!/^[a-z][a-z0-9_.-]{2,80}$/i.test(action)) {
    return res.status(400).json({ message: "Invalid audit action." });
  }
  const targetIdRaw = safeText(req.body?.targetId);
  const details = req.body?.details && typeof req.body.details === "object" && !Array.isArray(req.body.details)
    ? req.body.details as Record<string, unknown>
    : {};
  await writeOpsAudit({
    action,
    auth,
    targetId: targetIdRaw || null,
    details,
  });
  if (action.includes("n8n") && safeText(details.status).toLowerCase() === "error") {
    await sendRateLimitedOpsAlert("n8n_execution_errors", {
      type: "n8n.execution_error",
      severity: "warning",
      message: "A sales funnel n8n launch or execution was reported as failed.",
      details: { action, targetId: targetIdRaw || null, ...details },
    });
  }
  return res.status(201).json({ ok: true });
});

app.get("/api/ops/export.csv", requireRoles(OPS_ROLES), async (req, res) => {
  const auth = getAuthedUser(req);
  if (!auth || !roleCanUseSheets(auth.role)) {
    return res.status(403).send("Forbidden: export requires sales lead access.");
  }
  try {
    const result = await fetchSheetLeadRows({ ...req.query, limit: "5000" } as Record<string, unknown>);
    const db = getDataProjectDb();
    const [assignmentsSnap, statusesSnap, inboundSnap] = await Promise.all([
      db.collection(LEAD_ASSIGNMENTS_COLLECTION).limit(1000).get(),
      db.collection(TWILIO_STATUS_COLLECTION).limit(1000).get(),
      db.collection(TWILIO_INBOUND_COLLECTION).orderBy("createdAt", "desc").limit(1000).get(),
    ]);
    const assignments = new Map(assignmentsSnap.docs.map((doc) => [doc.id, doc.data() || {}]));
    const statusByPhone = bestTwilioStatusByPhone(statusesSnap.docs.map(docDataWithId));
    const latestInboundByPhone = inboundByPhone(inboundSnap.docs.map(docDataWithId));
    const rows = result.rows.map((row) => {
      const key = leadKeyFromPhone(row["Phone number"] || row.to_number);
      const assignment = assignments.get(key) || {};
      const twilioStatus = statusByPhone.get(key) || {};
      const inbound = latestInboundByPhone.get(key) || {};
      return {
        ...row,
        Twilio_status: twilioStatus.status || row.Whatsapp_status || "",
        Twilio_error_code: twilioStatus.errorCode || "",
        Twilio_error_message: twilioStatus.errorMessage || "",
        Twilio_updated_at: twilioStatus.updatedAt || "",
        Last_inbound_at: inbound.createdAt || "",
        assignedTo: assignment.assignedToEmail || assignment.assignedToName || "",
      };
    });
    await writeOpsAudit({ action: "ops.export.csv", auth, details: { rows: rows.length } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="learnxr-leads-export.csv"');
    return res.status(200).send(rowsToCsv(rows));
  } catch (err) {
    logger.error("ops csv export failed", err);
    return res.status(502).send("Failed to export leads.");
  }
});

app.get("/api/ops/leads/:id/timeline", requireRoles(OPS_ROLES), async (req, res) => {
  const leadId = decodeURIComponent(req.params.id || "");
  try {
    const db = getDataProjectDb();
    const [statusSnap, inboundSnap, outboundSnap, assignmentSnap, auditSnap] = await Promise.all([
      db.collection(TWILIO_STATUS_COLLECTION).limit(500).get(),
      db.collection(TWILIO_INBOUND_COLLECTION).orderBy("createdAt", "desc").limit(200).get(),
      db.collection(TWILIO_OUTBOUND_LOGS_COLLECTION).orderBy("createdAt", "desc").limit(200).get(),
      db.collection(LEAD_ASSIGNMENTS_COLLECTION).doc(leadId).get(),
      db.collection(OPS_AUDIT_COLLECTION).where("targetId", "==", leadId).limit(100).get().catch(() => ({ docs: [] })),
    ]);
    const leadRows = roleCanUseSheets(getAuthedUser(req)?.role || "")
      ? (await fetchSheetLeadRows({ limit: "2000" })).rows
      : [];
    const lead = leadRows.find((row) => leadKeyFromPhone(row["Phone number"] || row.to_number) === leadId) || null;
    const timeline = [
      ...inboundSnap.docs.map(docDataWithId).filter((m) => leadKeyFromPhone(m.from || m.From) === leadId).map((m) => ({ type: "whatsapp_inbound", at: m.createdAt, data: m })),
      ...outboundSnap.docs.map(docDataWithId).filter((m) => leadKeyFromPhone(m.to) === leadId).map((m) => ({ type: "whatsapp_outbound", at: m.createdAt, data: m })),
      ...statusSnap.docs.map(docDataWithId).filter((m) => leadKeyFromPhone(m.to || m.from) === leadId).map((m) => ({ type: "delivery_status", at: m.updatedAt, data: m })),
      ...(auditSnap.docs || []).map(docDataWithId).map((m) => ({ type: "audit", at: m.createdAt, data: m })),
    ].sort((a, b) => parseMaybeDate(b.at) - parseMaybeDate(a.at));
    return res.json({
      ok: true,
      leadId,
      lead,
      assignment: assignmentSnap.exists ? assignmentSnap.data() : null,
      timeline,
    });
  } catch (err) {
    logger.error("ops lead timeline failed", err);
    return res.status(502).json({ message: "Failed to load lead timeline." });
  }
});

app.get("/api/ops/assignments/:threadId", requireRoles(OPS_ROLES), async (req, res) => {
  const threadId = leadKeyFromPhone(req.params.threadId);
  const snap = await getDataProjectDb().collection(LEAD_ASSIGNMENTS_COLLECTION).doc(threadId).get();
  return res.json({ assignment: snap.exists ? { id: snap.id, ...snap.data() } : null });
});

app.patch("/api/ops/assignments/:threadId", requireRoles(OPS_ROLES), async (req, res) => {
  const auth = getAuthedUser(req);
  const threadId = leadKeyFromPhone(req.params.threadId);
  const action = safeText(req.body?.action || "claim");
  const notes = safeText(req.body?.notes).slice(0, 1000);
  const ref = getDataProjectDb().collection(LEAD_ASSIGNMENTS_COLLECTION).doc(threadId);
  const snap = await ref.get();
  const existing = snap.exists ? (snap.data() || {}) : null;
  if (action === "unclaim") {
    if (existing?.assignedTo && existing.assignedTo !== auth?.uid && auth?.role !== "superadmin" && auth?.role !== "associate") {
      return res.status(409).json({ message: "Thread is assigned to another user.", assignment: existing });
    }
    await ref.set({ assignedTo: null, assignedToEmail: null, assignedToName: null, notes, unassignedAt: new Date().toISOString() }, { merge: true });
    await writeOpsAudit({ action: "assignment.unclaim", auth, targetId: threadId, details: notes ? { notes } : {} });
    return res.json({ assignment: null });
  }
  if (existing?.assignedTo && existing.assignedTo !== auth?.uid) {
    return res.status(409).json({ message: "Thread is already claimed.", assignment: existing });
  }
  const assignment = {
    assignedTo: auth?.uid || null,
    assignedToEmail: auth?.email || null,
    assignedToName: auth?.email || auth?.uid || "Agent",
    assignedAt: new Date().toISOString(),
    notes,
    threadId,
  };
  await ref.set(assignment, { merge: true });
  await writeOpsAudit({ action: "assignment.claim", auth, targetId: threadId, details: assignment });
  return res.json({ assignment });
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
app.options("/api/twilio/templates", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/twilio/send-diagnostics", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));
app.options("/api/twilio/inbound", cors({
  origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin || undefined)),
}));

app.get("/api/twilio/health", requireRoles(TWILIO_ROLES), (_req, res) => {
  const t = getTwilioConfig();
  return res.json({
    ok: t.ok,
    source: "firebase-functions",
  });
});

app.get("/api/twilio/templates", requireRoles(TWILIO_ROLES), (_req, res) => {
  return res.json({
    templates: [
      {
        sid: DEFAULT_WHATSAPP_QUICK_REPLY_TEMPLATE_SID,
        name: DEFAULT_QUICK_REPLY_TEMPLATE_NAME,
        channel: "whatsapp",
        mediaType: "text",
        contentType: "twilio/quick-reply",
        variables: {},
        isDefault: true,
      },
    ],
  });
});

app.get("/api/twilio/send-diagnostics", requireRoles(TWILIO_ROLES), async (req, res) => {
  const takeRaw = Number.parseInt(String(req.query.limit || "25"), 10);
  const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 100) : 25;
  try {
    const snap = await getDataProjectDb()
      .collection(TWILIO_OUTBOUND_LOGS_COLLECTION)
      .orderBy("createdAt", "desc")
      .limit(take)
      .get();
    return res.json({ diagnostics: snap.docs.map(docDataWithId) });
  } catch (err) {
    logger.error("Twilio diagnostics list failed", err);
    return res.status(502).json({ message: "Failed to load send diagnostics." });
  }
});

app.get("/api/twilio/inbound", requireRoles(TWILIO_ROLES), async (req, res) => {
  const takeRaw = Number.parseInt(String(req.query.limit || "100"), 10);
  const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 200) : 100;
  try {
    const snap = await getDataProjectDb()
      .collection(TWILIO_INBOUND_COLLECTION)
      .orderBy("createdAt", "desc")
      .limit(take)
      .get();
    const messages = snap.docs.map(docDataWithId).map((doc) => ({
      sid: doc.sid || doc.id,
      to: doc.to || null,
      from: doc.from || null,
      body: doc.body || "",
      status: doc.status || "received",
      direction: "inbound",
      date_created: doc.createdAt || null,
      date_sent: doc.createdAt || null,
      date_updated: doc.createdAt || null,
      media: Array.isArray(doc.media)
        ? (doc.media as Array<Record<string, unknown>>).map((m) => ({
            content_type: m.contentType || m.content_type || "",
            media_url: m.url || m.media_url || "",
            preview_url: m.url || m.preview_url || "",
            filename: m.filename || "Attachment",
          }))
        : [],
    }));
    return res.json({ messages });
  } catch (err) {
    logger.error("Twilio inbound list failed", err);
    return res.status(502).json({ message: "Failed to load inbound messages." });
  }
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
  const callbackUrls = twilioSignatureUrlCandidates(req, "/api/twilio/status");
  if (!validateTwilioRequestForAnyUrl(t.authToken, signature, callbackUrls, params)) {
    logger.warn("Twilio status signature mismatch", { callbackUrl: callbackUrls[0] });
    return res.status(403).send("Invalid signature");
  }

  const sid = params.MessageSid || params.SmsSid || "";
  if (!isValidTwilioMessageSid(sid)) {
    return res.status(400).send("Invalid MessageSid");
  }

  try {
    const status = params.MessageStatus || params.SmsStatus || "unknown";
    await upsertTwilioMessageStatus({
      sid,
      to: params.To,
      from: params.From,
      status,
      errorCode: params.ErrorCode || null,
      errorMessage: params.ErrorMessage || null,
    });
    if (isFailedTwilioStatus(status)) {
      await maybeAlertTwilioFailureThreshold();
    }
    return res.status(204).send();
  } catch (err) {
    logger.error("Twilio status callback write failed", err);
    return res.status(500).send("Failed to persist status");
  }
});

app.post("/api/twilio/inbound", async (req, res) => {
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
  const callbackUrls = twilioSignatureUrlCandidates(req, "/api/twilio/inbound");
  if (!validateTwilioRequestForAnyUrl(t.authToken, signature, callbackUrls, params)) {
    logger.warn("Twilio inbound signature mismatch", { callbackUrl: callbackUrls[0] });
    return res.status(403).send("Invalid signature");
  }

  const sid = params.MessageSid || params.SmsSid || "";
  if (!isValidTwilioMessageSid(sid)) {
    return res.status(400).send("Invalid MessageSid");
  }

  try {
    const threadId = leadKeyFromPhone(params.From);
    const mediaCount = Number.parseInt(params.NumMedia || "0", 10) || 0;
    const media: Array<Record<string, string>> = [];
    for (let i = 0; i < mediaCount; i += 1) {
      media.push({
        url: params[`MediaUrl${i}`] || "",
        contentType: params[`MediaContentType${i}`] || "",
      });
    }
    const doc = {
      sid,
      threadId,
      from: params.From || null,
      to: params.To || null,
      body: params.Body || "",
      media,
      status: params.MessageStatus || params.SmsStatus || "received",
      createdAt: new Date().toISOString(),
      rawKeys: Object.keys(params).sort(),
    };
    await getDataProjectDb().collection(TWILIO_INBOUND_COLLECTION).doc(sid).set(doc, { merge: true });
    await upsertTwilioMessageStatus({
      sid,
      to: params.To,
      from: params.From,
      status: params.MessageStatus || params.SmsStatus || "received",
      errorCode: params.ErrorCode || null,
      errorMessage: params.ErrorMessage || null,
    });
    await writeOpsAudit({ action: "twilio.inbound.persisted", targetId: threadId, details: { sid } });
    res.setHeader("Content-Type", "text/xml");
    return res.status(200).send("<Response></Response>");
  } catch (err) {
    logger.error("Twilio inbound write failed", err);
    return res.status(500).send("Failed to persist inbound message");
  }
});

app.get("/api/twilio/media/:filename", async (req, res) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
  const filename = sanitizeMediaFilename(req.params.filename);
  if (!rawUrl || !isAllowedMediaUrl(rawUrl)) {
    return res.status(400).send("Invalid media URL");
  }

  try {
    const upstream = await fetch(rawUrl);
    if (!upstream.ok) {
      return res.status(upstream.status).send("Media unavailable");
    }
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(body.length));
    res.setHeader("Content-Disposition", contentDispositionFilename(filename));
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).send(body);
  } catch (err) {
    logger.warn("Twilio media proxy failed", err);
    return res.status(502).send("Failed to fetch media");
  }
});

app.post("/api/twilio/messages", requireRoles(TWILIO_ROLES), async (req, res) => {
  const authUser = getAuthedUser(req);
  const t = getTwilioConfig();
  if (!t.ok) {
    return res.status(503).json({ message: "Twilio is not configured on this function." });
  }

  const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
  const bodyText = typeof req.body?.body === "string" ? req.body.body : "";
  const mediaUrl = typeof req.body?.mediaUrl === "string" ? req.body.mediaUrl.trim() : "";
  const mediaFilename = sanitizeMediaFilename(
    typeof req.body?.mediaFilename === "string" ? req.body.mediaFilename : undefined
  );
  const requestedTemplateSid =
    typeof req.body?.templateSid === "string" && req.body.templateSid.trim()
      ? req.body.templateSid.trim()
      : "";
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
  const templateSid = requestedTemplateSid;
  let diagnosticId: string | null = null;

  if (!to || (!hasBody && !hasMedia)) {
    diagnosticId = await writeTwilioDiagnostic({
      phase: "validation",
      status: "failed",
      auth: authUser,
      to,
      templateSid,
      mediaFilename,
      twilioMessage: "Missing required fields",
    });
    return res.status(400).json({
      message: `Missing required fields (Twilio send): toPresent=${Boolean(to)} hasBody=${hasBody} hasMedia=${hasMedia}`,
      phase: "validation",
      diagnosticId,
    });
  }
  if (!isValidWhatsAppRecipient(to)) {
    diagnosticId = await writeTwilioDiagnostic({
      phase: "validation",
      status: "failed",
      auth: authUser,
      to,
      templateSid,
      mediaFilename,
      twilioMessage: "Invalid recipient",
    });
    return res.status(400).json({
      message: "Invalid recipient. Use whatsapp:+E164 or +E164.",
      phase: "validation",
      diagnosticId,
    });
  }
  if (hasMedia && !isAllowedMediaUrl(mediaUrl)) {
    diagnosticId = await writeTwilioDiagnostic({
      phase: "validation",
      status: "failed",
      auth: authUser,
      to,
      templateSid,
      mediaFilename,
      twilioMessage: "Invalid media URL",
    });
    return res.status(400).json({
      message: "mediaUrl must be an https URL on Firebase Storage / Google Cloud Storage.",
      phase: "validation",
      diagnosticId,
    });
  }
  if (templateSid && !isValidTwilioContentSid(templateSid)) {
    diagnosticId = await writeTwilioDiagnostic({
      phase: "validation",
      status: "failed",
      auth: authUser,
      to,
      templateSid,
      mediaFilename,
      twilioMessage: "Invalid Twilio template/content SID",
    });
    return res.status(400).json({
      message: "Invalid Twilio template/content SID.",
      phase: "validation",
      diagnosticId,
    });
  }
  // Do not allow clients to override sender identity — use server secrets only
  messagingServiceSid = t.messagingServiceSid || "";
  from = t.whatsappFrom || "";
  if (!messagingServiceSid && !from) {
    diagnosticId = await writeTwilioDiagnostic({
      phase: "configuration",
      status: "failed",
      auth: authUser,
      to,
      templateSid,
      mediaFilename,
      twilioMessage: "Server sender not configured",
    });
    return res.status(400).json({
      message:
        "Server sender not configured. Set TWILIO_MESSAGING_SERVICE_SID / TWILIO_WHATSAPP_FROM on the api function.",
      phase: "configuration",
      diagnosticId,
    });
  }

  const statusCallback = `${getPublicApiBase(req)}/api/twilio/status`;
  const publicMediaUrl = hasMedia ? getPublicMediaUrl(req, mediaUrl, mediaFilename) : "";
  const templateVariables = readTemplateVariables(req.body?.templateVariables);
  if (hasMedia && !templateVariables["1"]) templateVariables["1"] = publicMediaUrl;
  if (hasMedia && !templateVariables["2"]) templateVariables["2"] = mediaFilename;
  if (hasMedia && !templateVariables["3"]) templateVariables["3"] = bodyText.trim() || `Please review ${mediaFilename}.`;
  else if (hasBody && !templateVariables["3"]) templateVariables["3"] = bodyText.trim();

  diagnosticId = await writeTwilioDiagnostic({
    phase: "attempt",
    status: "attempt",
    auth: authUser,
    to,
    templateSid,
    mediaFilename,
    publicMediaUrl,
  });

  if (hasMedia) {
    const preflight = await preflightMediaUrl(publicMediaUrl);
    if (!preflight.ok) {
      const failedDiagnosticId =
        (await writeTwilioDiagnostic({
          phase: "media_preflight",
          status: "failed",
          auth: authUser,
          to,
          templateSid,
          mediaFilename,
          publicMediaUrl,
          twilioHttpStatus: preflight.status,
          twilioMessage: preflight.message,
        })) || diagnosticId;
      return res.status(preflight.status).json({
        message: preflight.message,
        phase: "media_preflight",
        diagnosticId: failedDiagnosticId,
      });
    }
  }

  const params = new URLSearchParams();
  params.set("To", to);
  if (templateSid) {
    params.set("ContentSid", templateSid);
    if (Object.keys(templateVariables).length) {
      params.set("ContentVariables", JSON.stringify(templateVariables));
    }
  } else if (hasBody) params.set("Body", bodyText);
  else if (hasMedia) params.set("Body", " ");
  if (messagingServiceSid) params.set("MessagingServiceSid", messagingServiceSid);
  else params.set("From", from);
  if (hasMedia && !templateSid) params.set("MediaUrl", publicMediaUrl);
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
      const failedDiagnosticId =
        (await writeTwilioDiagnostic({
          phase: "twilio_api",
          status: "failed",
          auth: authUser,
          to,
          templateSid,
          mediaFilename,
          publicMediaUrl,
          twilioHttpStatus: apiRes.status,
          twilioCode: data.code,
          twilioMessage: data.message,
          twilioMoreInfo: data.more_info,
        })) || diagnosticId;
      if (apiRes.status === 401 || apiRes.status === 403) {
        await sendOpsAlert({
          type: "twilio.account_unavailable",
          severity: "critical",
          message: "Twilio rejected a send request with an auth/account status.",
          details: { status: apiRes.status, code: data.code },
        });
      }
      return res.status(apiRes.status).json({
        message: (data.message as string) || (data.more_info as string) || "Twilio send failed",
        code: data.code,
        moreInfo: data.more_info,
        phase: "twilio_api",
        diagnosticId: failedDiagnosticId,
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
    await writeTwilioDiagnostic({
      phase: "twilio_api",
      status: "success",
      auth: authUser,
      to,
      templateSid,
      mediaFilename,
      publicMediaUrl,
      twilioHttpStatus: apiRes.status,
      messageSid: sid || null,
    });
    await writeOpsAudit({
      action: "twilio.send.success",
      auth: authUser,
      targetId: leadKeyFromPhone(to),
      details: { sid, templateSid: templateSid || null, hasMedia },
    });

    return res.status(201).json(data);
  } catch (err) {
    logger.error("Twilio send message error", err);
    const failedDiagnosticId =
      (await writeTwilioDiagnostic({
        phase: "twilio_api",
        status: "failed",
        auth: authUser,
        to,
        templateSid,
        mediaFilename,
        publicMediaUrl,
        twilioMessage: err instanceof Error ? err.message : "Failed to reach Twilio API",
      })) || diagnosticId;
    return res.status(502).json({
      message: "Failed to reach Twilio API.",
      phase: "twilio_api",
      diagnosticId: failedDiagnosticId,
    });
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
