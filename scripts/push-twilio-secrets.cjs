/**
 * Syncs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN from the repo root .env
 * into Firebase Functions secrets (Secret Manager). Does not print secret values.
 *
 * Usage: node scripts/push-twilio-secrets.cjs
 * Requires: firebase CLI, firebase login, .env at project root
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
const token = process.env.TWILIO_AUTH_TOKEN?.trim();

if (!sid || !token) {
  console.error(
    'Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in .env (project root).'
  );
  process.exit(1);
}

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(root, '.tmp-twilio-secret-'));
const sidFile = path.join(dir, 'sid');
const tokenFile = path.join(dir, 'token');

try {
  fs.writeFileSync(sidFile, sid, 'utf8');
  fs.writeFileSync(tokenFile, token, 'utf8');

  execSync(
    `firebase functions:secrets:set TWILIO_ACCOUNT_SID --data-file "${sidFile}" --force`,
    { stdio: 'inherit', cwd: root }
  );
  execSync(
    `firebase functions:secrets:set TWILIO_AUTH_TOKEN --data-file "${tokenFile}" --force`,
    { stdio: 'inherit', cwd: root }
  );

  const msgSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? '';
  const waFrom = process.env.TWILIO_WHATSAPP_FROM?.trim() ?? '';
  const esc = (v) => {
    if (!v) return '';
    if (/[#\s"']/.test(v)) return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return String(v);
  };
  fs.writeFileSync(
    path.join(root, 'functions', '.env'),
    `TWILIO_MESSAGING_SERVICE_SID=${esc(msgSid)}\nTWILIO_WHATSAPP_FROM=${esc(waFrom)}\n`
  );
  console.log('Wrote functions/.env (optional sender defaults for deploy).');

  console.log('\nDone. Redeploy so the api function picks up secrets:');
  console.log('  firebase deploy --only functions\n');
} finally {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
