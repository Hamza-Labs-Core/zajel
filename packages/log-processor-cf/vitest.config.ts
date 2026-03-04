import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    maxWorkers: 1,
    isolate: false,
    globals: true,
    reporters: ['verbose'],
  },
});
