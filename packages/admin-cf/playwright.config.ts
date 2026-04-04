import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-playwright',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  globalSetup: './tests/e2e-playwright/global-setup.ts',
  globalTeardown: './tests/e2e-playwright/global-teardown.ts',
  use: {
    baseURL: process.env.ADMIN_URL || 'http://localhost:8787',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
