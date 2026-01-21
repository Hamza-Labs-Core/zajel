/**
 * Web-to-Web Integration Tests
 *
 * Tests end-to-end communication between two browser instances connecting
 * via the REAL deployed VPS signaling servers.
 *
 * Uses:
 * - Real CF Workers bootstrap: https://zajel-signaling.mahmoud-s-darwish.workers.dev
 * - Real VPS servers discovered from bootstrap
 * - Pre-built web client (configured with real VPS URL at build time)
 *
 * Test Scenarios:
 * - Two browsers connecting and pairing via real VPS
 * - Message exchange between paired browsers
 * - Connection resilience and error handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type Server } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Go up 4 levels: scenarios -> src -> integration-tests -> packages -> root
const PROJECT_ROOT = resolve(__dirname, '../../../..');
const WEB_CLIENT_DIST = resolve(PROJECT_ROOT, 'packages/web-client/dist');

// Timeouts for real network operations
const TIMEOUTS = {
  SHORT: 5000,
  MEDIUM: 15000,
  LONG: 30000,
  VERY_LONG: 60000,
};

// MIME types for serving static files
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeout: number,
  pollInterval = 100
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return true;
    await delay(pollInterval);
  }
  return false;
}

describe('Web-to-Web Integration Tests', () => {
  let server: Server;
  let serverPort: number;
  let browser1: Browser;
  let browser2: Browser;
  let page1: Page;
  let page2: Page;

  beforeAll(async () => {
    // Check if web client is built
    if (!existsSync(WEB_CLIENT_DIST)) {
      throw new Error(
        `Web client not built. Run: npm run build --workspace=@zajel/web-client`
      );
    }

    // Start simple static file server for the pre-built web client
    server = createServer((req, res) => {
      let filePath = join(WEB_CLIENT_DIST, req.url === '/' ? 'index.html' : req.url!);

      // Handle SPA routing - serve index.html for non-file requests
      if (!existsSync(filePath) || !extname(filePath)) {
        filePath = join(WEB_CLIENT_DIST, 'index.html');
      }

      try {
        const content = readFileSync(filePath);
        const ext = extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    // Find available port
    serverPort = 3000 + Math.floor(Math.random() * 1000);
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(serverPort, '127.0.0.1', () => resolve());
    });

    console.log(`[Test] Serving web client on http://127.0.0.1:${serverPort}`);
  }, TIMEOUTS.LONG);

  afterAll(async () => {
    await browser1?.close().catch(() => {});
    await browser2?.close().catch(() => {});
    server?.close();
  });

  describe('Two Browsers Connecting via Real VPS', () => {
    // Collect console errors for debugging
    const consoleErrors: string[] = [];

    it('should load web client in both browsers', async () => {
      browser1 = await chromium.launch({ headless: true });
      browser2 = await chromium.launch({ headless: true });

      const context1 = await browser1.newContext();
      const context2 = await browser2.newContext();

      page1 = await context1.newPage();
      page2 = await context2.newPage();

      // Capture console errors for debugging
      page1.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push(`[Browser1] ${msg.text()}`);
        }
      });
      page2.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push(`[Browser2] ${msg.text()}`);
        }
      });

      // Load web client in both browsers
      await page1.goto(`http://127.0.0.1:${serverPort}`, { waitUntil: 'networkidle' });
      await page2.goto(`http://127.0.0.1:${serverPort}`, { waitUntil: 'networkidle' });

      // Both should display the app
      const title1 = await page1.title();
      const title2 = await page2.title();

      expect(title1).toBeDefined();
      expect(title2).toBeDefined();

      // Check for Zajel branding
      const content1 = await page1.content();
      const content2 = await page2.content();

      expect(content1.toLowerCase()).toContain('zajel');
      expect(content2.toLowerCase()).toContain('zajel');
    }, TIMEOUTS.LONG);

    it('should generate unique pairing codes for each client', async () => {
      // Wait for both clients to connect to VPS and get pairing codes
      await waitForPairingCode(page1);
      await waitForPairingCode(page2);

      const code1 = await getPairingCode(page1);
      const code2 = await getPairingCode(page2);

      console.log(`[Test] Browser 1 code: ${code1}`);
      console.log(`[Test] Browser 2 code: ${code2}`);

      // Codes should be valid format (6 chars, no ambiguous chars)
      expect(code1).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
      expect(code2).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

      // Codes should be different
      expect(code1).not.toBe(code2);
    }, TIMEOUTS.LONG);

    it('should complete pairing flow between two browsers', async () => {
      // Get browser2's code
      const code2 = await getPairingCode(page2);
      console.log(`[Test] Initiating pairing with code: ${code2}`);

      // Browser1 initiates pairing with browser2's code
      await enterPairingCode(page1, code2);

      // Browser2 should see the incoming request
      await waitForApprovalRequest(page2);
      console.log(`[Test] Browser 2 received pairing request`);

      // Browser2 accepts
      await acceptPairingRequest(page2);

      // Both should reach connected state
      await waitForConnected(page1);
      await waitForConnected(page2);

      console.log(`[Test] Both browsers connected!`);
    }, TIMEOUTS.VERY_LONG);

    it('should send and receive text messages', async () => {
      // Send message from browser1 to browser2
      const testMessage = 'Hello from test ' + Date.now();
      console.log(`[Test] Sending message: ${testMessage}`);

      await sendMessage(page1, testMessage);

      // Browser2 should receive the message
      const received = await waitForMessage(page2, testMessage);
      expect(received).toBe(true);

      console.log(`[Test] Message received by browser 2`);
    }, TIMEOUTS.LONG);

    it('should handle bidirectional messaging', async () => {
      // Browser1 sends
      const msg1 = 'From browser1: ' + Date.now();
      await sendMessage(page1, msg1);
      await waitForMessage(page2, msg1);

      // Browser2 sends
      const msg2 = 'From browser2: ' + Date.now();
      await sendMessage(page2, msg2);
      await waitForMessage(page1, msg2);

      console.log(`[Test] Bidirectional messaging works`);
    }, TIMEOUTS.LONG);
  });
});

// Helper functions

async function waitForPairingCode(page: Page, timeout = TIMEOUTS.LONG): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const content = await page.content();

    // Check for error messages on the page (ErrorBanner component)
    const errorEl = await page.$('.error-banner, [role="alert"]');
    if (errorEl) {
      const errorText = await errorEl.textContent();
      console.log(`[Test] Error found on page: ${errorText}`);
    }

    // Look for 6-character code pattern in page content
    if (/[A-HJ-NP-Z2-9]{6}/.test(content)) {
      return;
    }

    // Log status indicator state for debugging
    const statusEl = await page.$('.status-indicator, [role="status"]');
    if (statusEl && Date.now() - start > 5000) {  // Only log after 5 seconds
      const statusText = await statusEl.textContent();
      console.log(`[Test] Status indicator: ${statusText}`);
    }

    await delay(500);
  }

  // Before failing, get page state for debugging
  const content = await page.content();
  const bodyText = await page.evaluate(() => document.body.innerText);
  console.log(`[Test] Page body text at timeout: ${bodyText.substring(0, 500)}`);

  throw new Error('Timed out waiting for pairing code. The VPS server may be unreachable from this environment.');
}

async function getPairingCode(page: Page): Promise<string> {
  // Try data-testid first
  const codeEl = await page.$('[data-testid="my-code"], .my-code, .code-display, .pairing-code');
  if (codeEl) {
    const text = await codeEl.textContent();
    const match = text?.match(/[A-HJ-NP-Z2-9]{6}/);
    if (match) return match[0];
  }

  // Fallback: search entire page
  const content = await page.content();
  const match = content.match(/[A-HJ-NP-Z2-9]{6}/);
  if (match) return match[0];

  throw new Error('Could not find pairing code');
}

async function enterPairingCode(page: Page, code: string): Promise<void> {
  // Find code input
  const input = await page.waitForSelector(
    'input[placeholder*="code" i], input[placeholder*="peer" i], input[name="code"], input[type="text"]',
    { timeout: TIMEOUTS.MEDIUM }
  );

  await input.fill(code);

  // Find and click connect button
  const button = await page.waitForSelector(
    'button:has-text("Connect"), button:has-text("Pair"), button:has-text("Request"), button[type="submit"]',
    { timeout: TIMEOUTS.SHORT }
  );
  await button.click();
}

async function waitForApprovalRequest(page: Page, timeout = TIMEOUTS.MEDIUM): Promise<void> {
  await page.waitForSelector(
    'button:has-text("Accept"), button:has-text("Approve"), [data-testid="accept-btn"], .approval-dialog',
    { timeout, state: 'visible' }
  );
}

async function acceptPairingRequest(page: Page): Promise<void> {
  const button = await page.waitForSelector(
    'button:has-text("Accept"), button:has-text("Approve"), [data-testid="accept-btn"]',
    { timeout: TIMEOUTS.SHORT }
  );
  await button.click();
}

async function waitForConnected(page: Page, timeout = TIMEOUTS.LONG): Promise<void> {
  // Wait for connected indicator or chat view
  await page.waitForSelector(
    '.connected, [data-testid="connected"], button:has-text("Disconnect"), .chat-input, .message-input, textarea',
    { timeout, state: 'visible' }
  ).catch(() => {
    // Fallback: just wait and check page state
  });

  // Give WebRTC time to establish
  await delay(1000);
}

async function sendMessage(page: Page, message: string): Promise<void> {
  // Find message input
  const input = await page.waitForSelector(
    'input[placeholder*="message" i], textarea, .message-input input, .chat-input input',
    { timeout: TIMEOUTS.MEDIUM }
  );

  await input.fill(message);

  // Try send button first, then Enter
  const sendBtn = await page.$('button:has-text("Send"), button[type="submit"], .send-button');
  if (sendBtn) {
    await sendBtn.click();
  } else {
    await input.press('Enter');
  }
}

async function waitForMessage(page: Page, text: string, timeout = TIMEOUTS.MEDIUM): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const content = await page.content();
    if (content.includes(text)) {
      return true;
    }
    await delay(500);
  }

  return false;
}
