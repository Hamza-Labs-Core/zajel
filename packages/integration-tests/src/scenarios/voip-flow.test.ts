/**
 * VoIP Integration Tests
 *
 * Tests end-to-end VoIP (voice/video call) functionality between two browser
 * instances connecting via the VPS signaling server.
 *
 * Test Scenarios:
 * - Two browsers initiating and accepting calls
 * - Call rejection flow
 * - Call hangup flow
 * - Media control (mute/video toggle)
 * - Call timeout handling
 *
 * Note: These tests use mocked WebRTC and media APIs to work without real
 * media devices or secure contexts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestOrchestrator, delay, waitFor, TIMEOUTS, isCI, safeCleanup } from '../orchestrator';
import type { Page } from 'playwright';

/**
 * Script to inject mock WebRTC and media APIs into the browser.
 * This enables testing VoIP without real media devices.
 */
const VOIP_MOCK_SCRIPT = `
// Mock MediaStreamTrack
class MockMediaStreamTrack {
  constructor(kind) {
    this.kind = kind;
    this.enabled = true;
    this.readyState = 'live';
    this.id = 'mock-track-' + Math.random().toString(36).substr(2, 9);
    this.label = kind === 'audio' ? 'Mock Microphone' : 'Mock Camera';
    this.muted = false;
  }
  stop() { this.readyState = 'ended'; }
  clone() { const c = new MockMediaStreamTrack(this.kind); c.enabled = this.enabled; return c; }
  getConstraints() { return {}; }
  getCapabilities() { return {}; }
  getSettings() { return { deviceId: 'mock-' + this.kind }; }
  applyConstraints() { return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
}

// Mock MediaStream
class MockMediaStream {
  constructor(tracks = []) {
    this.id = 'mock-stream-' + Math.random().toString(36).substr(2, 9);
    this._tracks = tracks.length > 0 ? tracks : [
      new MockMediaStreamTrack('audio'),
      new MockMediaStreamTrack('video'),
    ];
    this.active = true;
  }
  getTracks() { return [...this._tracks]; }
  getAudioTracks() { return this._tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this._tracks.filter(t => t.kind === 'video'); }
  addTrack(track) { this._tracks.push(track); }
  removeTrack(track) { const i = this._tracks.indexOf(track); if (i > -1) this._tracks.splice(i, 1); }
  getTrackById(id) { return this._tracks.find(t => t.id === id) || null; }
  clone() { return new MockMediaStream(this._tracks.map(t => t.clone())); }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
}

// Mock RTCPeerConnection
class MockRTCPeerConnection {
  constructor(config) {
    this._config = config || {};
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.iceGatheringState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this._localTracks = [];
    this._remoteStream = null;
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    window.__mockPeerConnection = this;
  }
  addTrack(track, stream) {
    this._localTracks.push({ track, stream });
    return { track, getParameters: () => ({}), setParameters: () => Promise.resolve() };
  }
  removeTrack() {}
  getTransceivers() { return []; }
  getSenders() { return this._localTracks.map(({ track }) => ({ track })); }
  getReceivers() { return []; }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\\r\\no=- 123 2 IN IP4 127.0.0.1\\r\\na=mock-offer\\r\\n' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\\r\\no=- 123 2 IN IP4 127.0.0.1\\r\\na=mock-answer\\r\\n' };
  }
  async setLocalDescription(desc) {
    this.localDescription = desc;
    setTimeout(() => {
      this.iceGatheringState = 'gathering';
      if (this.onicecandidate) {
        this.onicecandidate({
          candidate: {
            candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 54321 typ host',
            sdpMid: '0', sdpMLineIndex: 0,
            toJSON: () => ({ candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 }),
          },
        });
      }
      setTimeout(() => {
        this.iceGatheringState = 'complete';
        if (this.onicecandidate) this.onicecandidate({ candidate: null });
      }, 50);
    }, 10);
  }
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    setTimeout(() => {
      if (this.ontrack && !this._remoteStream) {
        this._remoteStream = new MockMediaStream();
        this._remoteStream._tracks.forEach(track => {
          this.ontrack({ track, streams: [this._remoteStream], receiver: { track }, transceiver: {} });
        });
      }
    }, 50);
  }
  async addIceCandidate() {}
  getConfiguration() { return this._config; }
  setConfiguration(c) { this._config = c; }
  createDataChannel(label) {
    return { label, readyState: 'connecting', send: () => {}, close: () => {} };
  }
  getStats() { return Promise.resolve(new Map()); }
  close() {
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
    if (this.onconnectionstatechange) this.onconnectionstatechange();
  }
  _simulateConnectionState(state) {
    this.connectionState = state;
    if (state === 'connected') this.iceConnectionState = 'connected';
    if (this.onconnectionstatechange) this.onconnectionstatechange();
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
  }
}

// Mock RTCSessionDescription
class MockRTCSessionDescription {
  constructor(init) { this.type = init?.type || 'offer'; this.sdp = init?.sdp || ''; }
  toJSON() { return { type: this.type, sdp: this.sdp }; }
}

// Mock RTCIceCandidate
class MockRTCIceCandidate {
  constructor(init) {
    this.candidate = init?.candidate || '';
    this.sdpMid = init?.sdpMid || null;
    this.sdpMLineIndex = init?.sdpMLineIndex ?? null;
  }
  toJSON() { return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex }; }
}

// Install mocks
if (navigator.mediaDevices) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const tracks = [];
    if (constraints?.audio) tracks.push(new MockMediaStreamTrack('audio'));
    if (constraints?.video) tracks.push(new MockMediaStreamTrack('video'));
    window.__mockLocalStream = new MockMediaStream(tracks);
    return window.__mockLocalStream;
  };
  navigator.mediaDevices.enumerateDevices = async () => [
    { deviceId: 'mock-audio', kind: 'audioinput', label: 'Mock Mic', groupId: 'g1' },
    { deviceId: 'mock-video', kind: 'videoinput', label: 'Mock Cam', groupId: 'g1' },
  ];
}

window.RTCPeerConnection = MockRTCPeerConnection;
window.RTCSessionDescription = MockRTCSessionDescription;
window.RTCIceCandidate = MockRTCIceCandidate;
window.MediaStream = MockMediaStream;
window.MediaStreamTrack = MockMediaStreamTrack;

window.__voipTestHelpers = {
  simulateConnectionState: (state) => window.__mockPeerConnection?._simulateConnectionState(state),
  getLocalStream: () => window.__mockLocalStream,
  getPeerConnection: () => window.__mockPeerConnection,
};

console.log('[VoIP Mocks] Installed');
`;

/**
 * Install VoIP mocks on a page before navigation
 */
async function setupVoIPMocks(page: Page): Promise<void> {
  await page.addInitScript(VOIP_MOCK_SCRIPT);
}

// TODO: Re-enable when Vite env loading is fixed (same issue as web-to-web tests)
// The test infrastructure works but web client doesn't pick up test VPS URL from env
describe.skip('VoIP Integration Tests', () => {
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

  describe('Call Initiation Flow', () => {
    it('should show call buttons in chat view after pairing', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        // Install VoIP mocks
        await setupVoIPMocks(browser1.page);
        await setupVoIPMocks(browser2.page);

        // Complete pairing
        await completePairing(browser1.page, browser2.page);

        // Both should have call buttons visible
        const voiceBtn1 = browser1.page.getByRole('button', { name: /voice call/i });
        const videoBtn1 = browser1.page.getByRole('button', { name: /video call/i });

        await expect(voiceBtn1).toBeVisible({ timeout: TIMEOUTS.SHORT });
        await expect(videoBtn1).toBeVisible({ timeout: TIMEOUTS.SHORT });
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);

    it('should initiate outgoing call when voice call button clicked', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        await setupVoIPMocks(browser1.page);
        await setupVoIPMocks(browser2.page);
        await completePairing(browser1.page, browser2.page);

        // Browser1 initiates voice call
        const voiceBtn = browser1.page.getByRole('button', { name: /voice call/i });
        await voiceBtn.click();

        // Should show call view with "Calling..." status
        await waitFor(async () => {
          const callView = browser1.page.locator('.call-view');
          return await callView.isVisible();
        }, TIMEOUTS.MEDIUM);

        const statusText = await browser1.page.locator('.call-status, #call-status').textContent();
        expect(statusText?.toLowerCase()).toContain('calling');
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);

    it('should show incoming call overlay on receiver', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        await setupVoIPMocks(browser1.page);
        await setupVoIPMocks(browser2.page);
        await completePairing(browser1.page, browser2.page);

        // Browser1 initiates call
        const voiceBtn = browser1.page.getByRole('button', { name: /voice call/i });
        await voiceBtn.click();

        // Browser2 should see incoming call overlay
        await waitFor(async () => {
          const overlay = browser2.page.locator('.incoming-call-dialog, .call-overlay');
          return await overlay.isVisible();
        }, TIMEOUTS.MEDIUM);

        // Should show caller info
        const callerName = await browser2.page.locator('#incoming-call-title, .caller-name').textContent();
        expect(callerName).toBeTruthy();
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);
  });

  describe('Call Accept Flow', () => {
    it('should connect call when accept button clicked', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        await setupVoIPMocks(browser1.page);
        await setupVoIPMocks(browser2.page);
        await completePairing(browser1.page, browser2.page);

        // Browser1 initiates call
        await browser1.page.getByRole('button', { name: /voice call/i }).click();

        // Wait for incoming call on browser2
        await waitFor(async () => {
          return await browser2.page.locator('.incoming-call-dialog').isVisible();
        }, TIMEOUTS.MEDIUM);

        // Accept the call
        await browser2.page.locator('.call-btn-accept').click();

        // Both should transition to connecting/connected state
        await waitFor(async () => {
          const status1 = await browser1.page.locator('.call-status').textContent();
          const status2 = await browser2.page.locator('.call-status').textContent();
          return (
            status1?.toLowerCase().includes('connecting') ||
            status1?.match(/\d{2}:\d{2}/) ||
            status2?.toLowerCase().includes('connecting') ||
            status2?.match(/\d{2}:\d{2}/)
          );
        }, TIMEOUTS.LONG);

        // Simulate connection establishment
        await browser1.page.evaluate(() => {
          (window as any).__voipTestHelpers?.simulateConnectionState('connected');
        });
        await browser2.page.evaluate(() => {
          (window as any).__voipTestHelpers?.simulateConnectionState('connected');
        });

        // Should show duration timer (connected state)
        await delay(1500);
        const status1 = await browser1.page.locator('.call-status').textContent();
        expect(status1).toMatch(/\d{2}:\d{2}/); // HH:MM format
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);
  });

  describe('Call Reject Flow', () => {
    it('should end call when reject button clicked', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        await setupVoIPMocks(browser1.page);
        await setupVoIPMocks(browser2.page);
        await completePairing(browser1.page, browser2.page);

        // Browser1 initiates call
        await browser1.page.getByRole('button', { name: /voice call/i }).click();

        // Wait for incoming call on browser2
        await waitFor(async () => {
          return await browser2.page.locator('.incoming-call-dialog').isVisible();
        }, TIMEOUTS.MEDIUM);

        // Reject the call
        await browser2.page.locator('.call-btn-reject').click();

        // Browser2's overlay should disappear
        await waitFor(async () => {
          return !(await browser2.page.locator('.incoming-call-dialog').isVisible());
        }, TIMEOUTS.SHORT);

        // Browser1's call view should end
        await waitFor(async () => {
          const callView = browser1.page.locator('.call-view');
          return !(await callView.isVisible());
        }, TIMEOUTS.MEDIUM);
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);
  });

  describe('Call Hangup Flow', () => {
    it('should end call when hangup button clicked', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        await setupVoIPMocks(browser1.page);
        await setupVoIPMocks(browser2.page);
        await completePairing(browser1.page, browser2.page);

        // Initiate and accept call
        await browser1.page.getByRole('button', { name: /voice call/i }).click();
        await waitFor(async () => browser2.page.locator('.incoming-call-dialog').isVisible(), TIMEOUTS.MEDIUM);
        await browser2.page.locator('.call-btn-accept').click();

        // Simulate connected state
        await browser1.page.evaluate(() => {
          (window as any).__voipTestHelpers?.simulateConnectionState('connected');
        });
        await browser2.page.evaluate(() => {
          (window as any).__voipTestHelpers?.simulateConnectionState('connected');
        });

        await delay(500);

        // Browser1 hangs up
        await browser1.page.locator('.control-btn-hangup, button[aria-label="End call"]').click();

        // Both call views should close
        await waitFor(async () => {
          const v1 = await browser1.page.locator('.call-view').isVisible();
          const v2 = await browser2.page.locator('.call-view').isVisible();
          return !v1 && !v2;
        }, TIMEOUTS.MEDIUM);
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);
  });

  describe('Media Controls', () => {
    it('should toggle mute state', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        await setupVoIPMocks(browser1.page);
        await setupVoIPMocks(browser2.page);
        await completePairing(browser1.page, browser2.page);

        // Start call and connect
        await browser1.page.getByRole('button', { name: /voice call/i }).click();
        await waitFor(async () => browser2.page.locator('.incoming-call-dialog').isVisible(), TIMEOUTS.MEDIUM);
        await browser2.page.locator('.call-btn-accept').click();
        await browser1.page.evaluate(() => {
          (window as any).__voipTestHelpers?.simulateConnectionState('connected');
        });

        await delay(500);

        // Find and click mute button
        const muteBtn = browser1.page.locator('button[aria-label*="mute" i][aria-label*="microphone" i]');
        const initialPressed = await muteBtn.getAttribute('aria-pressed');
        expect(initialPressed).toBe('false');

        await muteBtn.click();

        const afterPressed = await muteBtn.getAttribute('aria-pressed');
        expect(afterPressed).toBe('true');
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);

    it('should toggle video state', async () => {
      const browser1 = await orchestrator.connectWebBrowser();
      const browser2 = await orchestrator.createAdditionalBrowser();

      try {
        await setupVoIPMocks(browser1.page);
        await setupVoIPMocks(browser2.page);
        await completePairing(browser1.page, browser2.page);

        // Start VIDEO call and connect
        await browser1.page.getByRole('button', { name: /video call/i }).click();
        await waitFor(async () => browser2.page.locator('.incoming-call-dialog').isVisible(), TIMEOUTS.MEDIUM);
        await browser2.page.locator('.call-btn-accept-video, .call-btn-accept').click();
        await browser1.page.evaluate(() => {
          (window as any).__voipTestHelpers?.simulateConnectionState('connected');
        });

        await delay(500);

        // Find and click video toggle button
        const videoBtn = browser1.page.locator('button[aria-label*="camera" i]');
        const initialPressed = await videoBtn.getAttribute('aria-pressed');
        expect(initialPressed).toBe('false'); // Video starts ON, so aria-pressed for "turn off" is false

        await videoBtn.click();

        const afterPressed = await videoBtn.getAttribute('aria-pressed');
        expect(afterPressed).toBe('true'); // Now video is OFF
      } finally {
        await browser1.browser.close();
        await browser2.browser.close();
      }
    }, TIMEOUTS.VERY_LONG);
  });
});

// Helper functions

async function waitForPairingCode(page: Page, timeout = TIMEOUTS.LONG): Promise<void> {
  await page.waitForSelector('.code-display, [data-testid="my-code"]', {
    timeout,
    state: 'visible',
  }).catch(async () => {
    await page.waitForFunction(
      () => /[A-HJ-NP-Z2-9]{6}/.test(document.body.innerText),
      { timeout }
    );
  });
}

async function getPairingCode(page: Page): Promise<string> {
  const codeEl = await page.$('.code-display, [data-testid="my-code"]');
  if (codeEl) {
    const text = await codeEl.textContent();
    const match = text?.match(/[A-HJ-NP-Z2-9]{6}/);
    if (match) return match[0];
  }
  const content = await page.content();
  const match = content.match(/[A-HJ-NP-Z2-9]{6}/);
  if (match) return match[0];
  throw new Error('Could not find pairing code');
}

async function enterPairingCode(page: Page, code: string): Promise<void> {
  const inputs = page.locator('.code-input input');
  await inputs.first().click();
  await page.keyboard.type(code);

  const btn = page.getByRole('button', { name: /connect/i });
  await btn.click();
}

async function waitForApprovalRequest(page: Page, timeout = TIMEOUTS.MEDIUM): Promise<void> {
  await page.waitForSelector(
    '.approval-request, .pair-incoming, button:has-text("Accept")',
    { timeout, state: 'visible' }
  );
}

async function acceptPairingRequest(page: Page): Promise<void> {
  const btn = await page.waitForSelector('button:has-text("Accept")', { timeout: TIMEOUTS.SHORT });
  await btn.click();
}

async function waitForConnected(page: Page, timeout = TIMEOUTS.LONG): Promise<void> {
  await page.waitForSelector('.chat-view, .chat-header, button:has-text("Disconnect")', {
    timeout,
    state: 'visible',
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
