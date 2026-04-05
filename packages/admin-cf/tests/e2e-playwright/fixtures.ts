import * as fs from 'node:fs';
import * as path from 'node:path';
import { test as base, expect, type Page } from '@playwright/test';

/** Env-configurable base URL for the admin dashboard */
export const BASE_URL = process.env.ADMIN_URL || 'http://localhost:8787';

/** Credentials — override via env for QA/staging */
export const ADMIN_USER = process.env.ADMIN_USER || 'playwright-admin';
export const ADMIN_PASS = process.env.ADMIN_PASS || 'PlaywrightTest!2026secure';

/** Path to the cached auth token written by global-setup */
const TOKEN_FILE = path.join(import.meta.dirname, '.auth-token');

/**
 * Read the JWT token cached by global-setup.
 */
export function getAuthToken(): string {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error(
      'Auth token file not found. Did global-setup run? ' +
      'Make sure globalSetup is configured in playwright.config.ts'
    );
  }
  return fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
}

/**
 * Inject the JWT token into the page's localStorage and navigate to admin.
 *
 * Strategy: use addInitScript to set localStorage BEFORE the page JS runs.
 * This avoids the race where the app's useEffect fires before we can inject.
 */
async function injectAuthAndNavigate(page: Page, hash = ''): Promise<void> {
  const token = getAuthToken();

  // Add an init script that runs before any page JS.
  // This sets the token in localStorage so the app picks it up immediately.
  await page.addInitScript((t) => {
    localStorage.setItem('zajel_admin_token', t);
  }, token);

  // Navigate — the init script will have set the token before app JS runs
  await page.goto(`/admin/${hash}`);

  // Wait for the dashboard to render
  await expect(page.locator('.tabs')).toBeVisible({ timeout: 15_000 });
}

/**
 * Log in via the UI (for auth-specific tests only).
 * Uses a single login — call sparingly to avoid rate limits.
 */
export async function loginViaUI(page: Page): Promise<void> {
  await page.goto('/admin/');
  await page.evaluate(() => localStorage.removeItem('zajel_admin_token'));
  await page.reload();

  await page.fill('input[name="username"]', ADMIN_USER);
  await page.fill('input[name="password"]', ADMIN_PASS);
  await page.click('button[type="submit"]');

  await expect(page.locator('.tabs')).toBeVisible({ timeout: 10_000 });
}

// ── Custom fixtures ──────────────────────────────────────────

type AdminFixtures = {
  /** Page already authenticated via token injection */
  authedPage: Page;
  /** JWT token for direct API calls */
  authToken: string;
};

export const test = base.extend<AdminFixtures>({
  authedPage: async ({ page }, use) => {
    await injectAuthAndNavigate(page);
    await use(page);
  },
  authToken: async ({}, use) => {
    const token = getAuthToken();
    await use(token);
  },
});

export { expect };
