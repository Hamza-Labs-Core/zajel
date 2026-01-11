# Issue #28: Replay Protection Window Memory Leak

## Summary

The `seenSequences` Set in `crypto.ts` implements a sliding window for replay attack protection but only cleans up old entries when a new highest sequence number arrives. In scenarios with one-directional communication or sparse message patterns, the Set can grow unbounded, causing memory leaks.

## Current Implementation Analysis

**File**: `/home/meywd/zajel/packages/web-client/src/lib/crypto.ts`
**Lines**: 210-232 (decrypt method), 287-305 (decryptBytes method)

### Code Flow

```typescript
// Constants
const SEQUENCE_WINDOW = 64; // Size of sliding window for out-of-order delivery

// State per peer
private seenSequences = new Map<string, Set<number>>();
private receiveCounters = new Map<string, number>();
```

### Current Sliding Window Logic

```typescript
if (seq > lastSeq) {
  // New highest sequence - advance the window
  // Clear sequences that are now outside the window
  const newWindowStart = seq - SEQUENCE_WINDOW;
  for (const oldSeq of seen) {
    if (oldSeq <= newWindowStart) {
      seen.delete(oldSeq);
    }
  }
  this.receiveCounters.set(peerId, seq);
  seen.add(seq);
} else if (seq <= lastSeq - SEQUENCE_WINDOW) {
  // Sequence is too old (outside the window)
  throw new Error('Replay attack detected: sequence too old');
} else {
  // Sequence is within the window - check if already seen
  if (seen.has(seq)) {
    throw new Error('Replay attack detected: duplicate sequence number');
  }
  seen.add(seq);  // <-- PROBLEM: No cleanup in this branch
}
```

### The Problem

The cleanup logic (`seen.delete(oldSeq)`) **only executes** when `seq > lastSeq`. In the `else` branch (lines 225-231), sequences are added to `seen` without any cleanup.

**Scenario**: One-directional or sparse communication where the sender sends messages with sequence numbers 1, 2, 3... but the receiver only occasionally responds. If the receiver's sequence numbers plateau (stop advancing), old entries never get cleaned up.

## Memory Growth Calculation

### Assumptions

- Window size: 64 (SEQUENCE_WINDOW constant)
- Each sequence number is a JavaScript number: 8 bytes
- Set overhead per entry: ~40 bytes (V8 engine)
- Total per entry: ~48 bytes

### Normal Operation (Bidirectional)

When sequences advance regularly:
- Maximum entries in Set: 64 (window size)
- Memory per peer: 64 * 48 = **3,072 bytes** (~3 KB)

### Worst Case (One-Directional)

If sender sends N messages but receiver never responds (or very rarely):
- All sequences within the valid window get added
- Example: Sender at sequence 1000, receiver at 50
  - Valid range: [937, 1000] (64 entries max)
  - But if receiver sent many messages without sender responding first...

**Wait - re-analysis needed**: Looking more carefully at the scenario:

The `seenSequences` tracks **incoming** sequences (decrypt side). The problem manifests when:

1. Receiver receives seq 1, 2, 3... (normal - these clean up)
2. BUT if messages arrive out-of-order within the window, they accumulate in the `else` branch

**Actual problematic scenario**:
- `lastSeq = 1000` (highest seen)
- Messages 937-999 arrive late (out of order)
- Each one adds to `seen` via the `else` branch (line 231)
- No cleanup until seq 1001+ arrives

If no new highest sequence ever arrives (communication stops after seq 1000), those 63 entries remain forever.

### Long-Running Session Impact

For a session that runs for hours with sporadic communication:
- Multiple peers: P peers
- Entries per peer: Up to SEQUENCE_WINDOW (64) stuck entries
- Memory: P * 64 * 48 bytes

With 10 peers and stuck entries: ~30 KB (not catastrophic but wasteful)

**Real concern**: The implementation uses 32-bit unsigned integers for sequence numbers (4 bytes in the protocol). A malicious or buggy peer could send sequences that cause excessive Set growth by manipulating the window boundaries.

## Proposed Solutions

### Solution 1: Periodic Cleanup Timer

**Approach**: Add a cleanup interval that prunes old entries even without new messages.

```typescript
private cleanupIntervals = new Map<string, NodeJS.Timeout>();
private readonly CLEANUP_INTERVAL_MS = 60000; // 1 minute

private scheduleCleanup(peerId: string): void {
  if (this.cleanupIntervals.has(peerId)) return;

  const interval = setInterval(() => {
    this.cleanupStaleSequences(peerId);
  }, this.CLEANUP_INTERVAL_MS);

  this.cleanupIntervals.set(peerId, interval);
}

private cleanupStaleSequences(peerId: string): void {
  const seen = this.seenSequences.get(peerId);
  const lastSeq = this.receiveCounters.get(peerId) || 0;
  if (!seen) return;

  const windowStart = lastSeq - SEQUENCE_WINDOW;
  for (const seq of seen) {
    if (seq <= windowStart) {
      seen.delete(seq);
    }
  }
}
```

**Pros**:
- Guarantees cleanup even in one-directional scenarios
- Minimal memory overhead

**Cons**:
- Timer management complexity
- Must clear intervals on session end
- Periodic CPU overhead even when not needed

---

### Solution 2: Max Size with LRU Eviction

**Approach**: Limit the Set size and evict oldest entries when exceeded.

```typescript
const MAX_SEEN_SIZE = SEQUENCE_WINDOW * 2; // Allow some buffer

// In else branch of decrypt:
if (seen.size >= MAX_SEEN_SIZE) {
  // Find and remove the oldest sequence
  let oldest = seq;
  for (const s of seen) {
    if (s < oldest) oldest = s;
  }
  seen.delete(oldest);
}
seen.add(seq);
```

**Pros**:
- Simple implementation
- Hard memory cap

**Cons**:
- O(n) eviction without a proper LRU structure
- May evict sequences still within valid window (security risk)
- Doesn't respect window semantics

---

### Solution 3: Bitmap-Based Window (Recommended)

**Approach**: Replace Set with a fixed-size bitmap. This is the standard approach used in DTLS, IPsec, and other security protocols.

```typescript
interface ReplayWindow {
  highestSeq: number;
  bitmap: bigint;  // 64-bit bitmap for window positions
}

private replayWindows = new Map<string, ReplayWindow>();

private checkReplay(peerId: string, seq: number): boolean {
  let window = this.replayWindows.get(peerId);
  if (!window) {
    window = { highestSeq: 0, bitmap: 0n };
    this.replayWindows.set(peerId, window);
  }

  if (seq > window.highestSeq) {
    // Advance the window
    const shift = seq - window.highestSeq;
    if (shift >= SEQUENCE_WINDOW) {
      window.bitmap = 1n; // Reset, only new seq is set
    } else {
      window.bitmap = (window.bitmap << BigInt(shift)) | 1n;
      // Mask to window size
      window.bitmap &= (1n << BigInt(SEQUENCE_WINDOW)) - 1n;
    }
    window.highestSeq = seq;
    return true; // Accept
  }

  if (seq <= window.highestSeq - SEQUENCE_WINDOW) {
    return false; // Too old
  }

  // Check bit in window
  const bitPosition = window.highestSeq - seq;
  const bit = 1n << BigInt(bitPosition);
  if (window.bitmap & bit) {
    return false; // Already seen
  }

  window.bitmap |= bit; // Mark as seen
  return true; // Accept
}
```

**Pros**:
- O(1) time complexity for all operations
- Fixed memory: exactly 8 bytes (bigint) + 4 bytes (number) = 12 bytes per peer
- No cleanup needed - inherently bounded
- Industry standard approach (RFC 4303 - ESP Anti-Replay)
- No timer overhead

**Cons**:
- Slightly more complex bit manipulation logic
- Window size limited to 64 bits (expandable with larger types)

---

### Solution 4: Hybrid Cleanup on Every Operation

**Approach**: Always cleanup in both branches, not just when advancing.

```typescript
if (seq > lastSeq) {
  const newWindowStart = seq - SEQUENCE_WINDOW;
  for (const oldSeq of seen) {
    if (oldSeq <= newWindowStart) {
      seen.delete(oldSeq);
    }
  }
  this.receiveCounters.set(peerId, seq);
  seen.add(seq);
} else if (seq <= lastSeq - SEQUENCE_WINDOW) {
  throw new Error('Replay attack detected: sequence too old');
} else {
  // Also cleanup here based on current lastSeq
  const windowStart = lastSeq - SEQUENCE_WINDOW;
  for (const oldSeq of seen) {
    if (oldSeq <= windowStart) {
      seen.delete(oldSeq);
    }
  }
  if (seen.has(seq)) {
    throw new Error('Replay attack detected: duplicate sequence number');
  }
  seen.add(seq);
}
```

**Pros**:
- Minimal code change
- Maintains existing data structure

**Cons**:
- O(n) cleanup on every message (up to 64 iterations)
- Still uses Set with overhead
- Doesn't address fundamental design issue

## Recommended Fix: Solution 3 (Bitmap-Based Window)

The bitmap approach is the industry standard for anti-replay protection and provides:

1. **Constant memory**: 12 bytes per peer regardless of message patterns
2. **O(1) operations**: No iteration needed for cleanup
3. **Proven security**: Used in IPsec (RFC 4303), DTLS, and other protocols
4. **No timers**: No background cleanup needed

### Implementation

Replace the current Set-based approach with a bitmap-based sliding window:

```typescript
// packages/web-client/src/lib/crypto.ts

// Replay protection constants
const SEQUENCE_WINDOW = 64; // Size of sliding window (max 64 for bigint)

interface ReplayWindow {
  highestSeq: number;  // Highest sequence number seen
  bitmap: bigint;      // Bitmap of seen sequences within window
}

export class CryptoService {
  private keyPair: KeyPair | null = null;
  private sessionKeys = new Map<string, Uint8Array>();
  private sendCounters = new Map<string, number>();

  // Bitmap-based replay windows (replaces seenSequences + receiveCounters)
  private replayWindows = new Map<string, ReplayWindow>();
  private replayWindowsBytes = new Map<string, ReplayWindow>();

  // ... (other methods unchanged)

  /**
   * Check if a sequence number should be accepted (not a replay).
   * Uses RFC 4303 anti-replay algorithm with bitmap sliding window.
   *
   * @returns true if sequence is valid (not a replay), false if replay detected
   */
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
      if (shift >= SEQUENCE_WINDOW) {
        // Jump is larger than window - reset bitmap
        window.bitmap = 1n;
      } else {
        // Shift the bitmap and set the new sequence bit
        window.bitmap = (window.bitmap << BigInt(shift)) | 1n;
        // Mask to window size to prevent unbounded growth
        window.bitmap &= (1n << BigInt(SEQUENCE_WINDOW)) - 1n;
      }
      window.highestSeq = seq;
      return true;
    }

    if (seq <= window.highestSeq - SEQUENCE_WINDOW) {
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

  clearSession(peerId: string): void {
    this.sessionKeys.delete(peerId);
    this.sendCounters.delete(peerId);
    this.replayWindows.delete(peerId);
    this.sendBytesCounters.delete(peerId);
    this.replayWindowsBytes.delete(peerId);
  }

  decrypt(peerId: string, ciphertextBase64: string): string {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) throw new Error(`No session for peer: ${peerId}`);

    const data = Uint8Array.from(atob(ciphertextBase64), (c) => c.charCodeAt(0));
    const nonce = data.slice(0, NONCE_SIZE);
    const ciphertext = data.slice(NONCE_SIZE);

    const cipher = chacha20poly1305(sessionKey, nonce);
    const combined = cipher.decrypt(ciphertext);

    // Extract and verify sequence number for replay protection
    const seq = new DataView(combined.buffer, combined.byteOffset, 4).getUint32(0, false);

    // Check for replay attacks using bitmap sliding window
    if (!this.checkAndUpdateReplayWindow(this.replayWindows, peerId, seq)) {
      throw new Error('Replay attack detected');
    }

    // Extract plaintext (skip 4-byte sequence number)
    const plaintextBytes = combined.slice(4);
    return new TextDecoder().decode(plaintextBytes);
  }

  decryptBytes(peerId: string, data: Uint8Array): Uint8Array {
    const sessionKey = this.sessionKeys.get(peerId);
    if (!sessionKey) throw new Error(`No session for peer: ${peerId}`);

    const nonce = data.slice(0, NONCE_SIZE);
    const ciphertext = data.slice(NONCE_SIZE);

    const cipher = chacha20poly1305(sessionKey, nonce);
    const combined = cipher.decrypt(ciphertext);

    // Extract and verify sequence number for replay protection
    const seq = new DataView(combined.buffer, combined.byteOffset, 4).getUint32(0, false);

    // Check for replay attacks using bitmap sliding window
    if (!this.checkAndUpdateReplayWindow(this.replayWindowsBytes, peerId, seq)) {
      throw new Error('Replay attack detected');
    }

    return combined.slice(4);
  }
}
```

### Memory Comparison

| Approach | Memory per Peer | Memory for 100 Peers |
|----------|-----------------|----------------------|
| Current (Set-based) | ~3 KB (worst: unbounded) | ~300 KB+ |
| Bitmap-based | 12 bytes | 1.2 KB |

### Security Considerations

1. **Window size remains 64**: Standard for most protocols
2. **Replay detection preserved**: Same security guarantees
3. **Out-of-order tolerance**: Still allows 64-packet reordering window
4. **Sequence 0 rejection**: Added explicit check for invalid sequence

### Testing Recommendations

Add unit tests for:

```typescript
describe('Replay Window', () => {
  it('accepts sequential sequences', () => { /* 1,2,3... */ });
  it('rejects duplicate sequences', () => { /* 1,1 -> fail */ });
  it('rejects too-old sequences', () => { /* 100 then 1 -> fail */ });
  it('accepts out-of-order within window', () => { /* 1,3,2 -> ok */ });
  it('handles large sequence jumps', () => { /* 1 then 1000 -> ok */ });
  it('memory stays bounded after many messages', () => { /* stress test */ });
});
```

## Research: How Other Apps Solve This

This section documents how production-grade security protocols implement replay protection without memory leaks.

### 1. Signal Protocol (Double Ratchet)

**Source**: [Signal Double Ratchet Specification](https://signal.org/docs/specifications/doubleratchet/)

Signal uses a fundamentally different approach: **unique per-message keys** rather than sequence number tracking.

#### Mechanism

- Every message is encrypted with a unique message key derived from a chain key
- Message keys can only decrypt one specific message
- The chain key is immediately replaced after deriving each message key
- Forward secrecy is maintained through continuous Diffie-Hellman ratcheting

#### Out-of-Order Message Handling

```
MKSKIPPED: Dictionary of skipped message keys indexed by (ratchet_public_key, message_number)
```

When messages arrive out of order:
1. Receiver advances the receiving ratchet to get appropriate message keys
2. **Skipped keys are stored** for later decryption of delayed messages
3. Keys are deleted after use or after timeout

#### Memory Bounds (MAX_SKIP)

Signal defines a `MAX_SKIP` constant to prevent DoS attacks:

```python
def SkipMessageKeys(state, until):
    if state.Nr + MAX_SKIP < until:
        raise Error()  # Reject: too many skipped messages
    # Store skipped keys in MKSKIPPED dictionary
```

**Recommendations from Signal spec**:
- Set `MAX_SKIP` high enough for routine lost/delayed messages
- Set low enough to prevent excessive computation/storage
- Recommended per-session limit: ~1000 skipped keys
- Delete skipped keys after an appropriate interval (timer or event-based)

#### Why This Works

- **No unbounded Set**: Skipped keys are bounded by `MAX_SKIP`
- **Time-based cleanup**: Keys are deleted after timeout
- **Event-based cleanup**: Aggressive cleanup after DH ratchet steps
- **Fixed overhead**: Known maximum memory per session

---

### 2. IPsec ESP (RFC 4303 / RFC 6479)

**Sources**:
- [RFC 4303 - ESP](https://datatracker.ietf.org/doc/html/rfc4303)
- [RFC 6479 - Anti-Replay Without Bit Shifting](https://www.rfc-editor.org/rfc/rfc6479.html)

IPsec uses the **bitmap sliding window** approach - the gold standard for O(1) memory replay protection.

#### Classic Algorithm (RFC 4303, Section 3.4.3)

```
Window: [WB, WT] where WB = WT - W + 1
- WT: highest sequence number received (top of window)
- WB: bottom of window (oldest acceptable sequence)
- W: window size (typically 64 bits)
```

**Check Algorithm**:
```c
if (S > WT) {
    // New highest - advance window
    shift = S - WT;
    if (shift >= W) {
        bitmap = 1;  // Reset, only new seq set
    } else {
        bitmap = (bitmap << shift) | 1;
        bitmap &= ((1 << W) - 1);  // Mask to window size
    }
    WT = S;
    return ACCEPT;
}

if (S < WB) {
    return REJECT;  // Too old
}

// Within window - check bitmap
bit_position = WT - S;
if (bitmap & (1 << bit_position)) {
    return REJECT;  // Already seen
}

bitmap |= (1 << bit_position);  // Mark as seen
return ACCEPT;
```

#### Optimized Algorithm (RFC 6479)

RFC 6479 improves on this with a **ring buffer approach** that avoids bit shifting:

```c
// Divide window into M blocks of N bits each
// M and N are powers of 2 (e.g., M=32, N=32 for 1024-bit window)
// Usable window = (M-1) * N = 992 bits

struct anti_replay {
    uint32_t bitmap[M];      // Ring buffer of blocks
    uint32_t last_seq;       // Highest sequence seen
    uint32_t window_base;    // Base of window (block index)
};
```

**Advantages**:
- No bit shifting needed when advancing window
- Only zeroes affected blocks (O(1) amortized)
- Fixed memory: `M * sizeof(block)` bytes per SA

#### Sequence Number Overflow

**32-bit sequences**: Must rekey before counter wraps (2^32 packets)
```
The transmitted sequence number must never be allowed to cycle.
A new SA must be established prior to the 2^32nd packet.
```

**64-bit Extended Sequence Numbers (ESN)**:
- Only low-order 32 bits transmitted
- High-order 32 bits used for integrity check
- Allows 2^64 packets before rekey
- Receiver must maintain proper window to determine high bits

#### Window Size Recommendations

| Environment | Recommended Size | Memory |
|-------------|------------------|--------|
| Low latency | 64 bits | 8 bytes |
| Standard | 256-512 bits | 32-64 bytes |
| High QoS/reordering | 1024-2048 bits | 128-256 bytes |
| Maximum | 4096 bits | 512 bytes |

> "Increasing the anti-replay window size has no impact on throughput and security. The impact on memory is insignificant." - Cisco Documentation

---

### 3. TLS 1.3 (RFC 8446)

**Source**: [RFC 8446 - TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html)

TLS 1.3 operates over TCP, which provides reliable in-order delivery. This simplifies replay protection.

#### Mechanism

- Each record has an implicit sequence number (not transmitted)
- Both parties maintain independent counters
- AEAD nonce derived from sequence number and IV
- **No sliding window needed** because TCP guarantees ordering

#### Record Layer Protection

```
nonce = iv XOR padded_sequence_number
ciphertext = AEAD_Encrypt(key, nonce, plaintext, additional_data)
```

The sequence number is:
- 64 bits, initialized to 0
- Incremented for each record
- Must not wrap (connection must close before 2^64 records)

#### 0-RTT Replay Considerations

TLS 1.3 early data (0-RTT) has **weaker replay protection**:

> "For 0-RTT data, there are no guarantees of non-replay between connections."

Mitigation strategies:
- Server maintains limited state of client tickets
- Applications must be idempotent for 0-RTT
- Can use single-use tickets (but requires server storage)

#### Why Memory-Efficient

- No bitmap needed (TCP ordering)
- Just a single 64-bit counter per direction
- Memory: 16 bytes total (send + receive counters)

---

### 4. DTLS 1.2/1.3 (RFC 6347 / RFC 9147)

**Sources**:
- [RFC 6347 - DTLS 1.2](https://datatracker.ietf.org/doc/html/rfc6347)
- [RFC 9147 - DTLS 1.3](https://www.rfc-editor.org/rfc/rfc9147.html)

DTLS is the datagram version of TLS, requiring explicit replay protection similar to IPsec.

#### Sliding Window Procedure

```
DTLS uses the same sliding window procedure as IPsec ESP (RFC 4303 Section 3.4.3):

1. Initialize receiver counter to 0 when session established
2. First packet has sequence number 1
3. Use sliding window to track received sequences
4. Minimum window size: 32 packets (MUST support)
5. Recommended window size: 64+ packets
```

#### OpenSSL Implementation

From [OpenSSL dtls1_bitmap.c](https://github.com/openssl/openssl/blob/master/ssl/record/dtls1_bitmap.c):

```c
// Sliding window maintained as bitmap
// Right edge = highest sequence seen
// Left edge = highest - window_size

if (seq > highest) {
    // Advance window, shift bitmap
    // Set new bit
} else if (seq < highest - window_size) {
    // Reject: too old
} else {
    // Check bitmap, reject if seen
    // Set bit if new
}
```

#### Key Implementation Notes

1. **Verify MAC before updating window**: Prevents attackers from manipulating window with invalid packets
2. **Silent rejection**: Invalid/duplicate packets are silently discarded
3. **Epoch handling**: Separate windows for each epoch (pre/post handshake)

---

### 5. libsodium secretstream

**Source**: [libsodium secretstream documentation](https://doc.libsodium.org/secret-key_cryptography/secretstream)

libsodium takes a **stateful streaming approach** with automatic nonce management.

#### State Structure

```c
crypto_secretstream_xchacha20poly1305_state {
    uint8_t k[32];     // Key (derived or rekeyed)
    uint8_t nonce[12]; // Current nonce
    // Internal: 32-bit counter + 64-bit derived nonce
}
```

#### Sequence/Nonce Management

```
Initial:
- Derive subkey k and 64-bit nonce n from master key K and 192-bit random N
- Initialize 32-bit counter i = 1

Per message:
- nonce_full = i || n
- encrypt with (k, nonce_full)
- n = n XOR mac[0..8]  // Mix authentication tag into nonce
- i = (i + 1) & 0xFFFFFFFF

On counter wrap (i == 0):
- Automatic rekey triggered
```

#### Automatic Rekeying

libsodium handles counter overflow automatically:

> "Rekeying happens automatically and transparently, before the internal counter wraps. Therefore, streams can be arbitrary large."

**Explicit rekey options**:
- `TAG_REKEY`: Forget previous keys, derive new key
- `TAG_FINAL`: End of stream, erase secret key
- `crypto_secretstream_xchacha20poly1305_rekey()`: Manual rekey

#### Memory Efficiency

- **Fixed state size**: ~56 bytes (key + nonce + counter)
- **No replay tracking needed**: Assumes reliable ordered delivery
- **Sender-side only**: Receiver must process in order

#### Limitations

- Designed for **streams** (ordered delivery assumed)
- No built-in out-of-order handling
- Not suitable for UDP without additional tracking

---

### Summary: Best Practices for Replay Protection

| Protocol | Approach | Memory per Session | Out-of-Order Support | Cleanup Strategy |
|----------|----------|-------------------|---------------------|------------------|
| Signal | Unique message keys + bounded skip list | O(MAX_SKIP) | Yes (bounded) | Timeout + event-based |
| IPsec | Bitmap sliding window | O(W) fixed (64-4096 bits) | Yes (window size) | Inherent (bitmap shift) |
| TLS 1.3 | Counter (TCP ordered) | O(1) - 16 bytes | N/A (TCP) | N/A |
| DTLS | Bitmap sliding window | O(W) fixed (32+ bits) | Yes (window size) | Inherent (bitmap shift) |
| libsodium | Stateful counter + auto-rekey | O(1) - 56 bytes | No | N/A (ordered assumed) |

### Key Takeaways for Implementation

1. **Use bitmap sliding window** for O(1) memory with datagram protocols
2. **64-bit window (bigint in JS)** is sufficient for most applications
3. **Larger windows (1024+)** recommended for high-reordering environments
4. **Automatic cleanup** is inherent to bitmap approach (no timers needed)
5. **Rekey before overflow**: Either at 2^32 or use extended 64-bit sequences
6. **Validate before updating**: Never update window state for invalid packets
7. **Silent rejection**: Discard duplicates/old packets without error response

### Recommended Implementation for Zajel

Based on this research, the bitmap-based sliding window (Solution 3 in this document) aligns with industry best practices:

```typescript
// Matches IPsec/DTLS approach
interface ReplayWindow {
    highestSeq: number;   // Highest sequence seen
    bitmap: bigint;       // 64-bit sliding window
}

// O(1) memory: 12 bytes per peer
// O(1) time: no iteration for cleanup
// Industry-proven: RFC 4303, RFC 6347
```

For enhanced robustness:
- Consider extending to 128-bit or 256-bit bitmap for high-reordering scenarios
- Implement session timeout to clear stale replay windows
- Consider ESN-style 64-bit sequences for very long-lived sessions

## References

- [RFC 4303 - IP Encapsulating Security Payload (ESP), Section 3.4.3](https://tools.ietf.org/html/rfc4303#section-3.4.3)
- [RFC 6347 - Datagram Transport Layer Security (DTLS), Section 4.1.2.6](https://tools.ietf.org/html/rfc6347#section-4.1.2.6)
- [RFC 6479 - IPsec Anti-Replay Algorithm without Bit Shifting](https://www.rfc-editor.org/rfc/rfc6479.html)
- [RFC 8446 - TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html)
- [RFC 9147 - DTLS 1.3](https://www.rfc-editor.org/rfc/rfc9147.html)
- [Signal Double Ratchet Specification](https://signal.org/docs/specifications/doubleratchet/)
- [libsodium secretstream Documentation](https://doc.libsodium.org/secret-key_cryptography/secretstream)
- [OpenSSL DTLS Replay Implementation](https://github.com/openssl/openssl/blob/master/ssl/record/dtls1_bitmap.c)
