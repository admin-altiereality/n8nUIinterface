import { defineConfig } from 'vite';

// Use esbuild JSX transform (avoid @vitejs/plugin-react-swc hang on this host).
export default defineConfig(({ command }) => ({
  esbuild: {
    jsx: 'automatic',
    // Production bundles ship no console output or debugger statements; `vite` dev keeps them.
    drop: command === 'build' ? ['console', 'debugger'] : [],
  },
  server: {
    port: 5173,
  },
}));
