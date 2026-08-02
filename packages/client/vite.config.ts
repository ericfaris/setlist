import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two builds from one codebase: the player UI (index.html) and the TV receiver
// UI (receiver.html). The dev proxy below is what makes `npm run dev` a
// single-origin experience — the client talks to /api and /socket on :5173 and
// Vite forwards both to the Node server on :3001.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@music-trivia/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        player: resolve(__dirname, 'index.html'),
        receiver: resolve(__dirname, 'receiver.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/socket': { target: 'http://localhost:3001', ws: true },
      '/api': { target: 'http://localhost:3001' },
    },
  },
});
