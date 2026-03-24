import * as fs from 'node:fs';
import * as path from 'node:path';

const BASE_URL = process.env.ADMIN_URL || 'http://localhost:8787';
const ADMIN_USER = process.env.ADMIN_USER || 'playwright-admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'PlaywrightTest!2026secure';

/** Path to the cached auth token file, shared between global setup and tests */
export const TOKEN_FILE = path.join(import.meta.dirname, '.auth-token');

/**
 * Playwright global setup — runs once before all tests.
 * Ensures the admin system is initialized, obtains a JWT token,
 * and writes it to a temp file so test workers can read it
 * without additional login API calls.
 */
async function globalSetup() {
  console.log('[global-setup] Ensuring admin user exists...');

  // Try to init (first super-admin)
  const initRes = await fetch(`${BASE_URL}/admin/api/auth/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  await initRes.json();

  // Login to get a JWT token
  const loginRes = await fetch(`${BASE_URL}/admin/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const loginBody = await loginRes.json() as { success: boolean; data?: { token: string }; error?: string };

  if (!loginBody.success || !loginBody.data?.token) {
    throw new Error(`Global setup: login failed: ${JSON.stringify(loginBody)}`);
  }

  // Write token to disk for test workers to read
  fs.writeFileSync(TOKEN_FILE, loginBody.data.token, 'utf-8');
  console.log('[global-setup] Auth token cached. Ready.');
}

export default globalSetup;
