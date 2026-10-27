import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: 'oracle-app-live',
    include: ['live/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 90_000,
  },
});
