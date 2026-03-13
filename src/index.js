const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const cors = require('cors');

const upload = multer({ dest: 'uploads/' });
const app = express();

// Allow the React dev server to call this API
app.use(
  cors({
    origin: 'http://localhost:5173',
  })
);

const FOLDER_ID = '1OoNyMiea8Y-duXDisTat-TlC5e8WtWYe';

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