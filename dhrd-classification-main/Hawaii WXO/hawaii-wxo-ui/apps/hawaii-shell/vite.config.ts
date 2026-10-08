import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const uiSrc = (p: string) =>
  fileURLToPath(new URL(`../../packages/ui/src/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: 'wxo-custom-ui/styles.css',   replacement: uiSrc('styles.css') },
      { find: 'wxo-custom-ui/form-engine',  replacement: uiSrc('form-engine/index.ts') },
      { find: 'wxo-custom-ui/app-shell',    replacement: uiSrc('app-shell/index.ts') },
      { find: 'wxo-custom-ui',              replacement: uiSrc('index.ts') },
    ],
  },
  server: {
    // Dev proxy: Vite on :5174 (different from TKO's :5173 so both can run together)
    port: 5174,
    proxy: {
      '/api': 'http://localhost:8081',  // Hawaii proxy on :8081 (TKO uses :8080)
    },
  },
});
