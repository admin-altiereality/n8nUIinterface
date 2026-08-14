/**
 * Fallback production build when Vite hangs on this host.
 * JS via esbuild; CSS via Tailwind CLI.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const assets = path.join(dist, 'assets');
dotenv.config({ path: path.join(root, '.env') });

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(assets, { recursive: true });

const jsOut = path.join(assets, 'index.js');
const cssOut = path.join(assets, 'index.css');
const IMPORT_MAP = {
  imports: {
    react: 'https://esm.sh/react@18.3.1',
    'react/jsx-runtime': 'https://esm.sh/react@18.3.1/jsx-runtime',
    'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1',
    'react-router-dom': 'https://esm.sh/react-router-dom@7.13.2?deps=react@18.3.1,react-dom@18.3.1',
    'firebase/app': 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js',
    'firebase/auth': 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js',
    'firebase/firestore': 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js',
    'firebase/storage': 'https://www.gstatic.com/firebasejs/12.11.0/firebase-storage.js',
    'lucide-react': 'https://esm.sh/lucide-react@0.577.0?deps=react@18.3.1',
    'class-variance-authority': 'https://esm.sh/class-variance-authority@0.7.1',
  },
};
const PUBLIC_VITE_KEYS = new Set([
  'VITE_AUTH_FIREBASE_API_KEY',
  'VITE_FIREBASE_API_KEY',
]);
const SECRET_LIKE_VITE_KEY = /(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CLIENT_SECRET)/i;
const SOURCE_VITE_KEYS = new Set([
  'VITE_API_PROXY_URL',
  'VITE_AUTH_FIREBASE_API_KEY',
  'VITE_AUTH_FIREBASE_APP_ID',
  'VITE_AUTH_FIREBASE_AUTH_DOMAIN',
  'VITE_AUTH_FIREBASE_MEASUREMENT_ID',
  'VITE_AUTH_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_AUTH_FIREBASE_PROJECT_ID',
  'VITE_AUTH_FIREBASE_STORAGE_BUCKET',
  'VITE_ENABLE_DATA_AUTH_BRIDGE',
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_APP_ID',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_MEASUREMENT_ID',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_N8N_SALES_FUNNEL_URL',
  'VITE_N8N_SALES_WORKFLOW_ID',
  'VITE_N8N_WEBHOOK_URL',
  'VITE_N8N_WORKFLOW_ID',
  'VITE_UPLOAD_API_URL',
]);

function getBrowserViteEnv() {
  const entries = Object.entries(process.env).filter(([key]) => key.startsWith('VITE_'));
  const blocked = entries
    .map(([key]) => key)
    .filter((key) => SECRET_LIKE_VITE_KEY.test(key) && !PUBLIC_VITE_KEYS.has(key));
  if (blocked.length) {
    throw new Error(
      `Refusing to expose secret-like VITE_ env var(s) in the browser bundle: ${blocked.join(', ')}`
    );
  }
  return Object.fromEntries(entries);
}

function createViteEnvDefines() {
  const viteEnv = getBrowserViteEnv();
  const define = {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env.BASE_URL': '"/"',
    'import.meta.env.PROD': 'true',
    'import.meta.env.DEV': 'false',
    'import.meta.env.SSR': 'false',
  };

  for (const [key, value] of Object.entries(viteEnv)) {
    define[`import.meta.env.${key}`] = JSON.stringify(value);
  }
  for (const key of SOURCE_VITE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(viteEnv, key)) {
      define[`import.meta.env.${key}`] = 'undefined';
    }
  }

  return define;
}

console.log('Bundling JS with esbuild…');
try {
  const define = createViteEnvDefines();
  const esbuildArgs = [
    path.join(root, 'src/main.tsx'),
    '--bundle',
    `--outfile=${jsOut}`,
    '--format=esm',
    '--jsx=automatic',
    '--platform=browser',
    '--target=es2020',
    '--minify',
    '--log-level=info',
    '--loader:.css=empty',
    '--loader:.svg=dataurl',
    '--loader:.png=dataurl',
    '--loader:.jpg=dataurl',
    '--loader:.jpeg=dataurl',
    '--loader:.gif=dataurl',
    '--loader:.webp=dataurl',
    ...Object.keys(IMPORT_MAP.imports).map((key) => `--external:${key}`),
    ...Object.entries(define).map(([key, value]) => `--define:${key}=${value}`),
  ];
  execFileSync(path.join(root, 'node_modules/.bin/esbuild'), esbuildArgs, {
    cwd: root,
    stdio: 'inherit',
  });

  console.log('Building CSS with Tailwind CLI…');
  try {
    execFileSync(
      path.join(root, 'node_modules/.bin/tailwindcss'),
      ['-i', path.join(root, 'src/styles.css'), '-o', cssOut, '--minify'],
      { cwd: root, stdio: 'inherit', timeout: 45_000 }
    );
  } catch (cssErr) {
    console.warn('Tailwind CLI did not finish; reusing currently deployed production CSS.');
    try {
      execFileSync(
        'curl',
        ['-fsS', 'https://agents-altiereality-com.web.app/assets/index.css', '-o', cssOut],
        { cwd: root, stdio: 'inherit', timeout: 20_000 }
      );
    } catch {
      console.warn('Deployed CSS is unavailable; emitting local custom CSS without Tailwind directives.');
      const sourceCss = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
      const fallbackCss = sourceCss
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('@import \'tailwindcss\'') && !line.trim().startsWith('@source '))
        .join('\n');
      fs.writeFileSync(cssOut, fallbackCss);
    }
  }

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>LearnXR Platform — AI-Powered Lesson Builder</title>
    <meta name="description" content="Enterprise VR lesson generation, sales funnel automation, and WhatsApp messaging for the LearnXR platform." />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#09090b" />
    <link rel="stylesheet" href="/assets/index.css" />
    <script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/index.js"></script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(dist, 'index.html'), html);
  const js = fs.readFileSync(jsOut, 'utf8');
  if (js.includes('import.meta.env')) {
    throw new Error('Build left unresolved import.meta.env references in the browser bundle.');
  }
  const forbiddenFragments = [
    'VITE_N8N_API_KEY',
    'VITE_N8N_ACCESS_TOKEN',
    'X-N8N-API-KEY',
    process.env.N8N_API_KEY,
    process.env.N8N_ACCESS_TOKEN,
  ].filter(Boolean);
  const leaked = forbiddenFragments.filter((fragment) => js.includes(fragment));
  if (leaked.length) {
    throw new Error('Build output contains n8n API credential material.');
  }
  console.log('Build complete → dist/');
} catch (err) {
  const raw = err && err.message ? String(err.message) : String(err);
  const redacted = Object.entries(process.env).reduce((message, [key, value]) => {
    if (!key.startsWith('VITE_') || !value) return message;
    return message.split(value).join(`[${key}]`);
  }, raw);
  console.error(redacted);
  process.exit(1);
}
