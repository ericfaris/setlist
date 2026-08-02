import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
  resolve: {
    alias: {
      '@music-trivia/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
