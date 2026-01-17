/**
 * VoIP E2E Test Helpers
 *
 * Provides mock implementations for WebRTC and media APIs that work
 * in the browser context, enabling E2E testing without real media devices
 * or secure contexts (HTTPS).
 *
 * Usage:
 *   test.beforeEach(async ({ page }) => {
 *     await setupVoIPMocks(page);
 *     await page.goto('/');
 *   });
 */

import type { Page } from '@playwright/test';

// CI-compatible timeout multiplier
const CI_TIMEOUT_MULTIPLIER = process.env.CI ? 3 : 1;

/**
 * Returns a CI-aware timeout value.
 */
export function ciTimeout(ms: number): number {
  return ms * CI_TIMEOUT_MULTIPLIER;
}

/**
 * Script to inject mock WebRTC and media APIs into the browser.
 * This MUST run before any page scripts execute.
 */
const VOIP_MOCK_SCRIPT = `
// ============================================================================
// MOCK MEDIA STREAM TRACK
// ============================================================================
class MockMediaStreamTrack {
  constructor(kind) {
    this.kind = kind;
    this.enabled = true;
    this.readyState = 'live';
    this.id = 'mock-track-' + Math.random().toString(36).substr(2, 9);
    this.label = kind === 'audio' ? 'Mock Microphone' : 'Mock Camera';
    this.muted = false;
    this.onended = null;
    this.onmute = null;
    this.onunmute = null;
  }

  stop() {
    this.readyState = 'ended';
    if (this.onended) this.onended();
  }

  clone() {
    const clone = new MockMediaStreamTrack(this.kind);
    clone.enabled = this.enabled;
    return clone;
  }

  getConstraints() {
    return {};
  }

  getCapabilities() {
    return {};
  }

  getSettings() {
    return {
      deviceId: 'mock-device-' + this.kind,
      groupId: 'mock-group',
    };
  }

  applyConstraints() {
    return Promise.resolve();
  }

  // EventTarget methods
  addEventListener(type, listener) {
    if (type === 'ended') this.onended = listener;
    if (type === 'mute') this.onmute = listener;
    if (type === 'unmute') this.onunmute = listener;
  }

  removeEventListener() {}
  dispatchEvent() { return true; }
}

// ============================================================================
// MOCK MEDIA STREAM
// ============================================================================
class MockMediaStream {
  constructor(tracks = []) {
    this.id = 'mock-stream-' + Math.random().toString(36).substr(2, 9);
    this._tracks = tracks.length > 0 ? tracks : [
      new MockMediaStreamTrack('audio'),
      new MockMediaStreamTrack('video'),
    ];
    this.active = true;
    this.onaddtrack = null;
    this.onremovetrack = null;
  }

  getTracks() {
    return [...this._tracks];
  }

  getAudioTracks() {
    return this._tracks.filter(t => t.kind === 'audio');
  }

  getVideoTracks() {
    return this._tracks.filter(t => t.kind === 'video');
  }

  addTrack(track) {
    this._tracks.push(track);
    if (this.onaddtrack) this.onaddtrack({ track });
  }

  removeTrack(track) {
    const index = this._tracks.indexOf(track);
    if (index > -1) {
      this._tracks.splice(index, 1);
      if (this.onremovetrack) this.onremovetrack({ track });
    }
  }

  getTrackById(id) {
    return this._tracks.find(t => t.id === id) || null;
  }

  clone() {
    return new MockMediaStream(this._tracks.map(t => t.clone()));
  }

  // EventTarget methods
  addEventListener(type, listener) {
    if (type === 'addtrack') this.onaddtrack = listener;
    if (type === 'removetrack') this.onremovetrack = listener;
  }

  removeEventListener() {}
  dispatchEvent() { return true; }
}

// ============================================================================
// MOCK RTC PEER CONNECTION
// ============================================================================
class MockRTCPeerConnection {
  constructor(config) {
    this._config = config || {};
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.iceGatheringState = 'new';
    this.signalingState = 'stable';
    this.localDescription = null;
    this.remoteDescription = null;
    this.currentLocalDescription = null;
    this.currentRemoteDescription = null;
    this.pendingLocalDescription = null;
    this.pendingRemoteDescription = null;
    this._localTracks = [];
    this._remoteStream = null;
    this._iceCandidates = [];

    // Event handlers
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.onicegatheringstatechange = null;
    this.onsignalingstatechange = null;
    this.ondatachannel = null;
    this.onnegotiationneeded = null;

    // Expose for test control
    window.__mockPeerConnection = this;
  }

  addTrack(track, stream) {
    this._localTracks.push({ track, stream });
    return {
      track,
      getParameters: () => ({}),
      setParameters: () => Promise.resolve(),
      replaceTrack: (newTrack) => {
        const item = this._localTracks.find(t => t.track === track);
        if (item) item.track = newTrack;
        return Promise.resolve();
      },
    };
  }

  removeTrack(sender) {
    const index = this._localTracks.findIndex(t => t.track === sender.track);
    if (index > -1) this._localTracks.splice(index, 1);
  }

  getTransceivers() {
    return [];
  }

  getSenders() {
    return this._localTracks.map(({ track }) => ({
      track,
      getParameters: () => ({}),
      setParameters: () => Promise.resolve(),
    }));
  }

  getReceivers() {
    return [];
  }

  async createOffer(options) {
    this.signalingState = 'have-local-offer';
    return {
      type: 'offer',
      sdp: 'v=0\\r\\no=- 123456 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\na=mock-offer\\r\\n',
    };
  }

  async createAnswer(options) {
    return {
      type: 'answer',
      sdp: 'v=0\\r\\no=- 123456 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\na=mock-answer\\r\\n',
    };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
    this.currentLocalDescription = desc;

    // Simulate ICE candidate gathering
    setTimeout(() => {
      this.iceGatheringState = 'gathering';
      if (this.onicegatheringstatechange) this.onicegatheringstatechange();

      // Generate a mock ICE candidate
      if (this.onicecandidate) {
        this.onicecandidate({
          candidate: {
            candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 54321 typ host',
            sdpMid: '0',
            sdpMLineIndex: 0,
            toJSON: () => ({
              candidate: 'candidate:1 1 UDP 2122252543 192.168.1.1 54321 typ host',
              sdpMid: '0',
              sdpMLineIndex: 0,
            }),
          },
        });
      }

      setTimeout(() => {
        this.iceGatheringState = 'complete';
        if (this.onicegatheringstatechange) this.onicegatheringstatechange();
        // End-of-candidates signal
        if (this.onicecandidate) {
          this.onicecandidate({ candidate: null });
        }
      }, 50);
    }, 10);
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.currentRemoteDescription = desc;
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';

    // Simulate receiving remote track
    setTimeout(() => {
      if (this.ontrack && !this._remoteStream) {
        this._remoteStream = new MockMediaStream();
        this._remoteStream._tracks.forEach(track => {
          this.ontrack({
            track,
            streams: [this._remoteStream],
            receiver: { track },
            transceiver: {},
          });
        });
      }
    }, 50);
  }

  async addIceCandidate(candidate) {
    if (candidate) {
      this._iceCandidates.push(candidate);
    }
  }

  getConfiguration() {
    return this._config;
  }

  setConfiguration(config) {
    this._config = config;
  }

  createDataChannel(label, options) {
    return {
      label,
      readyState: 'connecting',
      send: () => {},
      close: () => {},
      onopen: null,
      onclose: null,
      onmessage: null,
      onerror: null,
    };
  }

  getStats() {
    return Promise.resolve(new Map());
  }

  close() {
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
    this.signalingState = 'closed';
    if (this.onconnectionstatechange) this.onconnectionstatechange();
  }

  // Test helper: simulate connection state change
  _simulateConnectionState(state) {
    this.connectionState = state;
    if (state === 'connected') {
      this.iceConnectionState = 'connected';
    } else if (state === 'failed') {
      this.iceConnectionState = 'failed';
    }
    if (this.onconnectionstatechange) this.onconnectionstatechange();
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
  }

  // Test helper: simulate receiving a remote track
  _simulateRemoteTrack() {
    if (this.ontrack) {
      const stream = new MockMediaStream();
      this._remoteStream = stream;
      stream._tracks.forEach(track => {
        this.ontrack({
          track,
          streams: [stream],
          receiver: { track },
          transceiver: {},
        });
      });
    }
  }
}

// ============================================================================
// MOCK RTC SESSION DESCRIPTION
// ============================================================================
class MockRTCSessionDescription {
  constructor(init) {
    this.type = init?.type || 'offer';
    this.sdp = init?.sdp || '';
  }

  toJSON() {
    return { type: this.type, sdp: this.sdp };
  }
}

// ============================================================================
// MOCK RTC ICE CANDIDATE
// ============================================================================
class MockRTCIceCandidate {
  constructor(init) {
    this.candidate = init?.candidate || '';
    this.sdpMid = init?.sdpMid || null;
    this.sdpMLineIndex = init?.sdpMLineIndex ?? null;
    this.foundation = '';
    this.component = 'rtp';
    this.priority = 0;
    this.address = '192.168.1.1';
    this.protocol = 'udp';
    this.port = 54321;
    this.type = 'host';
    this.tcpType = null;
    this.relatedAddress = null;
    this.relatedPort = null;
    this.usernameFragment = '';
  }

  toJSON() {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
    };
  }
}

// ============================================================================
// INSTALL MOCKS
// ============================================================================

// Override getUserMedia
if (navigator.mediaDevices) {
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const tracks = [];
    if (constraints?.audio) {
      tracks.push(new MockMediaStreamTrack('audio'));
    }
    if (constraints?.video) {
      tracks.push(new MockMediaStreamTrack('video'));
    }
    const stream = new MockMediaStream(tracks);
    window.__mockLocalStream = stream;
    return stream;
  };

  navigator.mediaDevices.enumerateDevices = async () => [
    { deviceId: 'mock-audio-input', kind: 'audioinput', label: 'Mock Microphone', groupId: 'mock-group' },
    { deviceId: 'mock-video-input', kind: 'videoinput', label: 'Mock Camera', groupId: 'mock-group' },
    { deviceId: 'mock-audio-output', kind: 'audiooutput', label: 'Mock Speaker', groupId: 'mock-group' },
  ];
} else {
  // Create navigator.mediaDevices if it doesn't exist
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: async (constraints) => {
        const tracks = [];
        if (constraints?.audio) {
          tracks.push(new MockMediaStreamTrack('audio'));
        }
        if (constraints?.video) {
          tracks.push(new MockMediaStreamTrack('video'));
        }
        const stream = new MockMediaStream(tracks);
        window.__mockLocalStream = stream;
        return stream;
      },
      enumerateDevices: async () => [
        { deviceId: 'mock-audio-input', kind: 'audioinput', label: 'Mock Microphone', groupId: 'mock-group' },
        { deviceId: 'mock-video-input', kind: 'videoinput', label: 'Mock Camera', groupId: 'mock-group' },
        { deviceId: 'mock-audio-output', kind: 'audiooutput', label: 'Mock Speaker', groupId: 'mock-group' },
      ],
    },
    writable: true,
    configurable: true,
  });
}

// Override global constructors
window.RTCPeerConnection = MockRTCPeerConnection;
window.RTCSessionDescription = MockRTCSessionDescription;
window.RTCIceCandidate = MockRTCIceCandidate;
window.MediaStream = MockMediaStream;
window.MediaStreamTrack = MockMediaStreamTrack;

// Expose test control functions
window.__voipTestHelpers = {
  simulateConnectionState: (state) => {
    if (window.__mockPeerConnection) {
      window.__mockPeerConnection._simulateConnectionState(state);
    }
  },
  simulateRemoteTrack: () => {
    if (window.__mockPeerConnection) {
      window.__mockPeerConnection._simulateRemoteTrack();
    }
  },
  getLocalStream: () => window.__mockLocalStream,
  getPeerConnection: () => window.__mockPeerConnection,
};

console.log('[VoIP Mocks] Installed successfully');
`;

/**
 * Setup VoIP mocks before page navigation.
 * Call this in test.beforeEach BEFORE page.goto().
 */
export async function setupVoIPMocks(page: Page): Promise<void> {
  await page.addInitScript(VOIP_MOCK_SCRIPT);
}

/**
 * Simulate connection state change in the mock peer connection.
 */
export async function simulateConnectionState(
  page: Page,
  state: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'
): Promise<void> {
  await page.evaluate((s) => {
    (window as any).__voipTestHelpers?.simulateConnectionState(s);
  }, state);
}

/**
 * Simulate receiving a remote media track.
 */
export async function simulateRemoteTrack(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__voipTestHelpers?.simulateRemoteTrack();
  });
}

/**
 * Wait for call state to change by polling the UI.
 */
export async function waitForCallState(
  page: Page,
  state: 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'ended',
  options: { timeout?: number } = {}
): Promise<void> {
  const timeout = options.timeout ?? ciTimeout(10000);
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const currentState = await page.evaluate(() => {
      // Check for call-view dialog
      const callView = document.querySelector('.call-view');
      if (callView) {
        // Check status text
        const statusEl = callView.querySelector('#call-status, .call-status');
        const statusText = statusEl?.textContent?.toLowerCase() || '';

        if (statusText.includes('calling')) return 'outgoing';
        if (statusText.includes('connecting')) return 'connecting';
        if (statusText.includes('call ended')) return 'ended';
        // If we have duration like "00:05", it's connected
        if (/\d{2}:\d{2}/.test(statusText)) return 'connected';
      }

      // Check for incoming call overlay
      const incomingCall = document.querySelector('.incoming-call-dialog, .call-overlay');
      if (incomingCall) return 'incoming';

      return 'idle';
    });

    if (currentState === state) {
      return;
    }

    await page.waitForTimeout(100);
  }

  throw new Error(`Timed out waiting for call state: ${state}`);
}

/**
 * Get the current call info from the page.
 */
export async function getCallInfo(page: Page): Promise<{
  state: string;
  peerName: string | null;
  duration: string | null;
  hasLocalVideo: boolean;
  hasRemoteVideo: boolean;
}> {
  return await page.evaluate(() => {
    const callView = document.querySelector('.call-view');
    if (!callView) {
      return {
        state: 'idle',
        peerName: null,
        duration: null,
        hasLocalVideo: false,
        hasRemoteVideo: false,
      };
    }

    const statusEl = callView.querySelector('#call-status, .call-status');
    const statusText = statusEl?.textContent?.toLowerCase() || '';
    const peerNameEl = callView.querySelector('.peer-name');
    const localVideo = callView.querySelector('.local-video') as HTMLVideoElement | null;
    const remoteVideo = callView.querySelector('.remote-video') as HTMLVideoElement | null;

    let state = 'unknown';
    let duration = null;

    if (statusText.includes('calling')) state = 'outgoing';
    else if (statusText.includes('connecting')) state = 'connecting';
    else if (statusText.includes('call ended')) state = 'ended';
    else if (/\d{2}:\d{2}/.test(statusText)) {
      state = 'connected';
      duration = statusText.match(/(\d{2}:\d{2}(?::\d{2})?)/)?.[1] || null;
    }

    return {
      state,
      peerName: peerNameEl?.textContent || null,
      duration,
      hasLocalVideo: !!(localVideo?.srcObject),
      hasRemoteVideo: !!(remoteVideo?.srcObject),
    };
  });
}

/**
 * Simulate an incoming call by dispatching a call offer through the signaling layer.
 * This requires access to the app's signaling client.
 */
export async function simulateIncomingCall(
  page: Page,
  callerId: string,
  options: { withVideo?: boolean } = {}
): Promise<string> {
  const callId = `test-call-${Date.now()}`;
  const withVideo = options.withVideo ?? false;

  // Inject the incoming call message through the VoIP service
  await page.evaluate(
    ({ callId, callerId, withVideo }) => {
      // Access the global app state to trigger an incoming call
      const event = new CustomEvent('__test_incoming_call', {
        detail: {
          type: 'call_offer',
          callId,
          from: callerId,
          sdp: 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=mock-offer\r\n',
          withVideo,
        },
      });
      window.dispatchEvent(event);
    },
    { callId, callerId, withVideo }
  );

  return callId;
}

/**
 * Wait for the app to be in a connected/paired state.
 */
export async function waitForPairedState(
  page: Page,
  options: { timeout?: number } = {}
): Promise<void> {
  const timeout = options.timeout ?? ciTimeout(15000);

  // Wait for "Ready" status or chat view
  await page.waitForSelector(
    '.status-indicator:has-text("Ready"), .chat-view, .chat-header',
    { timeout }
  );
}

/**
 * Helper to start a call from the chat view.
 */
export async function startCallFromUI(
  page: Page,
  options: { withVideo?: boolean } = {}
): Promise<void> {
  const withVideo = options.withVideo ?? false;

  const buttonName = withVideo ? /video call/i : /voice call/i;
  const callButton = page.getByRole('button', { name: buttonName });

  await callButton.click();
}

/**
 * Helper to accept an incoming call from the overlay.
 */
export async function acceptIncomingCall(
  page: Page,
  options: { withVideo?: boolean } = {}
): Promise<void> {
  const withVideo = options.withVideo ?? false;

  if (withVideo) {
    const acceptVideoButton = page.locator('.call-btn-accept-video');
    if (await acceptVideoButton.isVisible()) {
      await acceptVideoButton.click();
      return;
    }
  }

  // Accept with audio (default accept button)
  const acceptButton = page.locator('.call-btn-accept');
  await acceptButton.click();
}

/**
 * Helper to reject an incoming call from the overlay.
 */
export async function rejectIncomingCall(page: Page): Promise<void> {
  const rejectButton = page.locator('.call-btn-reject');
  await rejectButton.click();
}

/**
 * Helper to hang up the current call.
 */
export async function hangupCall(page: Page): Promise<void> {
  const hangupButton = page.locator('.control-btn-hangup, button[aria-label="End call"]');
  await hangupButton.click();
}

/**
 * Helper to toggle mute during a call.
 */
export async function toggleMute(page: Page): Promise<boolean> {
  const muteButton = page.locator('button[aria-label*="mute" i][aria-label*="microphone" i]');
  await muteButton.click();

  // Return new muted state
  const isMuted = await muteButton.getAttribute('aria-pressed');
  return isMuted === 'true';
}

/**
 * Helper to toggle video during a call.
 */
export async function toggleVideo(page: Page): Promise<boolean> {
  const videoButton = page.locator('button[aria-label*="camera" i]');
  await videoButton.click();

  // Return new video-off state
  const isVideoOff = await videoButton.getAttribute('aria-pressed');
  return isVideoOff === 'true';
}

/**
 * Check if the incoming call overlay is visible.
 */
export async function isIncomingCallOverlayVisible(page: Page): Promise<boolean> {
  const overlay = page.locator('.incoming-call-dialog');
  return await overlay.isVisible();
}

/**
 * Check if the call view is visible.
 */
export async function isCallViewVisible(page: Page): Promise<boolean> {
  const callView = page.locator('.call-view');
  return await callView.isVisible();
}

/**
 * Get the caller name from the incoming call overlay.
 */
export async function getIncomingCallerName(page: Page): Promise<string | null> {
  const callerName = page.locator('.incoming-call-dialog .caller-name, #incoming-call-title');
  if (await callerName.isVisible()) {
    return await callerName.textContent();
  }
  return null;
}
