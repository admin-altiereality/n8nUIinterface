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

const FOLDER_ID = '1OoNyMiea8Y-duXDisTat-TlC5e8WtWYe';

const N8N_API_URL = process.env.VITE_N8N_API_URL;
const N8N_API_KEY = process.env.VITE_N8N_API_KEY;

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