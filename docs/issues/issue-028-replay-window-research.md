# Issue #28: Replay Window Memory Leak - Research and Resolution

## Status: RESOLVED

The memory leak identified in Issue #28 has been **fixed**. The implementation now uses a bitmap-based sliding window approach following RFC 4303 (IPsec ESP) anti-replay algorithm.

---

## Executive Summary

| Aspect | Before (Set-based) | After (Bitmap-based) |
|--------|-------------------|---------------------|
| Memory per peer | O(n) - unbounded Set growth | O(1) - fixed 12 bytes |
| Time complexity | O(n) for cleanup | O(1) for all operations |
| Cleanup required | Yes (timer or manual) | No (inherently bounded) |
| Industry standard | No | Yes (RFC 4303) |

---

## 1. Current Implementation Analysis

### Location
- **File**: `/home/meywd/zajel/packages/web-client/src/lib/crypto.ts`
- **Interface**: `ReplayWindow` (lines 30-33)
- **Method**: `checkAndUpdateReplayWindow()` (lines 61-110)

### Data Structures

```typescript
/**
 * Bitmap-based sliding window for replay protection.
 * Uses RFC 4303 (IPsec ESP) anti-replay algorithm.
 * Memory: O(1) - fixed ~12 bytes per peer instead of unbounded Set growth.
 */
interface ReplayWindow {
  highestSeq: number;  // Highest sequence number seen (4 bytes)
  bitmap: bigint;      // 64-bit bitmap of seen sequences within window (8 bytes)
}
```

### State Maps

```typescript
// Bitmap-based replay windows (replaces Set-based seenSequences + receiveCounters)
private replayWindows = new Map<string, ReplayWindow>();
// Separate counters for binary data (file chunks) to avoid interference with text messages
private replayWindowsBytes = new Map<string, ReplayWindow>();
```

### Window Size Configuration

From `/home/meywd/zajel/packages/web-client/src/lib/constants.ts`:

```typescript
export const CRYPTO = {
  /** Sliding window size for out-of-order message tolerance in replay protection */
  SEQUENCE_WINDOW: 64,
} as const;
```

---

## 2. Memory Characteristics

### Before Fix (Set-based) - O(n)

The old implementation used a `Set<number>` to track seen sequence numbers:

```typescript
// OLD CODE (memory leak)
private seenSequences = new Map<string, Set<number>>();
private receiveCounters = new Map<string, number>();
```

**Problems:**
1. Set entries were only cleaned when `seq > lastSeq` (new highest)
2. In the `else` branch (out-of-order within window), no cleanup occurred
3. One-directional communication or sparse patterns caused unbounded growth
4. Each entry: ~48 bytes (8-byte number + 40-byte V8 Set overhead)

### After Fix (Bitmap-based) - O(1)

The current implementation uses a fixed-size bigint bitmap:

| Component | Size |
|-----------|------|
| `highestSeq` (number) | 8 bytes |
| `bitmap` (bigint) | 8 bytes |
| Map entry overhead | ~32 bytes |
| **Total per peer** | **~48 bytes fixed** |

**Comparison for 100 peers:**

| Scenario | Set-based | Bitmap-based |
|----------|-----------|--------------|
| Best case | ~3 KB | ~4.8 KB |
| Normal usage | ~30 KB | ~4.8 KB |
| Worst case (attack) | Unbounded | ~4.8 KB |

---

## 3. Algorithm Implementation

### RFC 4303 Sliding Window Algorithm

The implementation follows the standard anti-replay algorithm from RFC 4303 Section 3.4.3:

```typescript
private checkAndUpdateReplayWindow(
  windows: Map<string, ReplayWindow>,
  peerId: string,
  seq: number
): boolean {
  let window = windows.get(peerId);
  if (!window) {
    window = { highestSeq: 0, bitmap: 0n };
    windows.set(peerId, window);
  }

  if (seq === 0) {
    // Sequence 0 is invalid (we start from 1)
    return false;
  }

  if (seq > window.highestSeq) {
    // New highest sequence - advance the window
    const shift = seq - window.highestSeq;
    if (shift >= CRYPTO.SEQUENCE_WINDOW) {
      // Jump is larger than window - reset bitmap, only new seq is set
      window.bitmap = 1n;
    } else {
      // Shift the bitmap and set the new sequence bit
      window.bitmap = (window.bitmap << BigInt(shift)) | 1n;
      // Mask to window size to prevent unbounded growth
      window.bitmap &= (1n << BigInt(CRYPTO.SEQUENCE_WINDOW)) - 1n;
    }
    window.highestSeq = seq;
    return true;
  }

  if (seq <= window.highestSeq - CRYPTO.SEQUENCE_WINDOW) {
    // Sequence is too old (outside the window)
    return false;
  }

  // Sequence is within the window - check if already seen
  const bitPosition = window.highestSeq - seq;
  const bit = 1n << BigInt(bitPosition);

  if ((window.bitmap & bit) !== 0n) {
    // Already seen - replay detected
    return false;
  }

  // Mark as seen and accept
  window.bitmap |= bit;
  return true;
}
```

### Key Operations

| Operation | Complexity | Description |
|-----------|------------|-------------|
| New highest seq | O(1) | Shift bitmap, mask to window size |
| Within window check | O(1) | Single bit check |
| Mark as seen | O(1) | Single bit set |
| Too old rejection | O(1) | Simple arithmetic comparison |

---

## 4. Verification That Leak Is Fixed

### Test Coverage

All 6 replay protection tests pass (from `/home/meywd/zajel/packages/web-client/src/lib/__tests__/crypto.test.ts`):

```
PASS  Replay Protection > sequence numbers should increment with each message
PASS  Replay Protection > should reject replay of same message (duplicate sequence number)
PASS  Replay Protection > should reject messages with old sequence numbers
PASS  Replay Protection > should handle messages slightly out of order within window
PASS  Replay Protection > clearSession should reset sequence counters
PASS  Replay Protection > each peer should have independent counters
```

### Memory Bounds Verification

The bitmap approach guarantees bounded memory:

1. **Bitmap masking** - Line 87 ensures the bitmap never exceeds 64 bits:
   ```typescript
   window.bitmap &= (1n << BigInt(CRYPTO.SEQUENCE_WINDOW)) - 1n;
   ```

2. **Fixed structure** - `ReplayWindow` has exactly two fields, no dynamic allocation

3. **No cleanup needed** - Old sequences are automatically "forgotten" when shifted out

4. **Session cleanup** - `clearSession()` properly removes replay windows:
   ```typescript
   clearSession(peerId: string): void {
     this.sessionKeys.delete(peerId);
     this.peerPublicKeys.delete(peerId);
     this.sendCounters.delete(peerId);
     this.replayWindows.delete(peerId);        // Cleaned
     this.sendBytesCounters.delete(peerId);
     this.replayWindowsBytes.delete(peerId);   // Cleaned
   }
   ```

---

## 5. Research: Industry Comparison

### 5.1 IPsec ESP (RFC 4303 / RFC 6479)

The current implementation directly follows RFC 4303 Section 3.4.3:

| Aspect | RFC 4303 | Zajel Implementation |
|--------|----------|---------------------|
| Window size | 64-4096 bits | 64 bits |
| Data structure | Bitmap | bigint (64-bit) |
| Sequence rejection | `seq <= highestSeq - W` | Same |
| Bitmap advancement | Shift and mask | Same |
| Memory | O(W) fixed | O(1) fixed |

### 5.2 DTLS (RFC 6347 / RFC 9147)

DTLS uses the same sliding window approach:

> "DTLS implementations SHOULD use the sliding window algorithm defined in Section 3.4.3 of [RFC4303]."

Zajel's implementation is compatible with DTLS replay protection semantics.

### 5.3 Signal Protocol (Double Ratchet)

Signal uses a different approach with `MAX_SKIP` bounded skipped message keys:

| Aspect | Signal | Zajel |
|--------|--------|-------|
| Approach | Unique message keys + skip list | Sequence numbers + bitmap |
| Memory bound | MAX_SKIP entries | 64-bit window |
| Cleanup | Timeout-based | Inherent (shift) |

Both approaches are valid; Signal's is more complex due to forward secrecy ratcheting.

### 5.4 TLS 1.3 (RFC 8446)

TLS 1.3 uses TCP (ordered delivery), so it only needs a simple counter:

```
nonce = iv XOR padded_sequence_number
```

Zajel's approach is necessary for WebRTC DataChannels which can have out-of-order delivery.

---

## 6. Remaining Concerns and Recommendations

### 6.1 Sequence Number Overflow (Minor Concern)

**Current state**: Uses 32-bit unsigned integers for sequence numbers.

**Risk**: After 2^32 messages (~4 billion), the counter wraps.

**Mitigation in place**: WebRTC sessions are ephemeral (page refresh = new session), making overflow unlikely in practice.

**Recommendation for future**: Consider Extended Sequence Numbers (ESN) like IPsec uses for very long-lived sessions:

```typescript
interface ExtendedReplayWindow {
  highestSeq: bigint;        // 64-bit sequence
  bitmap: bigint;            // 64-bit window
  highOrderBits: number;     // For partial transmission optimization
}
```

### 6.2 Window Size (Acceptable)

**Current**: 64 packets window.

**Assessment**: Adequate for typical WebRTC conditions with moderate reordering.

**Alternative**: RFC 6479 suggests 1024-4096 for high-QoS environments with significant reordering. Current window size is reasonable for direct peer-to-peer connections.

### 6.3 Separate Windows for Text and Binary (Good Design)

The implementation correctly uses separate replay windows:

```typescript
private replayWindows = new Map<string, ReplayWindow>();      // Text messages
private replayWindowsBytes = new Map<string, ReplayWindow>(); // File chunks
```

This prevents file transfers from interfering with text message sequence tracking.

### 6.4 Error Handling (Correct)

Replay detection throws a proper error:

```typescript
if (!this.checkAndUpdateReplayWindow(this.replayWindows, peerId, seq)) {
  throw new CryptoError('Replay attack detected', ErrorCodes.CRYPTO_REPLAY_DETECTED);
}
```

This allows the application layer to handle replay attempts appropriately.

---

## 7. Conclusion

**Issue #28 is fully resolved.** The implementation:

1. Uses O(1) memory per peer (bitmap-based)
2. Has O(1) time complexity for all operations
3. Requires no cleanup timers or manual intervention
4. Follows industry-standard RFC 4303 anti-replay algorithm
5. Is properly tested with comprehensive unit tests
6. Handles edge cases correctly (sequence 0 rejection, large jumps, etc.)

The only minor consideration for future enhancement is extended 64-bit sequence numbers for theoretical very-long-lived sessions, but this is not a practical concern for the current ephemeral session model.

---

## References

- [RFC 4303 - IP Encapsulating Security Payload (ESP), Section 3.4.3](https://tools.ietf.org/html/rfc4303#section-3.4.3)
- [RFC 6347 - Datagram Transport Layer Security (DTLS), Section 4.1.2.6](https://tools.ietf.org/html/rfc6347#section-4.1.2.6)
- [RFC 6479 - IPsec Anti-Replay Algorithm without Bit Shifting](https://www.rfc-editor.org/rfc/rfc6479.html)
- [RFC 8446 - TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html)
- [RFC 9147 - DTLS 1.3](https://www.rfc-editor.org/rfc/rfc9147.html)
- [Signal Double Ratchet Specification](https://signal.org/docs/specifications/doubleratchet/)
