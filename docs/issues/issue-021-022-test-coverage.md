# Issue #21-22: Test Coverage Analysis

## Executive Summary

This document analyzes the test coverage gaps identified in PR review issues #21 (Missing tests for web client TypeScript code) and #22 (publicKeyBase64 getter lacks Dart tests).

**Finding**: Issue #22 is **already resolved** - the Dart `publicKeyBase64` getter has comprehensive tests. Issue #21 is **partially resolved** - crypto and signaling have tests, but WebRTC lacks tests.

---

## Current Test Coverage Inventory

### Web Client (TypeScript) - packages/web-client/

| Source File | Test File | Status | Coverage Level |
|-------------|-----------|--------|----------------|
| `src/lib/crypto.ts` | `src/lib/__tests__/crypto.test.ts` | **Covered** | Comprehensive (521 lines) |
| `src/lib/signaling.ts` | `src/lib/__tests__/signaling.test.ts` | **Covered** | Comprehensive (687 lines) |
| `src/lib/webrtc.ts` | None | **Missing** | No tests |
| `src/lib/protocol.ts` | N/A | Type definitions only | No executable code to test |

### Dart App - packages/app/

| Source File | Test File | Status |
|-------------|-----------|--------|
| `lib/core/crypto/crypto_service.dart` | `test/unit/crypto/crypto_service_test.dart` | **Covered** |

---

## Issue #22: publicKeyBase64 Getter - RESOLVED

The Dart `CryptoService.publicKeyBase64` getter at line 44-49 of `crypto_service.dart`:

```dart
String get publicKeyBase64 {
  if (_publicKeyBase64Cache == null) {
    throw CryptoException('CryptoService not initialized. Call initialize() first.');
  }
  return _publicKeyBase64Cache!;
}
```

**Has the following existing tests** in `crypto_service_test.dart` (lines 27-49):

1. **`publicKeyBase64 sync getter works after initialization`** - Verifies the getter returns valid base64
2. **`publicKeyBase64 sync getter throws before initialization`** - Verifies CryptoException is thrown

**Verdict**: Issue #22 is fully addressed by existing tests.

---

## Issue #21: Web Client TypeScript Tests - PARTIALLY RESOLVED

### Already Tested: crypto.ts

The `crypto.test.ts` file (521 lines) covers:
- Initialization and key generation
- Session establishment with validation
- Encrypt/decrypt for text and binary data
- Replay protection with sequence numbers
- Peer fingerprint verification
- Bidirectional communication
- Error cases (invalid keys, missing sessions)

### Already Tested: signaling.ts

The `signaling.test.ts` file (687 lines) covers:
- Pairing code validation
- Connection state management
- Message handling for all protocol types
- WebSocket lifecycle (connect, disconnect, reconnect)
- Ping/pong keepalive
- Pairing workflow
- WebRTC signaling methods

### Missing Tests: webrtc.ts

The `webrtc.ts` file (275 lines) has **zero test coverage**.

---

## Priority Test Cases Needed

### P0 (Critical) - WebRTC Service Tests

The WebRTC service is critical for P2P communication but has no tests.

**Functions requiring tests:**

| Method | Priority | Complexity | Notes |
|--------|----------|------------|-------|
| `connect()` | P0 | High | Creates RTCPeerConnection, sets up data channels |
| `handleOffer()` | P0 | Medium | Handles incoming offers |
| `handleAnswer()` | P0 | Medium | Handles incoming answers |
| `handleIceCandidate()` | P0 | Low | Queues or adds ICE candidates |
| `sendMessage()` | P0 | Low | Sends encrypted messages |
| `sendHandshake()` | P1 | Low | Sends public key handshake |
| `sendFileStart/Chunk/Complete/Error()` | P1 | Low | File transfer methods |
| `close()` | P1 | Low | Cleanup |

---

## Test Infrastructure

### Web Client (TypeScript)

**Existing Setup** (vitest.config.ts):
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**'],
    },
    testTimeout: 10000,
  },
});
```

**Run tests**: `npm test` or `npm run test:run`

### Dart App

**Test dependencies** (from mocks.dart):
- `flutter_test`
- `mocktail` for mocking

**Existing mocks**:
- `MockFlutterSecureStorage`
- `MockCryptoService`
- `MockConnectionManager`
- `MockWebRTCService`
- `MockSignalingClient`
- `FakeSecureStorage` (in-memory implementation)
- `FakeWebSocketChannel`

**Run tests**: `flutter test`

---

## Test Templates

### WebRTC Service Test Template (webrtc.test.ts)

```typescript
/**
 * WebRTCService Tests
 *
 * Tests for WebRTC peer connections and data channels.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebRTCService, type WebRTCEvents } from '../webrtc';
import type { SignalingClient } from '../signaling';

// Mock RTCPeerConnection
class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: MockRTCDataChannel }) => void) | null = null;

  private localDescription: RTCSessionDescriptionInit | null = null;
  private remoteDescription: RTCSessionDescriptionInit | null = null;
  private dataChannels: Map<string, MockRTCDataChannel> = new Map();

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'mock-offer-sdp' };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'mock-answer-sdp' };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    // Mock implementation
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): MockRTCDataChannel {
    const channel = new MockRTCDataChannel(label);
    this.dataChannels.set(label, channel);
    return channel;
  }

  close(): void {
    this.connectionState = 'closed';
    if (this.onconnectionstatechange) {
      this.onconnectionstatechange();
    }
  }

  // Test helpers
  simulateConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    if (this.onconnectionstatechange) {
      this.onconnectionstatechange();
    }
  }

  simulateIceCandidate(candidate: RTCIceCandidateInit): void {
    if (this.onicecandidate) {
      this.onicecandidate({
        candidate: { toJSON: () => candidate } as RTCIceCandidate,
      });
    }
  }

  simulateIncomingDataChannel(label: string): MockRTCDataChannel {
    const channel = new MockRTCDataChannel(label);
    if (this.ondatachannel) {
      this.ondatachannel({ channel });
    }
    return channel;
  }
}

class MockRTCDataChannel {
  label: string;
  readyState: RTCDataChannelState = 'connecting';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: Event) => void) | null = null;
  private sentMessages: string[] = [];

  constructor(label: string) {
    this.label = label;
  }

  send(data: string): void {
    if (this.readyState !== 'open') {
      throw new Error('Data channel is not open');
    }
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = 'open';
    if (this.onopen) {
      this.onopen();
    }
  }

  simulateMessage(data: string): void {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }

  getSentMessages(): string[] {
    return this.sentMessages;
  }
}

// Mock SignalingClient
const createMockSignaling = (): SignalingClient => ({
  sendOffer: vi.fn(),
  sendAnswer: vi.fn(),
  sendIceCandidate: vi.fn(),
} as unknown as SignalingClient);

describe('WebRTCService', () => {
  let mockPeerConnection: MockRTCPeerConnection;
  let mockSignaling: SignalingClient;
  let events: WebRTCEvents;
  let service: WebRTCService;

  beforeEach(() => {
    // Mock RTCPeerConnection globally
    mockPeerConnection = new MockRTCPeerConnection();
    vi.stubGlobal(
      'RTCPeerConnection',
      vi.fn(() => mockPeerConnection)
    );

    mockSignaling = createMockSignaling();

    events = {
      onStateChange: vi.fn(),
      onHandshake: vi.fn(),
      onMessage: vi.fn(),
      onFileStart: vi.fn(),
      onFileChunk: vi.fn(),
      onFileComplete: vi.fn(),
      onFileError: vi.fn(),
    };

    service = new WebRTCService(mockSignaling, events);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('Connection as initiator', () => {
    it('should create peer connection and data channels', async () => {
      await service.connect('peer-123', true);

      expect(RTCPeerConnection).toHaveBeenCalledWith({
        iceServers: expect.any(Array),
      });
    });

    it('should create and send offer when initiator', async () => {
      await service.connect('peer-123', true);

      expect(mockSignaling.sendOffer).toHaveBeenCalledWith(
        'peer-123',
        expect.objectContaining({ type: 'offer' })
      );
    });

    it('should not send offer when not initiator', async () => {
      await service.connect('peer-123', false);

      expect(mockSignaling.sendOffer).not.toHaveBeenCalled();
    });
  });

  describe('ICE candidate handling', () => {
    it('should forward ICE candidates to signaling', async () => {
      await service.connect('peer-123', true);

      const candidate = { candidate: 'test-candidate', sdpMid: '0' };
      mockPeerConnection.simulateIceCandidate(candidate);

      expect(mockSignaling.sendIceCandidate).toHaveBeenCalledWith(
        'peer-123',
        candidate
      );
    });

    it('should queue candidates before connection is ready', async () => {
      const candidate = { candidate: 'early-candidate' };

      // Add candidate before connect
      await service.handleIceCandidate(candidate);

      // Now connect
      await service.connect('peer-123', false);

      // Candidate should have been added
      // (verify through mock if needed)
    });
  });

  describe('Offer/Answer handling', () => {
    it('should handle incoming offer and send answer', async () => {
      await service.connect('peer-123', false);

      const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: 'test-sdp' };
      await service.handleOffer(offer);

      expect(mockSignaling.sendAnswer).toHaveBeenCalledWith(
        'peer-123',
        expect.objectContaining({ type: 'answer' })
      );
    });

    it('should handle incoming answer', async () => {
      await service.connect('peer-123', true);

      const answer: RTCSessionDescriptionInit = { type: 'answer', sdp: 'test-sdp' };
      await service.handleAnswer(answer);

      // Verify remote description was set (if mock supports it)
    });
  });

  describe('Connection state', () => {
    it('should emit state changes', async () => {
      await service.connect('peer-123', true);

      mockPeerConnection.simulateConnectionState('connected');

      expect(events.onStateChange).toHaveBeenCalledWith('connected');
    });

    it('should report isConnected correctly', async () => {
      await service.connect('peer-123', true);

      expect(service.isConnected).toBe(false);

      mockPeerConnection.simulateConnectionState('connected');

      expect(service.isConnected).toBe(true);
    });
  });

  describe('Data channel - messages', () => {
    it('should send encrypted messages when channel is open', async () => {
      await service.connect('peer-123', true);

      // Get the message channel and open it
      const channels = (mockPeerConnection as any).dataChannels;
      const messageChannel = channels.get('messages');
      messageChannel.simulateOpen();

      service.sendMessage('encrypted-data');

      expect(messageChannel.getSentMessages()).toContain('encrypted-data');
    });

    it('should emit handshake events', async () => {
      await service.connect('peer-123', false);

      // Simulate incoming data channel
      const channel = mockPeerConnection.simulateIncomingDataChannel('messages');
      channel.simulateOpen();

      // Simulate handshake message
      channel.simulateMessage(JSON.stringify({ type: 'handshake', publicKey: 'peer-key' }));

      expect(events.onHandshake).toHaveBeenCalledWith('peer-key');
    });

    it('should emit message events for encrypted messages', async () => {
      await service.connect('peer-123', false);

      const channel = mockPeerConnection.simulateIncomingDataChannel('messages');
      channel.simulateOpen();

      // Simulate encrypted message (not JSON with type)
      channel.simulateMessage('encrypted-message-data');

      expect(events.onMessage).toHaveBeenCalledWith('encrypted-message-data');
    });
  });

  describe('Data channel - files', () => {
    it('should send file start notification', async () => {
      await service.connect('peer-123', true);

      const channels = (mockPeerConnection as any).dataChannels;
      const fileChannel = channels.get('files');
      fileChannel.simulateOpen();

      service.sendFileStart('file-1', 'test.txt', 1024, 10);

      const sent = fileChannel.getSentMessages();
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0])).toEqual({
        type: 'file_start',
        fileId: 'file-1',
        fileName: 'test.txt',
        totalSize: 1024,
        totalChunks: 10,
      });
    });

    it('should emit file events on receiving', async () => {
      await service.connect('peer-123', false);

      const channel = mockPeerConnection.simulateIncomingDataChannel('files');
      channel.simulateOpen();

      // File start
      channel.simulateMessage(JSON.stringify({
        type: 'file_start',
        fileId: 'file-1',
        fileName: 'test.txt',
        totalSize: 1024,
        totalChunks: 10,
      }));

      expect(events.onFileStart).toHaveBeenCalledWith('file-1', 'test.txt', 1024, 10);

      // File chunk
      channel.simulateMessage(JSON.stringify({
        type: 'file_chunk',
        fileId: 'file-1',
        chunkIndex: 0,
        data: 'base64-data',
      }));

      expect(events.onFileChunk).toHaveBeenCalledWith('file-1', 0, 'base64-data');

      // File complete
      channel.simulateMessage(JSON.stringify({
        type: 'file_complete',
        fileId: 'file-1',
      }));

      expect(events.onFileComplete).toHaveBeenCalledWith('file-1');
    });
  });

  describe('Message size limits', () => {
    it('should reject messages over 1MB', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await service.connect('peer-123', false);

      const channel = mockPeerConnection.simulateIncomingDataChannel('messages');
      channel.simulateOpen();

      // Create message larger than 1MB
      const largeMessage = 'x'.repeat(1024 * 1024 + 1);
      channel.simulateMessage(largeMessage);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('exceeds 1MB size limit')
      );
      expect(events.onMessage).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Cleanup', () => {
    it('should close all resources', async () => {
      await service.connect('peer-123', true);

      service.close();

      expect(mockPeerConnection.connectionState).toBe('closed');
    });

    it('should clear pending candidates on close', async () => {
      // Add candidate before connect
      await service.handleIceCandidate({ candidate: 'test' });

      await service.connect('peer-123', true);
      service.close();

      // Pending candidates should be cleared
      // (internal state, verify through behavior if needed)
    });
  });
});
```

---

## Test Infrastructure Recommendations

### 1. Create WebRTC Test File

Create `/home/meywd/zajel/packages/web-client/src/lib/__tests__/webrtc.test.ts` using the template above.

### 2. Add Integration Tests

Consider adding integration tests that test crypto + signaling + webrtc together:

```typescript
// integration.test.ts
describe('End-to-end peer connection', () => {
  it('should establish encrypted communication between two peers', async () => {
    // Alice and Bob both have crypto services
    // They exchange public keys via signaling
    // They establish WebRTC connection
    // They can send encrypted messages
  });
});
```

### 3. Update vitest.config.ts for Coverage Threshold

```typescript
export default defineConfig({
  test: {
    // ... existing config
    coverage: {
      // ... existing config
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
```

### 4. CI Integration

Ensure test commands run in CI:

```yaml
# In CI workflow
- name: Web Client Tests
  run: |
    cd packages/web-client
    npm run test:run

- name: Flutter Tests
  run: |
    cd packages/app
    flutter test
```

---

## Summary of Recommendations

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| P0 | Create webrtc.test.ts | 4 hours | High - critical path |
| P1 | Add coverage thresholds | 30 min | Medium - prevents regression |
| P2 | Add integration tests | 2 hours | Medium - catches interaction bugs |
| P2 | CI coverage reporting | 1 hour | Low - visibility |

---

## Appendix: Running Tests

### Web Client

```bash
cd packages/web-client

# Run all tests
npm test

# Run tests once (no watch)
npm run test:run

# Run with coverage
npm run test:run -- --coverage
```

### Flutter App

```bash
cd packages/app

# Run all tests
flutter test

# Run with coverage
flutter test --coverage

# Run specific test file
flutter test test/unit/crypto/crypto_service_test.dart
```

---

## Research: How Other Apps Solve This

This section documents testing strategies used by secure messaging apps and cryptographic libraries, providing patterns applicable to Zajel's test coverage improvements.

### 1. Signal Protocol Testing (libsignal)

**Repository**: [github.com/signalapp/libsignal](https://github.com/signalapp/libsignal)

#### Testing Approach

Signal's libsignal library employs a multi-layered testing strategy:

1. **Unit Tests by Category**:
   - `cargo test --test crypto_tests` - Cryptographic primitives
   - `cargo test --test curve_tests` - Elliptic curve operations (Curve25519)
   - `cargo test --test session_tests` - Session management (Double Ratchet)
   - `cargo test --test protobuf_tests` - Protocol buffer serialization

2. **Cross-Language Testing**:
   - Rust core with bindings tested in Java (`./gradlew test`), Node.js (`yarn test`), and Swift
   - Cross-version testing in `rust/protocol/cross-version-testing` ensures backward compatibility

3. **Comprehensive Test Flags**:
   ```bash
   cargo test --workspace --all-features --verbose --no-fail-fast -- --include-ignored
   ```

#### Key Testing Patterns

| Pattern | Description |
|---------|-------------|
| Session Lifecycle | Tests full session establishment, message exchange, key rotation |
| Forward Secrecy | Verifies old keys cannot decrypt new messages |
| Constant-Time Operations | Tests designed to detect timing leaks |
| Memory Safety | Rust's type system + extensive edge case testing |

#### Formal Verification

The [Inria-Prosecco libsignal-protocol-wasm-fstar](https://github.com/Inria-Prosecco/libsignal-protocol-wasm-fstar) project uses F* verification framework to prove security properties. Published at IEEE S&P 2019, demonstrating formal methods applied to Signal protocol.

**Relevance to Zajel**: Implement session lifecycle tests, test key rotation, and verify forward secrecy properties in crypto tests.

---

### 2. Telegram MTProto Testing

**Documentation**: [core.telegram.org/mtproto](https://core.telegram.org/mtproto)

#### Testing Approach

Telegram's MTProto 2.0 testing relies heavily on formal verification rather than published test vectors:

1. **ProVerif Symbolic Verification**:
   - [Automated Symbolic Verification of Telegram's MTProto 2.0](https://arxiv.org/abs/2012.03141) (arXiv)
   - Uses ProVerif cryptographic protocol verifier
   - Proves authentication, integrity, secrecy, and perfect forward secrecy

2. **Incremental Protocol Testing**:
   - Each protocol examined in isolation
   - Relies on guarantees from previous protocols + cryptographic primitives
   - Tested on laptop with 2GHz quad-core Intel Core i5, 16GB RAM using ProVerif v2.04

3. **GitHub Verification Resources**:
   - [miculan/telegram-mtproto2-verification](https://github.com/miculan/telegram-mtproto2-verification)
   - Provides ProVerif models for authentication, normal chat, E2EE chat, and re-keying

#### TL-Schema Testing

MTProto uses TL-Schema for protocol message definitions. The [current MTProto TL-schema](https://core.telegram.org/schema/mtproto) provides the canonical reference for implementation testing.

**Relevance to Zajel**: Consider formal verification for critical protocol paths; use schema-based testing for protocol messages.

---

### 3. Matrix Protocol Compliance Testing

**Repositories**:
- [matrix-org/complement](https://github.com/matrix-org/complement) - Compliance test suite
- [matrix-org/vodozemac](https://github.com/matrix-org/vodozemac) - Rust Olm/Megolm implementation

#### Complement Test Suite

Complement is a **black-box integration testing framework** for Matrix homeservers:

1. **Docker-Based Testing**:
   ```bash
   COMPLEMENT_BASE_IMAGE=some-matrix/homeserver-impl go test -v ./tests/...
   ```
   - Requires Docker API version 1.45+
   - Tests homeserver implementations without access to internals

2. **Implementation-Specific Blacklisting**:
   - Uses inverted build tags: `synapse_blacklist`, `dendrite_blacklist`, `conduit_blacklist`
   - Allows same test suite to run against different implementations

3. **Coverage Status**: 222 of 610 Sytest tests converted (as of 2025)

4. **E2EE Testing**: Separate [Complement Crypto](https://github.com/matrix-org/complement-crypto) repository for E2EE-specific tests

#### Vodozemac Testing

Vodozemac (pure Rust Olm/Megolm) has:
- **Independent Security Audit**: By Least Authority, funded by gematik
- **Code Coverage Tracking**: Uses codecov.yaml
- **CI/CD Pipeline**: GitHub Actions with clippy and rustfmt

Key security properties verified:
- Authentication and confidentiality
- Forward secrecy (subtle differences from Signal noted)
- Post-compromise security

**Relevance to Zajel**: Implement black-box integration tests; consider separate E2EE test suite; use Docker for reproducible test environments.

---

### 4. libsodium/NaCl Testing Strategy

**Repository**: [github.com/jedisct1/libsodium](https://github.com/jedisct1/libsodium)

#### Comprehensive Testing Approach

From [libsodium internals documentation](https://libsodium.gitbook.io/doc/internals):

1. **Test Suite Structure**:
   ```
   test/
   ├── default/     # Standard test cases
   ├── quirks/      # Edge cases and unusual conditions
   └── symbols/     # Symbol-related testing
   ```

2. **Fixed + Random Testing**:
   > "The test suite covers all the functions, symbols, and macros of the library built with --enable-minimal. In addition to fixed test vectors, all functions include non-deterministic tests using variable-length, random data."

3. **Memory Safety Testing**:
   > "Non-scalar parameters are stored into a region allocated with sodium_malloc() whenever possible. This immediately detects out-of-bounds accesses, including reads. The base address is also not guaranteed to be aligned, which helps detect mishandling of unaligned data."

#### Multi-Platform Validation

Tests must pass on all platforms before release:
- asmjs/V8 (node + browser), asmjs/SpiderMonkey, asmjs/JavaScriptCore
- WebAssembly/V8, WebAssembly/Firefox, WebAssembly/WASI
- Ubuntu/x86_64 with GCC 15 + `-fsanitize=address,undefined` + Valgrind (Memcheck, Helgrind, DRD, SGCheck)
- Ubuntu/x86_64 with Clang 21 + `-fsanitize=address,undefined` + Valgrind

#### Test Vectors

1. **crypto-test-vectors project**: [jedisct1/crypto-test-vectors](https://github.com/jedisct1/crypto-test-vectors)
   - Large collections of test vectors for cryptographic primitives
   - Generators for Ed25519, BLAKE2b, and more

2. **libsodium-validation**: [jedisct1/libsodium-validation](https://github.com/jedisct1/libsodium-validation)
   - Validates libsodium against crypto-test-vectors

3. **PyNaCl Reference Vectors**: [pynacl.readthedocs.io/en/latest/vectors/](https://pynacl.readthedocs.io/en/latest/vectors/)
   - Sources vectors from libsodium's test/default/*.c files
   - Includes secretstream, BLAKE2b, XChaCha20-Poly1305 vectors

**Relevance to Zajel**: Adopt fixed test vectors + random/fuzz testing; use sanitizers in CI; test on multiple platforms.

---

### 5. WebRTC Testing Patterns

#### Official Resources

1. **Web Platform Tests (WPT)**: [github.com/web-platform-tests/wpt/tree/master/webrtc](https://github.com/web-platform-tests/wpt/tree/master/webrtc)
   - Official W3C test suite for WebRTC
   - Dashboard: [wpt.fyi/webrtc](https://wpt.fyi/webrtc)

2. **WebRTC Test Pages**: [webrtc.github.io/test-pages/](https://webrtc.github.io/test-pages/)
   - Official test pages from webrtc.org

3. **Getting Started Testing**: [webrtc.org/getting-started/testing](https://webrtc.org/getting-started/testing)
   - Chrome command line flags for testing

#### Data Channel Test Coverage (WPT)

Key test files in WPT:
- `RTCDataChannel-send.html` - Buffer management, closure handling
- `RTCPeerConnection-onnegotiationneeded.html` - Negotiation state machine

Test scenarios include:
- Empty string transmission
- Blob message receiving
- 16 KiB x 64 data blocks
- InvalidStateError after channel closure
- Message ordering (2048 messages)

#### Mocking RTCPeerConnection

1. **MockRTC**: [github.com/httptoolkit/mockrtc](https://github.com/httptoolkit/mockrtc)
   - Powerful WebRTC mock peer & proxy
   - `hookAllWebRTC(mockPeer)` wraps global RTCPeerConnection
   - Enables traffic interception for testing

2. **vitest-websocket-mock**: [github.com/akiomik/vitest-websocket-mock](https://github.com/akiomik/vitest-websocket-mock)
   - Mock WebSockets with Vitest
   - Uses mock-socket under the hood
   - Caveat: `vi.useFakeTimers()` causes connection issues

3. **jest-websocket-mock**: [npmjs.com/package/jest-websocket-mock](https://www.npmjs.com/package/jest-websocket-mock)
   - Exposes WS class for mock servers
   - Custom matchers: `.toReceiveMessage`, `.toHaveReceivedMessages`

4. **mock-socket**: [github.com/thoov/mock-socket](https://github.com/thoov/mock-socket)
   - Underlying library for WebSocket mocking
   - Supports Socket.IO

**Relevance to Zajel**: Use WPT patterns for data channel tests; adopt MockRTC or mock-socket for integration tests; consider vitest-websocket-mock for signaling tests.

---

### 6. NIST CAVP Test Vectors

**Program**: [Cryptographic Algorithm Validation Program (CAVP)](https://csrc.nist.gov/projects/cryptographic-algorithm-validation-program)

#### Known Answer Test (KAT) Format

NIST provides standardized test vector formats:

1. **Response Files (.rsp)**:
   - Properly formatted test vectors
   - Vendor response files must match exactly

2. **Intermediate Results (.txt)**:
   - Debugging files with intermediate values
   - Monte Carlo tests show first 5 + final (10,000th) iteration

#### Algorithms with Test Vectors

| Algorithm | Source |
|-----------|--------|
| SHA1, SHA2 (224-512), SHA3 | NIST CAVP |
| SHAKE (128, 256) | NIST CAVP |
| AES (CBC, CFB, ECB, GCM, OFB, CCM) | NIST CAVP |
| RSA FIPS 186-2, PKCS1 v1.5 | NIST CAVP |
| DSA FIPS 186-2/186-3 | NIST CAVP |
| ECDSA FIPS 186-2/186-3 | NIST CAVP |
| DH, ECDH, ECDH+KDF | NIST CAVP |

**Relevance to Zajel**: Use NIST CAVP vectors for any NIST-approved algorithms; follow .rsp format for interoperability testing.

---

### 7. Property-Based Testing for Protocols

**Reference**: [Property-Based Testing for Cybersecurity](https://www.mdpi.com/2073-431X/14/5/179) (MDPI)

#### Key Frameworks

| Framework | Language | Best For |
|-----------|----------|----------|
| [QuickCheck](https://hackage.haskell.org/package/QuickCheck) | Haskell | Algebraic abstractions, protocol logic |
| [Hypothesis](https://hypothesis.works/) | Python | CI/CD integration, REST APIs, crypto interfaces |
| [PropEr](https://proper-testing.github.io/) | Erlang | Distributed systems, message passing |
| [quickcheck](https://github.com/BurntSushi/quickcheck) | Rust | Rust applications with shrinking |

#### Cryptographic Properties to Test

1. **Encryption/Decryption Roundtrip**:
   ```
   forall plaintext, key: decrypt(encrypt(plaintext, key), key) == plaintext
   ```

2. **Key Exchange Symmetry**:
   ```
   forall alice_key, bob_key: shared_secret(alice, bob) == shared_secret(bob, alice)
   ```

3. **Signature Verification**:
   ```
   forall message, key: verify(sign(message, key), message, public(key)) == true
   ```

4. **Replay Protection**:
   ```
   forall seq_nums: no duplicate seq_nums accepted
   ```

#### Industrial Use

Quviq QuickCheck tested industrial implementations of the Megaco protocol, finding faults early in development that other testing techniques missed.

**Relevance to Zajel**: Add property-based tests for crypto roundtrips, key exchange, and replay protection using Hypothesis (if Python) or fast-check (TypeScript).

---

### 8. Coverage Requirements for Security-Critical Code

#### FIPS 140-3 Requirements

From [NIST FIPS 140-3](https://csrc.nist.gov/pubs/fips/140-3/final):

Security requirements cover 11 areas:
1. Specification
2. Ports and interfaces
3. Roles, services, and authentication
4. Finite state model
5. Physical security
6. Operational environment
7. Cryptographic key management
8. EMI/EMC
9. **Self-tests** (critical for crypto modules)
10. Design assurance
11. Mitigation of other attacks

#### Self-Test Requirements

FIPS 140 requires cryptographic modules to run self-tests before cryptographic operations. These verify:
- Module functioning properly
- Algorithm implementations correct
- No tampering detected

#### Industry Best Practices

| Metric | Recommended Minimum |
|--------|---------------------|
| Line Coverage | 80%+ for crypto code |
| Branch Coverage | 70%+ |
| Function Coverage | 100% for public API |
| Mutation Testing | Consider for critical paths |

**Relevance to Zajel**: Implement self-tests for crypto initialization; aim for 80%+ line coverage on security-critical code; use coverage thresholds in CI.

---

### Summary: Applicable Patterns for Zajel

#### Immediate Actions (P0)

1. **WebRTC Tests**: Use MockRTC or mock-socket patterns from the test template in this document
2. **Crypto Test Vectors**: Add known-answer tests based on libsodium's test vector approach
3. **WebSocket Mocking**: Use vitest-websocket-mock (already compatible with Vitest setup)

#### Medium-Term (P1)

1. **Property-Based Testing**: Add fast-check for TypeScript property-based tests
   ```bash
   npm install --save-dev fast-check
   ```

2. **Integration Tests**: Create Docker-based integration tests like Matrix Complement

3. **Coverage Thresholds**: Add to vitest.config.ts:
   ```typescript
   coverage: {
     thresholds: {
       lines: 80,
       functions: 80,
       branches: 70,
       statements: 80,
     },
   }
   ```

#### Long-Term (P2)

1. **Formal Verification**: Consider ProVerif or similar for protocol verification
2. **Cross-Platform Testing**: Test on multiple browsers/environments like libsodium
3. **Security Audit**: Consider independent audit like vodozemac's Least Authority audit

---

### Sources

- [Signal libsignal Repository](https://github.com/signalapp/libsignal)
- [Signal Protocol Documentation](https://signal.org/docs/)
- [Telegram MTProto Documentation](https://core.telegram.org/mtproto)
- [MTProto 2.0 Verification](https://github.com/miculan/telegram-mtproto2-verification)
- [Matrix Complement](https://github.com/matrix-org/complement)
- [Matrix vodozemac](https://github.com/matrix-org/vodozemac)
- [libsodium Documentation](https://libsodium.gitbook.io/doc/internals)
- [libsodium-validation](https://github.com/jedisct1/libsodium-validation)
- [crypto-test-vectors](https://github.com/jedisct1/crypto-test-vectors)
- [Web Platform Tests - WebRTC](https://github.com/web-platform-tests/wpt/tree/master/webrtc)
- [MockRTC](https://github.com/httptoolkit/mockrtc)
- [vitest-websocket-mock](https://github.com/akiomik/vitest-websocket-mock)
- [NIST CAVP](https://csrc.nist.gov/projects/cryptographic-algorithm-validation-program)
- [FIPS 140-3](https://csrc.nist.gov/pubs/fips/140-3/final)
- [Property-Based Testing for Cybersecurity](https://www.mdpi.com/2073-431X/14/5/179)
- [Hypothesis](https://hypothesis.works/)
