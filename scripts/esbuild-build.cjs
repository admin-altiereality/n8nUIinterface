/**
 * Fallback production build when Vite hangs on this host.
 * JS via esbuild; CSS via Tailwind CLI.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const dotenv = require('dotenv');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const assets = path.join(dist, 'assets');
dotenv.config({ path: path.join(root, '.env') });

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(assets, { recursive: true });

const jsOut = path.join(assets, 'index.js');
const cssOut = path.join(assets, 'index.css');
const PUBLIC_VITE_KEYS = new Set([
  'VITE_AUTH_FIREBASE_API_KEY',
  'VITE_FIREBASE_API_KEY',
]);
const SECRET_LIKE_VITE_KEY = /(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CLIENT_SECRET)/i;

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
    'import.meta.env': JSON.stringify({
      ...viteEnv,
      MODE: 'production',
      BASE_URL: '/',
      PROD: true,
      DEV: false,
      SSR: false,
    }),
  };

  for (const [key, value] of Object.entries(viteEnv)) {
    define[`import.meta.env.${key}`] = JSON.stringify(value);
  }

  return define;
}

console.log('Bundling JS with esbuild…');
(async () => {
try {
  const define = createViteEnvDefines();
  await esbuild.build({
    entryPoints: [path.join(root, 'src/main.tsx')],
    bundle: true,
    outfile: jsOut,
    format: 'esm',
    jsx: 'automatic',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    loader: {
      '.css': 'empty',
      '.svg': 'dataurl',
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.jpeg': 'dataurl',
      '.gif': 'dataurl',
      '.webp': 'dataurl',
    },
    define,
    logLevel: 'info',
  });

  console.log('Building CSS with Tailwind CLI…');
  execFileSync(
    path.join(root, 'node_modules/.bin/tailwindcss'),
    ['-i', path.join(root, 'src/styles.css'), '-o', cssOut, '--minify'],
    { cwd: root, stdio: 'inherit' }
  );

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>LearnXR Platform — AI-Powered Lesson Builder</title>
    <meta name="description" content="Enterprise VR lesson generation, sales funnel automation, and WhatsApp messaging for the LearnXR platform." />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#09090b" />
    <link rel="stylesheet" href="/assets/index.css" />
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
  console.error(err);
  process.exit(1);
}
})();
