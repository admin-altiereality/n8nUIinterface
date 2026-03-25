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
import { defineSecret } from "firebase-functions/params";

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

function getN8nConfig(): N8nProxyConfig {
  return {
    apiUrl: n8nApiUrlSecret.value(),
    apiKey: n8nApiKeySecret.value()
  };
}

const app = express();
app.use(cors({ origin: true }));
app.options(/.*/, cors({ origin: true }));

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

// Fallback: some hosting rewrites can change the effective path prefix.
// If the URL contains /n8n/executions, proxy it regardless of the exact Express route match.
app.get(/.*/, async (req, res) => {
  const originalUrl = req.originalUrl || req.url || '';
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

export const api = onRequest({ secrets: [n8nApiUrlSecret, n8nApiKeySecret] }, app);
