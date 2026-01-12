import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for web-client E2E tests
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests/e2e-browser',

  /* Run tests in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only - reduced for faster CI */
  retries: process.env.CI ? 1 : 0,

  /* Use single worker on CI for stability */
  workers: process.env.CI ? 1 : undefined,

  /* Global timeout for each test - prevents runaway tests */
  timeout: 30000,

  /* Expect timeout - faster assertions */
  expect: {
    timeout: 5000,
  },

  /* Reporter configuration */
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],

  /* Shared settings for all projects */
  use: {
    /* Base URL for navigation */
    baseURL: 'http://localhost:3847',

    /* Collect trace when retrying failed test */
    trace: 'on-first-retry',

    /* Take screenshot on failure */
    screenshot: 'only-on-failure',
  },

  /* Configure projects for cross-browser testing */
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

  /* Run local dev server before starting the tests */
  webServer: {
    command: process.env.CI ? 'npm run preview' : 'npm run dev',
    url: 'http://localhost:3847',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
