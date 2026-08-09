import { defineConfig } from 'vite';

// Use esbuild JSX transform (avoid @vitejs/plugin-react-swc hang on this host).
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  server: {
    port: 5173,
  },
});
