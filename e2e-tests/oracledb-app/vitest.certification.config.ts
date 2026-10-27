import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    name: 'oracle-certification',
    include: ['tests/**/*.test.ts', 'certification/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
