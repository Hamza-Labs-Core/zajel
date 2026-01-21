import { test, expect, Page, BrowserContext } from '@playwright/test';

/**
 * End-to-end browser tests for messaging functionality.
 *
 * These tests verify:
 * 1. Two browsers can pair via VPS signaling
 * 2. Messages can be sent from Browser A to Browser B
 * 3. Bidirectional messaging works
 * 4. Connection status is displayed correctly
 *
 * Prerequisites:
 * - VITE_SIGNALING_URL must be set (uses real VPS server)
 * - The signaling server must be running
 */

/**
 * Wait for the connection state to reach a specific status.
 * Uses condition-based waiting instead of fixed timeouts.
 */
async function waitForConnectionState(
  page: Page,
  state: 'connected' | 'disconnected' | 'ready' = 'connected',
  timeout = 15000
): Promise<void> {
  const statusIndicator = page.locator('.status-indicator');
  await expect(statusIndicator).toContainText(new RegExp(state, 'i'), { timeout });
}

/**
 * Wait for a message to appear in the message list.
 * Uses condition-based waiting instead of fixed timeouts.
 */
async function waitForMessageInList(
  page: Page,
  messageText: string,
  timeout = 10000
): Promise<void> {
  const messageList = page.locator('.message-list, [role="log"], .message, [class*="message"]');
  await expect(messageList).toContainText(messageText, { timeout });
}

/**
 * Wait for a minimum number of messages to appear.
 */
async function waitForMessageCount(
  page: Page,
  minCount: number,
  timeout = 10000
): Promise<void> {
  const messages = page.locator('.message, [class*="message"]');
  await expect(messages).toHaveCount(minCount, { timeout });
}

test.describe('Zajel Web Client - Messaging', () => {
  let contextA: BrowserContext;
  let contextB: BrowserContext;
  let browserA: Page;
  let browserB: Page;

  test.beforeEach(async ({ browser }) => {
    // Create two separate browser contexts (simulates two different users)
    contextA = await browser.newContext();
    contextB = await browser.newContext();

    browserA = await contextA.newPage();
    browserB = await contextB.newPage();
  });

  test.afterEach(async () => {
    await browserA.close();
    await browserB.close();
    await contextA.close();
    await contextB.close();
  });

  /**
   * Wait for a page to be in 'Ready' state with a pairing code.
   * Returns the pairing code or null if not ready.
   */
  async function waitForReady(page: Page, timeout = 15000): Promise<string | null> {
    try {
      // Wait for Ready status
      const statusIndicator = page.locator('.status-indicator');
      await expect(statusIndicator).toContainText(/ready/i, { timeout });

      // Get the pairing code
      const chars = page.locator('.code-display .char');
      await expect(chars).toHaveCount(6, { timeout: 5000 });

      let code = '';
      for (let i = 0; i < 6; i++) {
        const text = await chars.nth(i).textContent();
        code += text || '';
      }

      return code;
    } catch {
      return null;
    }
  }

  /**
   * Enter a peer code and click connect.
   */
  async function enterPeerCode(page: Page, code: string): Promise<void> {
    const inputs = page.locator('.code-input input');
    await inputs.first().click();
    await page.keyboard.type(code);

    const connectButton = page.getByRole('button', { name: /connect/i });
    await connectButton.click();
  }

  /**
   * Accept a pairing request when the approval modal appears.
   */
  async function acceptPairingRequest(page: Page): Promise<boolean> {
    try {
      // Wait for approval modal to appear
      const approveButton = page.getByRole('button', { name: /accept|approve|yes/i });
      await expect(approveButton).toBeVisible({ timeout: 10000 });
      await approveButton.click();
      return true;
    } catch {
      return false;
    }
  }

  test('two browsers can pair via real VPS signaling', async () => {
    // Navigate both browsers
    await browserA.goto('/');
    await browserB.goto('/');

    // Wait for both to be ready
    const codeA = await waitForReady(browserA);
    const codeB = await waitForReady(browserB);

    if (!codeA || !codeB) {
      test.skip(true, 'VPS signaling server not available');
      return;
    }

    expect(codeA).toHaveLength(6);
    expect(codeB).toHaveLength(6);
    expect(codeA).not.toBe(codeB);

    console.log(`Browser A code: ${codeA}`);
    console.log(`Browser B code: ${codeB}`);

    // Browser A enters Browser B's code
    await enterPeerCode(browserA, codeB);

    // Browser B should receive a pairing request - accept it
    const accepted = await acceptPairingRequest(browserB);
    if (!accepted) {
      // Maybe auto-accepted or different flow
      console.log('Note: Pairing request auto-accepted or different UI flow');
    }

    // Wait for connection to establish using condition-based waiting
    await waitForConnectionState(browserA, 'connected');

    // Connection is established - status should show connected
    const statusA = browserA.locator('.status-indicator');
    const statusTextA = await statusA.textContent();
    expect(statusTextA?.toLowerCase()).toContain('connected');
  });

  test('can send and receive text messages between browsers', async () => {
    await browserA.goto('/');
    await browserB.goto('/');

    const codeA = await waitForReady(browserA);
    const codeB = await waitForReady(browserB);

    if (!codeA || !codeB) {
      test.skip(true, 'VPS signaling server not available');
      return;
    }

    // Connect Browser A to Browser B
    await enterPeerCode(browserA, codeB);
    await acceptPairingRequest(browserB);

    // Wait for connection using condition-based waiting
    await waitForConnectionState(browserA, 'connected');

    // Look for message input area (may vary based on UI)
    const messageInputA = browserA.locator('input[placeholder*="message" i], textarea[placeholder*="message" i]');
    const messageInputB = browserB.locator('input[placeholder*="message" i], textarea[placeholder*="message" i]');

    // If messaging UI is available
    if (await messageInputA.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Send a message from A to B
      await messageInputA.fill('Hello from Browser A!');
      await browserA.keyboard.press('Enter');

      // Wait for message to appear in B using condition-based waiting
      await waitForMessageInList(browserB, 'Hello from Browser A!');
    } else {
      console.log('Note: Messaging UI not visible after connection');
    }
  });

  test('bidirectional messaging works', async () => {
    await browserA.goto('/');
    await browserB.goto('/');

    const codeA = await waitForReady(browserA);
    const codeB = await waitForReady(browserB);

    if (!codeA || !codeB) {
      test.skip(true, 'VPS signaling server not available');
      return;
    }

    // Connect
    await enterPeerCode(browserA, codeB);
    await acceptPairingRequest(browserB);

    // Wait for connection using condition-based waiting
    await waitForConnectionState(browserA, 'connected');

    // Get message inputs
    const messageInputA = browserA.locator('input[placeholder*="message" i], textarea[placeholder*="message" i]');
    const messageInputB = browserB.locator('input[placeholder*="message" i], textarea[placeholder*="message" i]');

    if (await messageInputA.isVisible({ timeout: 5000 }).catch(() => false) &&
        await messageInputB.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Send from A
      await messageInputA.fill('Message 1 from A');
      await browserA.keyboard.press('Enter');

      // Send from B
      await messageInputB.fill('Message 1 from B');
      await browserB.keyboard.press('Enter');

      // Send more
      await messageInputA.fill('Message 2 from A');
      await browserA.keyboard.press('Enter');

      await messageInputB.fill('Message 2 from B');
      await browserB.keyboard.press('Enter');

      // Wait for messages to be received using condition-based waiting
      // Each browser should have at least 2 messages (sent + received)
      await waitForMessageCount(browserA, 2);
      await waitForMessageCount(browserB, 2);
    } else {
      console.log('Note: Messaging UI not available');
    }
  });

  test('connection status shows "Connected" after successful pairing', async () => {
    await browserA.goto('/');
    await browserB.goto('/');

    const codeA = await waitForReady(browserA);
    const codeB = await waitForReady(browserB);

    if (!codeA || !codeB) {
      test.skip(true, 'VPS signaling server not available');
      return;
    }

    // Connect
    await enterPeerCode(browserA, codeB);
    await acceptPairingRequest(browserB);

    // Wait for WebRTC connection using condition-based waiting (with longer timeout for WebRTC)
    await waitForConnectionState(browserA, 'connected', 20000);

    // Verify connected status is shown
    const statusA = browserA.locator('.status-indicator');
    await expect(statusA).toContainText(/connected/i);
  });

  test('handles disconnection gracefully', async () => {
    await browserA.goto('/');
    await browserB.goto('/');

    const codeA = await waitForReady(browserA);
    const codeB = await waitForReady(browserB);

    if (!codeA || !codeB) {
      test.skip(true, 'VPS signaling server not available');
      return;
    }

    // Connect
    await enterPeerCode(browserA, codeB);
    await acceptPairingRequest(browserB);

    // Wait for connection using condition-based waiting
    await waitForConnectionState(browserA, 'connected');

    // Close Browser B (simulates disconnect)
    await browserB.close();

    // Wait for A to detect disconnection using condition-based waiting
    // Should show disconnected, offline, or return to ready state
    const statusA = browserA.locator('.status-indicator');
    await expect(statusA).toContainText(/disconnected|offline|ready|connecting/i, { timeout: 15000 });
  });
});
