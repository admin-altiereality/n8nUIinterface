const dotenv = require('dotenv');

dotenv.config();

const publicViteKeys = new Set([
  'VITE_AUTH_FIREBASE_API_KEY',
  'VITE_FIREBASE_API_KEY',
]);

const secretLikeKey = /(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CLIENT_SECRET)/i;

const blocked = Object.keys(process.env)
  .filter((key) => key.startsWith('VITE_'))
  .filter((key) => secretLikeKey.test(key) && !publicViteKeys.has(key));

if (blocked.length) {
  console.error(
    `Refusing to expose secret-like VITE_ env var(s) in the browser bundle: ${blocked.join(', ')}`
  );
  process.exit(1);
}
