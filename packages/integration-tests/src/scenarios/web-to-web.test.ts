/**
 * Web-to-Web Integration Tests
 *
 * Tests end-to-end communication between two browser instances connecting
 * via the VPS signaling server. This is the most comprehensive cross-app
 * integration test as we can fully control two Playwright browser instances.
 *
 * Test Scenarios:
 * - Two browsers connecting and pairing via VPS
 * - Message exchange between paired browsers
 * - Connection resilience and error handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestOrchestrator, delay, waitFor, TIMEOUTS, isCI, safeCleanup } from '../orchestrator';
import type { Page } from 'playwright';

// TODO: Fix web client tests - Vite isn't picking up the dynamic signaling URL from .env file
// The test infrastructure works but the web client doesn't connect to the test VPS server
// This needs to be fixed by either:
// 1. Using Vite's --define flag to inject the URL at build time
// 2. Using a different env loading mechanism
// 3. Building the web client with the test URL before running tests
describe.skip('Web-to-Web Integration Tests', () => {
  let orchestrator: TestOrchestrator;
  let webClientPort: number;

  beforeAll(async () => {
    orchestrator = new TestOrchestrator({
      headless: true,
      verbose: process.env.LOG_LEVEL !== 'error',
      startupTimeout: TIMEOUTS.STARTUP,
    });

    // Start mock bootstrap and VPS server
    await orchestrator.startMockBootstrap();
    await orchestrator.startVpsServer();

    // Start web client dev server
    webClientPort = await orchestrator.startWebClient();
  }, TIMEOUTS.VERY_LONG);

  afterAll(async () => {
    await safeCleanup(() => orchestrator.cleanup(), 'orchestrator');
  }, TIMEOUTS.LONG);

  describe('Two Browsers Connecting via VPS', () => {
    it('should load web client in both browsers', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        // Both browsers should load the web client
        await expect(browser1.page.title()).resolves.toBeDefined();
        await expect(browser2.page.title()).resolves.toBeDefined();

        // Both should display the app header
        const header1 = await browser1.page.locator('header h1').textContent();
        const header2 = await browser2.page.locator('header h1').textContent();

        expect(header1).toContain('Zajel');
        expect(header2).toContain('Zajel');
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);

    it('should generate unique pairing codes for each client', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        // Wait for both clients to connect and get pairing codes
        await waitForPairingCode(browser1.page);
        await waitForPairingCode(browser2.page);

        const code1 = await getPairingCode(browser1.page);
        const code2 = await getPairingCode(browser2.page);

        // Codes should be valid format and different
        expect(code1).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
        expect(code2).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
        expect(code1).not.toBe(code2);
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);

    it('should complete pairing flow between two browsers', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        // Wait for both to be ready
        await waitForPairingCode(browser1.page);
        await waitForPairingCode(browser2.page);

        // Get browser2's code
        const code2 = await getPairingCode(browser2.page);

        // Browser1 initiates pairing with browser2's code
        await enterPairingCode(browser1.page, code2);

        // Browser2 should see the incoming request and accept
        await waitForApprovalRequest(browser2.page);
        await acceptPairingRequest(browser2.page);

        // Both should reach connected state
        await waitForConnected(browser1.page);
        await waitForConnected(browser2.page);

        // Verify connected status is shown
        const status1 = await browser1.page.locator('.status.connected').isVisible();
        const status2 = await browser2.page.locator('.status.connected').isVisible();

        expect(status1).toBe(true);
        expect(status2).toBe(true);
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);

    it('should handle pairing rejection', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        await waitForPairingCode(browser1.page);
        await waitForPairingCode(browser2.page);

        const code2 = await getPairingCode(browser2.page);

        // Browser1 initiates pairing
        await enterPairingCode(browser1.page, code2);

        // Browser2 rejects
        await waitForApprovalRequest(browser2.page);
        await rejectPairingRequest(browser2.page);

        // Browser1 should return to registered state (not connected)
        await delay(1000);

        // Check that we're not in connected state
        const connected1 = await browser1.page.locator('.status.connected').isVisible().catch(() => false);
        expect(connected1).toBe(false);
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);
  });

  describe('Message Exchange Between Paired Browsers', () => {
    it('should send and receive text messages', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        // Complete pairing
        await completePairing(browser1.page, browser2.page);

        // Send message from browser1 to browser2
        const testMessage = 'Test message ' + String(Math.random()).slice(2, 10);
        await sendMessage(browser1.page, testMessage);

        // Browser2 should receive the message
        await waitForMessage(browser2.page, testMessage);

        // Verify message appears in browser2's message list
        const messages = await getMessages(browser2.page);
        expect(messages.some(m => m.includes(testMessage))).toBe(true);
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);

    it('should handle bidirectional messaging', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        await completePairing(browser1.page, browser2.page);

        // Browser1 sends to Browser2
        const msg1 = 'From browser1: ' + String(Math.random()).slice(2, 10);
        await sendMessage(browser1.page, msg1);
        await waitForMessage(browser2.page, msg1);

        // Browser2 sends to Browser1
        const msg2 = 'From browser2: ' + String(Math.random()).slice(2, 10);
        await sendMessage(browser2.page, msg2);
        await waitForMessage(browser1.page, msg2);

        // Both should have both messages
        const messages1 = await getMessages(browser1.page);
        const messages2 = await getMessages(browser2.page);

        expect(messages1.some(m => m.includes(msg1))).toBe(true);
        expect(messages1.some(m => m.includes(msg2))).toBe(true);
        expect(messages2.some(m => m.includes(msg1))).toBe(true);
        expect(messages2.some(m => m.includes(msg2))).toBe(true);
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);
  });

  describe('Connection Resilience', () => {
    it('should handle one peer disconnecting', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        await completePairing(browser1.page, browser2.page);

        // Close browser2
        await browser2.browser.close();

        // Browser1 should detect disconnection and return to registered state
        await waitFor(async () => {
          const connected = await browser1.page.locator('.status.connected').isVisible().catch(() => false);
          return !connected;
        }, 15000);

        // Browser1 should show its pairing code again (in registered state)
        const codeVisible = await browser1.page.locator('[data-testid="my-code"], .my-code').isVisible().catch(() => {
          // Try alternative selector
          return browser1.page.locator('text=/[A-HJ-NP-Z2-9]{6}/').first().isVisible();
        });

        // Either the code is visible or we've returned to a non-connected state
        const notConnected = await browser1.page.locator('.status.connected').isVisible().catch(() => false);
        expect(codeVisible || !notConnected).toBe(true);
      } finally {
        await browser1.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);
  });
});

// Helper functions for browser interactions
// Using shared TIMEOUTS constants for consistency

async function waitForPairingCode(page: Page, timeout = TIMEOUTS.LONG): Promise<void> {
  // Wait for the app to be in a registered state with a pairing code displayed
  await page.waitForSelector('[data-testid="my-code"], .my-code, .code-display', {
    timeout,
    state: 'visible',
  }).catch(async () => {
    // Fallback: wait for any 6-character uppercase code pattern
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return /[A-HJ-NP-Z2-9]{6}/.test(text);
      },
      { timeout }
    );
  });
}

async function getPairingCode(page: Page): Promise<string> {
  // Try various selectors for the pairing code
  const codeElement = await page.$('[data-testid="my-code"], .my-code, .code-display, .code');

  if (codeElement) {
    const text = await codeElement.textContent();
    const match = text?.match(/[A-HJ-NP-Z2-9]{6}/);
    if (match) return match[0];
  }

  // Fallback: search page content for code pattern
  const content = await page.content();
  const match = content.match(/[A-HJ-NP-Z2-9]{6}/);
  if (match) return match[0];

  throw new Error('Could not find pairing code on page');
}

async function enterPairingCode(page: Page, code: string): Promise<void> {
  // Find and fill the code input
  const input = await page.waitForSelector(
    'input[placeholder*="code" i], input[name="code"], input[data-testid="peer-code-input"], input[type="text"]',
    { timeout: TIMEOUTS.MEDIUM }
  );

  await input.fill(code);

  // Click connect/pair button
  const button = await page.waitForSelector(
    'button:has-text("Connect"), button:has-text("Pair"), button[type="submit"], button:has-text("Request")',
    { timeout: TIMEOUTS.SHORT }
  );
  await button.click();
}

async function waitForApprovalRequest(page: Page, timeout = TIMEOUTS.MEDIUM): Promise<void> {
  // Wait for the approval dialog/request to appear
  await page.waitForSelector(
    '[data-testid="approval-request"], .approval-request, .pair-incoming, button:has-text("Accept"), button:has-text("Approve")',
    { timeout, state: 'visible' }
  );
}

async function acceptPairingRequest(page: Page): Promise<void> {
  const acceptButton = await page.waitForSelector(
    'button:has-text("Accept"), button:has-text("Approve"), button[data-testid="accept-btn"]',
    { timeout: TIMEOUTS.SHORT }
  );
  await acceptButton.click();
}

async function rejectPairingRequest(page: Page): Promise<void> {
  const rejectButton = await page.waitForSelector(
    'button:has-text("Reject"), button:has-text("Decline"), button[data-testid="reject-btn"]',
    { timeout: TIMEOUTS.SHORT }
  );
  await rejectButton.click();
}

async function waitForConnected(page: Page, timeout = TIMEOUTS.LONG): Promise<void> {
  // Wait for the connected state indicator
  await page.waitForSelector(
    '.status.connected, [data-testid="connected-status"], .connected-indicator',
    { timeout, state: 'visible' }
  ).catch(async () => {
    // Fallback: check for chat view or disconnect button
    await page.waitForSelector(
      'button:has-text("Disconnect"), .chat-view, [data-testid="chat"]',
      { timeout }
    );
  });
}

async function completePairing(page1: Page, page2: Page): Promise<void> {
  await waitForPairingCode(page1);
  await waitForPairingCode(page2);

  const code2 = await getPairingCode(page2);
  await enterPairingCode(page1, code2);

  await waitForApprovalRequest(page2);
  await acceptPairingRequest(page2);

  await waitForConnected(page1);
  await waitForConnected(page2);
}

async function sendMessage(page: Page, message: string): Promise<void> {
  // Find message input
  const input = await page.waitForSelector(
    'input[placeholder*="message" i], textarea, [data-testid="message-input"], input[name="message"]',
    { timeout: TIMEOUTS.MEDIUM }
  );

  await input.fill(message);

  // Click send button or press Enter
  const sendButton = await page.$('button:has-text("Send"), button[data-testid="send-btn"], button[type="submit"]');

  if (sendButton) {
    await sendButton.click();
  } else {
    await input.press('Enter');
  }
}

async function waitForMessage(page: Page, messageText: string, timeout = TIMEOUTS.MEDIUM): Promise<void> {
  await page.waitForFunction(
    (text) => {
      const messages = document.querySelectorAll('.message, [data-testid="message"], .chat-message');
      return Array.from(messages).some(m => m.textContent?.includes(text));
    },
    messageText,
    { timeout }
  ).catch(async () => {
    // Fallback: check page text
    await waitFor(
      async () => {
        const content = await page.content();
        return content.includes(messageText);
      },
      timeout
    );
  });
}

async function getMessages(page: Page): Promise<string[]> {
  const messageElements = await page.$$('.message, [data-testid="message"], .chat-message');
  const messages: string[] = [];

  for (const el of messageElements) {
    const text = await el.textContent();
    if (text) messages.push(text);
  }

  if (messages.length > 0) {
    return messages;
  }

  // Fallback: try to get text from message container
  const container = await page.$('.messages, .chat-messages, [data-testid="messages"]');
  if (container) {
    const text = await container.textContent();
    return text ? [text] : [];
  }

  return [];
}
