import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for web-client E2E tests
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests/e2e-browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    // Use HTTPS in CI for Web Crypto API secure context
    baseURL: process.env.CI ? 'https://localhost:3847' : 'http://localhost:3847',
    // Accept self-signed certs in CI
    ignoreHTTPSErrors: !!process.env.CI,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  webServer: {
    command: process.env.CI ? 'npm run preview' : 'npm run dev',
    url: process.env.CI ? 'https://localhost:3847' : 'http://localhost:3847',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    ignoreHTTPSErrors: true,
  },
});
