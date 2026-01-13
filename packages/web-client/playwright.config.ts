import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
// Use 127.0.0.1 instead of localhost for secure context in Firefox/WebKit
// Loopback IP addresses are treated as secure contexts by all browsers
const baseURL = 'http://127.0.0.1:3847';

/**
 * Playwright configuration for web-client E2E tests
 * Uses 127.0.0.1 for Web Crypto API secure context requirement
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
      use: {
        ...devices['Desktop Firefox'],
        // Ensure localhost is treated as secure context
        launchOptions: {
          firefoxUserPrefs: {
            'dom.securecontext.allowlist_onions': true,
            'network.proxy.allow_hijacking_localhost': false,
          },
        },
      },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  webServer: {
    command: isCI ? 'npm run preview -- --host 127.0.0.1' : 'npm run dev -- --host 127.0.0.1',
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120000,
  },
});
