import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@music-trivia/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
