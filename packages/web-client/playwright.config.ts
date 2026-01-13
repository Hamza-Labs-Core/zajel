import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for web-client E2E tests
 * Chromium only - Firefox/WebKit have app compatibility issues
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
    baseURL: 'http://localhost:3847',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Firefox/WebKit disabled - app doesn't render correctly
    // TODO: Fix browser compatibility and re-enable
  ],

  webServer: {
    command: process.env.CI ? 'npm run preview' : 'npm run dev',
    url: 'http://localhost:3847',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
