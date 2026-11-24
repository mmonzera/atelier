import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const hmrClientPort = Number(process.env.VITE_HMR_CLIENT_PORT) || undefined;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@atelier/contracts': path.resolve(__dirname, '../packages/contracts/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    hmr: hmrClientPort ? { clientPort: hmrClientPort } : undefined,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
