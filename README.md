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

## Build

```bash
npm run build
```

## Tech

- React 18, Vite 5, TypeScript
