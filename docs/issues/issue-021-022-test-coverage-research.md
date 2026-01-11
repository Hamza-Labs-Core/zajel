# Issue #21-22: Test Coverage Research

## Executive Summary

This document provides a comprehensive analysis of test coverage across the Zajel codebase, addressing PR review issues #21 (Missing tests for web client TypeScript code) and #22 (publicKeyBase64 getter lacks Dart tests).

**Current Status**:
- Issue #22 (Dart publicKeyBase64 getter): **RESOLVED** - Has comprehensive tests
- Issue #21 (Web client tests): **SIGNIFICANTLY IMPROVED** - crypto, signaling, webrtc, and validation now have tests
- **Remaining gaps identified** - fileTransferManager.ts, pwa.ts, errors.ts need tests

---

## Current Test Coverage Inventory

### Web Client (TypeScript) - packages/web-client/src/lib/

| Source File | Test File | Status | Lines | Coverage Notes |
|-------------|-----------|--------|-------|----------------|
| `crypto.ts` | `__tests__/crypto.test.ts` | **Covered** | 521 | Key generation, encryption, replay protection |
| `signaling.ts` | `__tests__/signaling.test.ts` | **Covered** | 687 | Connection states, message handling, pairing |
| `webrtc.ts` | `__tests__/webrtc.test.ts` | **Covered** | 978 | Peer connections, data channels, ICE handling |
| `validation.ts` | `__tests__/validation-xss.test.ts` | **Covered** | 400+ | XSS prevention, input sanitization |
| `protocol.ts` | N/A | N/A | - | Type definitions only (no executable code) |
| `constants.ts` | N/A | N/A | - | Constants only (no logic to test) |
| `fileTransferManager.ts` | **None** | **Missing** | 929 | **P0 - Critical: Reliable file transfer** |
| `pwa.ts` | **None** | **Missing** | 41 | P2 - PWA registration hook |
| `errors.ts` | **None** | **Missing** | 272 | P1 - Error classes and service |

### Dart App - packages/app/

| Source File | Test File | Status | Coverage Notes |
|-------------|-----------|--------|----------------|
| `crypto_service.dart` | `test/unit/crypto/crypto_service_test.dart` | **Covered** | Key generation, encryption, publicKeyBase64 |
| `signaling_client.dart` | `test/core/network/signaling_client_test.dart` | **Covered** | Connection, message handling |
| `connection_manager.dart` | `test/core/network/connection_manager_test.dart` | **Covered** | Connection lifecycle |
| `rendezvous_service.dart` | `test/unit/network/rendezvous_service_test.dart` | **Covered** | Meeting point discovery |
| `webrtc_service.dart` | **None** | **Missing** | P1 - Peer connections |
| `relay_client.dart` | **None** | **Missing** | P1 - Relay communication |
| `peer_reconnection_service.dart` | **None** | **Missing** | P2 - Reconnection logic |
| `server_discovery_service.dart` | **None** | **Missing** | P2 - Server discovery |

### Server VPS - packages/server-vps/tests/

| Source File | Test File | Status | Coverage Notes |
|-------------|-----------|--------|----------------|
| `storage/sqlite.ts` | `tests/unit/storage.test.ts` | **Covered** | Daily points, hourly tokens, membership |
| `client/handler.ts` | `tests/unit/client-handler-pairing.test.ts` | **Covered** | Pairing flow tests |
| `registry/*` | `tests/integration/distributed-rendezvous.test.ts` | **Covered** | Distributed registry |
| `federation/gossip/*` | **None** | **Missing** | P1 - Gossip protocol |
| `federation/dht/*` | **None** | **Missing** | P1 - Hash ring routing |
| `identity/*` | **None** | **Missing** | P2 - Server identity |

---

## Issue #22: publicKeyBase64 Getter - RESOLVED

The Dart `CryptoService.publicKeyBase64` getter is now fully tested:

```dart
// crypto_service.dart lines 44-49
String get publicKeyBase64 {
  if (_publicKeyBase64Cache == null) {
    throw CryptoException('CryptoService not initialized. Call initialize() first.');
  }
  return _publicKeyBase64Cache!;
}
```

**Existing tests in `crypto_service_test.dart`**:
1. `publicKeyBase64 sync getter works after initialization` - Verifies getter returns valid base64
2. `publicKeyBase64 sync getter throws before initialization` - Verifies CryptoException is thrown

**Verdict**: Issue #22 is fully addressed.

---

## Issue #21: Web Client Tests - SIGNIFICANTLY IMPROVED

### Already Tested Files

**crypto.test.ts (521 lines)**:
- Initialization and key generation
- Session establishment with validation
- Encrypt/decrypt for text and binary data
- Replay protection with sequence numbers
- Peer fingerprint verification
- Bidirectional communication
- Error cases (invalid keys, missing sessions)

**signaling.test.ts (687 lines)**:
- Pairing code validation
- Connection state management
- Message handling for all protocol types
- WebSocket lifecycle (connect, disconnect, reconnect)
- Ping/pong keepalive
- Pairing workflow
- WebRTC signaling methods

**webrtc.test.ts (978 lines)**:
- Peer connection as initiator/responder
- ICE candidate handling and queuing
- Offer/Answer negotiation
- Connection state transitions
- Message channel communication
- File channel operations
- Message size limits (1MB)
- Channel error handling
- Resource cleanup

**validation-xss.test.ts**:
- XSS attack prevention
- Input sanitization for filenames, messages, URLs
- Server message validation
- Data channel message validation

### Missing Tests - Priority List

| Priority | File | Test Complexity | Estimated Effort |
|----------|------|-----------------|------------------|
| **P0** | `fileTransferManager.ts` | High | 6-8 hours |
| **P1** | `errors.ts` | Low | 1-2 hours |
| **P2** | `pwa.ts` | Low | 1 hour |

---

## Priority Test Cases Needed

### P0: FileTransferManager Tests

The FileTransferManager (929 lines) is critical for reliable file transfers but has no tests.

**Key functionality requiring tests**:

| Method | Priority | Complexity | Notes |
|--------|----------|------------|-------|
| `sendFile()` | P0 | High | File chunking, hash computation |
| `handleFileStartAck()` | P0 | Medium | Start acknowledgment handling |
| `handleChunkAck()` | P0 | Medium | Chunk acknowledgment, retry triggering |
| `handleFileStart()` | P0 | Medium | Receiving file initiation |
| `handleFileChunk()` | P0 | High | Chunk reception, hash verification |
| `handleFileComplete()` | P0 | Medium | File assembly, hash verification |
| `cancelTransfer()` | P1 | Low | User cancellation |
| `retryTransfer()` | P1 | Medium | Retry logic |
| Timeout handling | P1 | Medium | Idle transfer detection |
| Backpressure | P1 | Medium | Buffer management |

**Test Template for FileTransferManager**:

```typescript
/**
 * FileTransferManager Tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileTransferManager, computeHash, computeFileHash } from '../fileTransferManager';

describe('FileTransferManager', () => {
  let manager: FileTransferManager;
  let mockEvents: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockEvents = {
      onTransferUpdate: vi.fn(),
      onTransferComplete: vi.fn(),
      onTransferFailed: vi.fn(),
      sendFileStart: vi.fn().mockReturnValue(true),
      sendFileChunk: vi.fn().mockReturnValue(true),
      sendFileComplete: vi.fn(),
      sendFileError: vi.fn(),
      sendFileStartAck: vi.fn(),
      sendChunkAck: vi.fn(),
      sendChunkRetryRequest: vi.fn(),
      sendFileCompleteAck: vi.fn(),
      sendTransferCancel: vi.fn(),
      getBufferedAmount: vi.fn().mockReturnValue(0),
      encrypt: vi.fn((data) => `encrypted:${data}`),
      decrypt: vi.fn((data) => data.replace('encrypted:', '')),
    };
    manager = new FileTransferManager(mockEvents);
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe('Hash computation', () => {
    it('should compute SHA-256 hash of data', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const hash = await computeHash(data);
      expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/); // Base64 format
    });

    it('should compute consistent hashes', async () => {
      const data = new Uint8Array([1, 2, 3]);
      const hash1 = await computeHash(data);
      const hash2 = await computeHash(data);
      expect(hash1).toBe(hash2);
    });

    it('should compute file hash from chunks', async () => {
      const chunks = [
        new Uint8Array([1, 2]),
        new Uint8Array([3, 4]),
      ];
      const hash = await computeFileHash(chunks);
      expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });
  });

  describe('Sending files', () => {
    it('should initiate file transfer', async () => {
      const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
      const fileId = await manager.sendFile(file);

      expect(fileId).toBeDefined();
      expect(mockEvents.sendFileStart).toHaveBeenCalled();
    });

    it('should handle file start acknowledgment', async () => {
      const file = new File(['test'], 'test.txt');
      const fileId = await manager.sendFile(file);

      manager.handleFileStartAck({ fileId, accepted: true });

      // Should start sending chunks
      vi.advanceTimersByTime(100);
      expect(mockEvents.sendFileChunk).toHaveBeenCalled();
    });

    it('should handle rejection', async () => {
      const file = new File(['test'], 'test.txt');
      const fileId = await manager.sendFile(file);

      manager.handleFileStartAck({ fileId, accepted: false, reason: 'too_large' });

      expect(mockEvents.onTransferFailed).toHaveBeenCalled();
    });
  });

  describe('Receiving files', () => {
    it('should accept valid file start', () => {
      const accepted = manager.handleFileStart('file-1', 'test.txt', 1024, 10);
      expect(accepted).toBe(true);
      expect(mockEvents.sendFileStartAck).toHaveBeenCalledWith('file-1', true);
    });

    it('should reject files exceeding max size', () => {
      const accepted = manager.handleFileStart('file-1', 'large.txt', 200 * 1024 * 1024, 1000);
      expect(accepted).toBe(false);
      expect(mockEvents.sendFileStartAck).toHaveBeenCalledWith('file-1', false, 'too_large');
    });

    it('should acknowledge received chunks', () => {
      manager.handleFileStart('file-1', 'test.txt', 1024, 1);
      manager.handleFileChunk('file-1', 0, 'encrypted:dGVzdA==', 'hash123');

      // After async hash computation
      vi.advanceTimersByTime(100);
      expect(mockEvents.sendChunkAck).toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should detect idle transfers', () => {
      manager.handleFileStart('file-1', 'test.txt', 1024, 10);

      // Advance past idle timeout (60 seconds)
      vi.advanceTimersByTime(70000);

      expect(mockEvents.sendTransferCancel).toHaveBeenCalledWith('file-1', 'timeout');
    });

    it('should handle chunk retry after max retries', async () => {
      const file = new File(['test'], 'test.txt');
      const fileId = await manager.sendFile(file);

      manager.handleFileStartAck({ fileId, accepted: true });

      // Simulate chunk timeouts
      for (let i = 0; i < 4; i++) {
        vi.advanceTimersByTime(6000); // Past CHUNK_ACK_TIMEOUT
      }

      expect(mockEvents.onTransferFailed).toHaveBeenCalled();
    });
  });

  describe('Cancellation', () => {
    it('should cancel ongoing transfer', async () => {
      const file = new File(['test'], 'test.txt');
      const fileId = await manager.sendFile(file);

      manager.cancelTransfer(fileId);

      expect(mockEvents.sendTransferCancel).toHaveBeenCalledWith(fileId, 'user_cancelled');
      const transfer = manager.getTransfer(fileId);
      expect(transfer?.state).toBe('cancelled');
    });
  });
});
```

### P1: Error Service Tests

```typescript
/**
 * Error Service Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ZajelError,
  CryptoError,
  ConnectionError,
  FileTransferError,
  ErrorCodes,
  errorService,
  handleError,
  isZajelError,
} from '../errors';

describe('Error Classes', () => {
  describe('ZajelError', () => {
    it('should create error with code and message', () => {
      const error = new ZajelError('test', ErrorCodes.UNKNOWN_ERROR);
      expect(error.code).toBe(ErrorCodes.UNKNOWN_ERROR);
      expect(error.message).toBe('test');
    });

    it('should provide user-friendly message', () => {
      const error = new ZajelError('internal', ErrorCodes.CRYPTO_NOT_INITIALIZED);
      expect(error.userMessage).toBe('Security initialization failed. Please refresh the page.');
    });

    it('should be recoverable by default', () => {
      const error = new ZajelError('test', ErrorCodes.UNKNOWN_ERROR);
      expect(error.recoverable).toBe(true);
    });
  });

  describe('CryptoError', () => {
    it('should be non-recoverable', () => {
      const error = new CryptoError('test');
      expect(error.recoverable).toBe(false);
    });
  });

  describe('ConnectionError', () => {
    it('should be recoverable by default', () => {
      const error = new ConnectionError('test');
      expect(error.recoverable).toBe(true);
    });
  });
});

describe('ErrorService', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('should notify subscribers on error', () => {
    const handler = vi.fn();
    const unsubscribe = errorService.subscribe(handler);

    const error = new ZajelError('test', ErrorCodes.UNKNOWN_ERROR);
    errorService.report(error);

    expect(handler).toHaveBeenCalledWith(error);
    unsubscribe();
  });

  it('should wrap unknown errors', () => {
    const wrapped = errorService.wrapError(new Error('native'), 'test context');
    expect(wrapped).toBeInstanceOf(ZajelError);
    expect(wrapped.message).toContain('native');
  });
});

describe('Type guards', () => {
  it('should identify ZajelError', () => {
    expect(isZajelError(new ZajelError('test', ErrorCodes.UNKNOWN_ERROR))).toBe(true);
    expect(isZajelError(new Error('test'))).toBe(false);
  });
});
```

---

## Test Infrastructure

### Web Client (TypeScript)

**Current Configuration** (vitest.config.ts):
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

**Run tests**:
```bash
cd packages/web-client
npm test              # Watch mode
npm run test:run      # Single run
npm run test:run -- --coverage  # With coverage
```

### Dart App

**Run tests**:
```bash
cd packages/app
flutter test                    # All tests
flutter test --coverage         # With coverage
flutter test test/unit/crypto/  # Specific directory
```

### Server VPS

**Run tests**:
```bash
cd packages/server-vps
npm test                        # Watch mode
npm run test:run                # Single run
npm run test:run -- --coverage  # With coverage
```

---

## Research: Industry Best Practices

### 1. Signal Protocol Testing (libsignal)

**Repository**: [github.com/signalapp/libsignal](https://github.com/signalapp/libsignal)

Signal's approach:
- Multi-language testing (Rust core with Java, Node.js, Swift bindings)
- Session lifecycle tests covering full key exchange
- Forward secrecy verification tests
- Constant-time operation tests for timing attack prevention

**Applicable patterns**:
- Test crypto session lifecycle end-to-end
- Verify key rotation behavior
- Test replay protection exhaustively

### 2. Matrix SDK Testing

**Repository**: [github.com/matrix-org/complement](https://github.com/matrix-org/complement)

Matrix uses Docker-based integration tests:
- Black-box testing against running servers
- Implementation-specific test blacklisting
- Separate E2EE test suite (Complement Crypto)

**Applicable patterns**:
- Consider Docker-based integration tests for VPS server
- Separate E2EE test suite for crypto paths

### 3. libsodium Testing

**Repository**: [github.com/jedisct1/libsodium](https://github.com/jedisct1/libsodium)

libsodium combines:
- Fixed test vectors from crypto-test-vectors project
- Randomized property-based testing
- Memory safety testing with Valgrind
- Multi-platform validation

**Applicable patterns**:
- Add fixed test vectors for crypto operations
- Consider property-based testing with fast-check

### 4. WebRTC Testing (Web Platform Tests)

**Repository**: [github.com/web-platform-tests/wpt/tree/master/webrtc](https://github.com/web-platform-tests/wpt/tree/master/webrtc)

WPT provides:
- Data channel buffer management tests
- Message ordering tests (2048 messages)
- Negotiation state machine tests

**Applicable patterns**:
- Test message ordering guarantees
- Test buffer backpressure handling
- Test concurrent transfers

### 5. MockRTC for WebRTC Testing

**Repository**: [github.com/httptoolkit/mockrtc](https://github.com/httptoolkit/mockrtc)

MockRTC enables:
- Mocking RTCPeerConnection globally
- Simulating network conditions
- Traffic interception for testing

**Already implemented**: Our webrtc.test.ts uses similar mocking patterns.

---

## Recommended Testing Strategy

### Immediate Actions (P0)

1. **Create fileTransferManager.test.ts** (6-8 hours)
   - Hash computation
   - Send flow with acknowledgments
   - Receive flow with verification
   - Retry logic
   - Timeout detection
   - Cancellation

2. **Add coverage thresholds to vitest.config.ts**:
```typescript
coverage: {
  thresholds: {
    lines: 75,
    functions: 75,
    branches: 65,
    statements: 75,
  },
}
```

### Medium-Term (P1)

1. **Create errors.test.ts** (1-2 hours)
   - Error class construction
   - User message mapping
   - Error service subscriptions
   - Type guards

2. **Add Dart WebRTC service tests** (4-6 hours)
   - Connection lifecycle
   - Data channel operations
   - ICE handling

3. **Add property-based testing**:
```bash
npm install --save-dev fast-check
```

### Long-Term (P2)

1. **Integration test suite**
   - End-to-end pairing flow
   - File transfer between two clients
   - Reconnection scenarios

2. **CI coverage reporting**
   - Add codecov or similar
   - Enforce coverage thresholds in PRs

3. **Server federation tests**
   - Gossip protocol tests
   - DHT routing tests

---

## Coverage Goals

| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| web-client/lib | ~70% | 85% | Missing fileTransferManager |
| app/lib/core | ~40% | 70% | Missing WebRTC, relay |
| server-vps/src | ~50% | 75% | Missing federation |

---

## Summary

### Issue #22: RESOLVED
The Dart `publicKeyBase64` getter has comprehensive tests covering both success and error cases.

### Issue #21: SIGNIFICANTLY IMPROVED
Web client test coverage has been substantially improved:
- crypto.ts: Fully tested
- signaling.ts: Fully tested
- webrtc.ts: Fully tested (978 lines of tests)
- validation.ts: Tested for XSS prevention

### Remaining Gaps
1. **fileTransferManager.ts** - Critical, needs tests immediately
2. **errors.ts** - Should have tests for error handling infrastructure
3. **Dart WebRTC/Relay services** - Need unit tests
4. **Server federation** - Gossip and DHT need tests

### Recommended Next Steps
1. Create fileTransferManager.test.ts (P0)
2. Add coverage thresholds to prevent regression
3. Create errors.test.ts (P1)
4. Set up CI coverage reporting

---

## Appendix: Test File Locations

### Web Client
```
packages/web-client/src/lib/__tests__/
  crypto.test.ts         (521 lines)
  signaling.test.ts      (687 lines)
  webrtc.test.ts         (978 lines)
  validation-xss.test.ts (400+ lines)
```

### Dart App
```
packages/app/test/
  unit/crypto/crypto_service_test.dart
  core/network/signaling_client_test.dart
  core/network/connection_manager_test.dart
  unit/network/rendezvous_service_test.dart
```

### Server VPS
```
packages/server-vps/tests/
  unit/storage.test.ts
  unit/client-handler-pairing.test.ts
  integration/distributed-rendezvous.test.ts
```

---

## Sources

- [Signal libsignal Repository](https://github.com/signalapp/libsignal)
- [Matrix Complement](https://github.com/matrix-org/complement)
- [libsodium Testing](https://libsodium.gitbook.io/doc/internals)
- [Web Platform Tests - WebRTC](https://github.com/web-platform-tests/wpt/tree/master/webrtc)
- [MockRTC](https://github.com/httptoolkit/mockrtc)
- [vitest-websocket-mock](https://github.com/akiomik/vitest-websocket-mock)
- [fast-check Property Testing](https://github.com/dubzzz/fast-check)
- [NIST CAVP](https://csrc.nist.gov/projects/cryptographic-algorithm-validation-program)
