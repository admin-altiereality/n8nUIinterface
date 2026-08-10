const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const cors = require('cors');
require('dotenv').config();
const upload = multer({ dest: 'uploads/' });
const app = express();

// Allow the React dev server to call this API
app.use(
  cors({
    origin: 'http://localhost:5173',
  })
);
app.use(express.json({ limit: '256kb' }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const DEFAULT_WHATSAPP_DOCUMENT_TEMPLATE_SID = 'HX9fab5aaad062c64423df7a312c84e6af';

function twilioBasicAuthHeader() {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  const token = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

function twilioPageTokenFromNextUri(nextUri) {
  if (!nextUri || typeof nextUri !== 'string') return null;
  const q = nextUri.includes('?') ? nextUri.split('?')[1] : '';
  return new URLSearchParams(q).get('PageToken');
}

function isAllowedMediaUrl(mediaUrl) {
  try {
    const u = new URL(mediaUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return (
      host === 'firebasestorage.googleapis.com' ||
      host.endsWith('.firebasestorage.app') ||
      host === 'storage.googleapis.com'
    );
  } catch {
    return false;
  }
}

function sanitizeMediaFilename(filename) {
  const raw = String(filename || 'document').trim() || 'document';
  return (
    raw
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/:*?"<>|#?&]+/g, '-')
      .replace(/\s+/g, ' ')
      .slice(0, 120)
      .trim() || 'document'
  );
}

function contentDispositionFilename(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isValidTwilioContentSid(sid) {
  return /^HX[a-f0-9]{32}$/i.test(String(sid || '').trim());
}

function readTemplateVariables(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (!/^[1-9]\d{0,2}$/.test(key)) continue;
    if (typeof val !== 'string') continue;
    out[key] = val.slice(0, 1500);
  }
  return out;
}

function getPublicBase(req) {
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || 'localhost:3001').split(',')[0].trim();
  return `${proto}://${host}`;
}

function getPublicMediaUrl(req, mediaUrl, filename) {
  return `${getPublicBase(req).replace(/\/$/, '')}/twilio/media/${encodeURIComponent(filename)}?url=${encodeURIComponent(mediaUrl)}`;
}

// Twilio Programmable Messaging (Account SID + Auth Token in .env only — never in the browser).
// CLI: `twilio profiles:list` then `twilio api:core:messages:list --limit 20`
app.get('/twilio/health', (_req, res) => {
  const configured = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
  const hint =
    TWILIO_ACCOUNT_SID && TWILIO_ACCOUNT_SID.length > 6
      ? `${TWILIO_ACCOUNT_SID.slice(0, 2)}…${TWILIO_ACCOUNT_SID.slice(-4)}`
      : null;
  res.json({ ok: configured, accountHint: hint });
});

app.get('/twilio/messages', async (req, res) => {
  const auth = twilioBasicAuthHeader();
  if (!auth) {
    return res.status(503).json({
      message: 'Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on this server.',
    });
  }

  const pageSizeRaw = Number.parseInt(String(req.query.pageSize || '35'), 10);
  const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(100, Math.max(1, pageSizeRaw)) : 35;
  const pageToken = typeof req.query.pageToken === 'string' ? req.query.pageToken : '';
  const dateSentAfter = typeof req.query.dateSentAfter === 'string' ? req.query.dateSentAfter : '';

  const url = new URL(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Messages.json`
  );
  url.searchParams.set('PageSize', String(pageSize));
  if (pageToken) url.searchParams.set('PageToken', pageToken);
  if (dateSentAfter) url.searchParams.set('DateSent>', dateSentAfter);

  try {
    const apiRes = await fetch(url.toString(), { headers: { Authorization: auth } });
    const text = await apiRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ message: 'Unexpected Twilio response', raw: text.slice(0, 500) });
    }
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({
        message: data.message || data.more_info || 'Twilio list messages failed',
        code: data.code,
      });
    }
    const nextPageToken = twilioPageTokenFromNextUri(data.next_page_uri);
    return res.json({
      messages: Array.isArray(data.messages) ? data.messages : [],
      nextPageToken,
    });
  } catch (err) {
    console.error('Twilio list messages error:', err);
    return res.status(502).json({ message: 'Failed to reach Twilio API.' });
  }
});

app.get('/twilio/messages/:sid', async (req, res) => {
  const auth = twilioBasicAuthHeader();
  if (!auth) {
    return res.status(503).json({ message: 'Twilio is not configured on this server.' });
  }
  const { sid } = req.params;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    TWILIO_ACCOUNT_SID
  )}/Messages/${encodeURIComponent(sid)}.json`;

  try {
    const apiRes = await fetch(url, { headers: { Authorization: auth } });
    const text = await apiRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ message: 'Unexpected Twilio response', raw: text.slice(0, 500) });
    }
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({
        message: data.message || data.more_info || 'Twilio fetch message failed',
        code: data.code,
      });
    }
    return res.json(data);
  } catch (err) {
    console.error('Twilio get message error:', err);
    return res.status(502).json({ message: 'Failed to reach Twilio API.' });
  }
});

app.get('/twilio/media/:filename', async (req, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  const filename = sanitizeMediaFilename(req.params.filename);
  if (!rawUrl || !isAllowedMediaUrl(rawUrl)) {
    return res.status(400).send('Invalid media URL');
  }

  try {
    const upstream = await fetch(rawUrl);
    if (!upstream.ok) {
      return res.status(upstream.status).send('Media unavailable');
    }
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Content-Disposition', contentDispositionFilename(filename));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(body);
  } catch (err) {
    console.error('Twilio media proxy error:', err);
    return res.status(502).send('Failed to fetch media');
  }
});

app.post('/twilio/messages', async (req, res) => {
  const auth = twilioBasicAuthHeader();
  if (!auth) {
    return res.status(503).json({ message: 'Twilio is not configured on this server.' });
  }

  const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
  const bodyText = typeof req.body?.body === 'string' ? req.body.body : '';
  const mediaUrl = typeof req.body?.mediaUrl === 'string' ? req.body.mediaUrl.trim() : '';
  const mediaFilename = sanitizeMediaFilename(
    typeof req.body?.mediaFilename === 'string' ? req.body.mediaFilename : undefined
  );
  const requestedTemplateSid =
    typeof req.body?.templateSid === 'string' && req.body.templateSid.trim()
      ? req.body.templateSid.trim()
      : '';
  const from =
    typeof req.body?.from === 'string' && req.body.from.trim()
      ? req.body.from.trim()
      : TWILIO_WHATSAPP_FROM || '';
  const messagingServiceSid =
    typeof req.body?.messagingServiceSid === 'string' && req.body.messagingServiceSid.trim()
      ? req.body.messagingServiceSid.trim()
      : TWILIO_MESSAGING_SERVICE_SID || '';

  const hasBody = Boolean(String(bodyText || '').trim());
  const hasMedia = Boolean(mediaUrl);
  const templateSid = requestedTemplateSid || (hasMedia ? DEFAULT_WHATSAPP_DOCUMENT_TEMPLATE_SID : '');

  if (!to || (!hasBody && !hasMedia)) {
    return res.status(400).json({
      message: `Missing required fields (Twilio send): toPresent=${Boolean(to)} hasBody=${hasBody} hasMedia=${hasMedia}`,
    });
  }
  if (!messagingServiceSid && !from) {
    return res.status(400).json({
      message:
        'Provide `from` or `messagingServiceSid` in the request body, or set TWILIO_MESSAGING_SERVICE_SID / TWILIO_WHATSAPP_FROM in server .env.',
    });
  }
  if (hasMedia && !isAllowedMediaUrl(mediaUrl)) {
    return res.status(400).json({
      message: 'mediaUrl must be an https URL on Firebase Storage / Google Cloud Storage.',
    });
  }
  if (templateSid && !isValidTwilioContentSid(templateSid)) {
    return res.status(400).json({ message: 'Invalid Twilio template/content SID.' });
  }

  const params = new URLSearchParams();
  const publicMediaUrl = hasMedia ? getPublicMediaUrl(req, mediaUrl, mediaFilename) : '';
  const templateVariables = readTemplateVariables(req.body?.templateVariables);
  if (hasMedia && !templateVariables['1']) templateVariables['1'] = publicMediaUrl;
  if (hasMedia && !templateVariables['2']) templateVariables['2'] = mediaFilename;
  if (hasBody && !templateVariables['3']) templateVariables['3'] = bodyText.trim();

  params.set('To', to);
  if (templateSid) {
    params.set('ContentSid', templateSid);
    if (Object.keys(templateVariables).length) {
      params.set('ContentVariables', JSON.stringify(templateVariables));
    }
  } else if (hasBody) params.set('Body', bodyText);
  else if (hasMedia) params.set('Body', ' ');
  if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
  else params.set('From', from);
  if (hasMedia && !templateSid) params.set('MediaUrl', publicMediaUrl);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    TWILIO_ACCOUNT_SID
  )}/Messages.json`;

  try {
    const apiRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const text = await apiRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ message: 'Unexpected Twilio response', raw: text.slice(0, 500) });
    }
    if (!apiRes.ok) {
      return res.status(apiRes.status).json({
        message: data.message || data.more_info || 'Twilio send failed',
        code: data.code,
        raw: data,
      });
    }
    return res.status(201).json(data);
  } catch (err) {
    console.error('Twilio send message error:', err);
    return res.status(502).json({ message: 'Failed to reach Twilio API.' });
  }
});

const FOLDER_ID = '1OoNyMiea8Y-duXDisTat-TlC5e8WtWYe';

const N8N_API_URL = process.env.N8N_API_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;

// Load service account
const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json', // path to your JSON key
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});
const drive = google.drive({ version: 'v3', auth });

// Simple health check
app.get('/', (_req, res) => {
  res.send('Drive upload API is running. Use POST /upload.');
});

// Proxy to n8n executions API (single execution) so the frontend can avoid CORS issues
app.get('/n8n/executions/:id', async (req, res) => {
  if (!N8N_API_URL || !N8N_API_KEY) {
    return res
      .status(500)
      .json({ message: 'N8N_API_URL or N8N_API_KEY is not configured on the server.' });
  }

  const { id } = req.params;
  const base = N8N_API_URL.replace(/\/$/, '');
  const url = `${base}/api/v1/executions/${encodeURIComponent(id)}?includeData=true`;

  try {
    const apiRes = await fetch(url, {
      headers: { 'X-N8N-API-KEY': N8N_API_KEY }
    });

    const body = await apiRes.text();

    res.status(apiRes.status);
    // Try to forward JSON if possible, otherwise send raw text
    try {
      res.json(JSON.parse(body));
    } catch {
      res.send(body);
    }
  } catch (error) {
    console.error('Error proxying n8n execution:', error);
    res.status(500).json({ message: 'Failed to fetch execution from n8n.' });
  }
});

// Proxy to n8n executions list so the frontend can show recent runs
app.get('/n8n/executions', async (req, res) => {
  if (!N8N_API_URL || !N8N_API_KEY) {
    return res
      .status(500)
      .json({ message: 'N8N_API_URL or N8N_API_KEY is not configured on the server.' });
  }

  const limit = Number.parseInt(req.query.limit, 10);
  const take = Number.isFinite(limit) && limit > 0 && limit <= 100 ? limit : 10;

  const base = N8N_API_URL.replace(/\/$/, '');
  const url = `${base}/api/v1/executions?limit=${encodeURIComponent(take)}`;

  try {
    const apiRes = await fetch(url, {
      headers: { 'X-N8N-API-KEY': N8N_API_KEY }
    });

    const body = await apiRes.text();

    res.status(apiRes.status);
    try {
      res.json(JSON.parse(body));
    } catch {
      res.send(body);
    }
  } catch (error) {
    console.error('Error proxying n8n executions list:', error);
    res.status(500).json({ message: 'Failed to fetch executions list from n8n.' });
  }
});

// Upload endpoint used by the React app
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Missing file' });
    }

    const filePath = req.file.path;

    const driveRes = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        parents: [FOLDER_ID],
      },
      media: {
        mimeType: req.file.mimetype,
        body: fs.createReadStream(filePath),
      },
      fields: 'id, webViewLink, webContentLink',
    });

    fs.unlink(filePath, () => {}); // clean temp file

    res.json({
      fileId: driveRes.data.id,
      webViewLink: driveRes.data.webViewLink,
      webContentLink: driveRes.data.webContentLink,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Upload failed', error: err.message });
  }
});

app.listen(3001, () => {
  console.log('Drive upload API listening on http://localhost:3001');
});
