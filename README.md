# LearnXR n8n UI

React webapp to trigger the PDF-to-VR-lesson n8n workflow: upload a chapter PDF, edit the OpenAI prompt, and run the pipeline.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file in the project root:
   ```env
   VITE_N8N_WEBHOOK_URL=https://your-n8n-host/webhook/your-webhook-id
   ```

3. Start the dev server:
   ```bash
   npm run dev
   ```

4. Open http://localhost:5173 — upload a PDF, set the prompt, and click **Start Automation**.

## Sales Funnel Page

Your merged app now includes a second UI:

- Lesson Builder: `/` (default)
- Sales Funnel: `/sales-funnel`

## Firebase (optional backend for Sales Funnel history/logs)

The Sales Funnel page can persist “city runs” and logs to Firebase (instead of only `localStorage`).

Add these values to your `.env` (use your real Firebase project values):

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

If these env vars are not set, the UI will continue working using `localStorage`.

## Build

```bash
npm run build
```

## Deploy to Firebase Hosting (SPA)

Because this is a client-side routed React app, the `firebase.json` rewrite serves `index.html` for `/` and `/sales-funnel`.

1. Make sure `.env` contains your `VITE_N8N_*` values (and optional `VITE_FIREBASE_*` values for Sales Funnel history/logs), then rebuild:
   ```bash
   npm run build
   ```
2. Deploy hosting:
   ```bash
   npx firebase use <YOUR_FIREBASE_PROJECT_ID>
   npx firebase deploy --only hosting
   ```

## Tech

- React 18, Vite 5, TypeScript
