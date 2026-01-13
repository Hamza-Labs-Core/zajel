import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
const baseURL = isCI ? 'https://localhost:3847' : 'http://localhost:3847';

/**
 * Playwright configuration for web-client E2E tests
 * Uses HTTPS in CI for Web Crypto API secure context requirement
 */
export default defineConfig({
  testDir: './tests/e2e-browser',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 1 : undefined,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL,
    ignoreHTTPSErrors: isCI,
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
    command: isCI ? 'npm run preview' : 'npm run dev',
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120000,
    ignoreHTTPSErrors: true,
  },
});
