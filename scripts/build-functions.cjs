/**
 * Fast function builder using esbuild.
 * Avoids tsc file-system delays on hosts with cloud-synced Desktop directories.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const fnDir = path.join(root, 'functions');
const libDir = path.join(fnDir, 'lib');
const srcDir = path.join(fnDir, 'src');

if (!fs.existsSync(libDir)) {
  fs.mkdirSync(libDir, { recursive: true });
}

const esbuildPath = path.join(root, 'node_modules/.bin/esbuild');
const srcFiles = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => path.join(srcDir, f));

console.log(`Compiling ${srcFiles.length} TypeScript function files with esbuild…`);
execFileSync(
  esbuildPath,
  [
    ...srcFiles,
    `--outdir=${libDir}`,
    '--platform=node',
    '--target=node22',
    '--format=cjs',
    '--log-level=info',
  ],
  { stdio: 'inherit' }
);
console.log('Function build complete → functions/lib/');
