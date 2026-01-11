# Issue #24: File Transfer Chunk Retry Mechanism - Research Report

## Executive Summary

This document provides a comprehensive analysis of the current file transfer implementation in Zajel and research on best practices for reliable file transfer protocols. The codebase has already implemented a substantial reliable file transfer system with chunk-level acknowledgments and retry mechanisms.

## Current Implementation Analysis

### Protocol Messages (protocol.ts)

The codebase already defines a comprehensive reliable file transfer protocol:

#### Existing Message Types

```typescript
// Basic file transfer messages
FileStartMessage {
  type: 'file_start';
  fileId: string;
  fileName: string;
  totalSize: number;
  totalChunks: number;
  chunkHashes?: string[];  // SHA-256 hashes for chunk verification
}

FileChunkMessage {
  type: 'file_chunk';
  fileId: string;
  chunkIndex: number;
  data: string;  // base64 encrypted
  hash?: string; // SHA-256 hash of this chunk
}

FileCompleteMessage {
  type: 'file_complete';
  fileId: string;
  fileHash?: string;  // SHA-256 hash of complete file
}

// Reliable transfer protocol messages (already implemented!)
FileStartAckMessage {
  type: 'file_start_ack';
  fileId: string;
  accepted: boolean;
  reason?: string;  // 'too_large', 'unsupported_type', etc.
}

ChunkAckMessage {
  type: 'chunk_ack';
  fileId: string;
  chunkIndex: number;
  status: 'received' | 'failed';
  hash?: string;  // SHA-256 of received chunk for verification
}

ChunkRetryRequestMessage {
  type: 'chunk_retry';
  fileId: string;
  chunkIndices: number[];  // Request retransmission of specific chunks
}

FileCompleteAckMessage {
  type: 'file_complete_ack';
  fileId: string;
  status: 'success' | 'failed';
  missingChunks?: number[];
  fileHash?: string;
}

TransferCancelMessage {
  type: 'transfer_cancel';
  fileId: string;
  reason: 'user_cancelled' | 'error' | 'timeout';
}
```

#### Transfer State Machine

```typescript
type TransferState =
  | 'pending'
  | 'awaiting_start_ack'
  | 'transferring'
  | 'awaiting_complete_ack'
  | 'receiving'
  | 'sending'
  | 'complete'
  | 'failed'
  | 'cancelled';
```

### WebRTC Service (webrtc.ts)

The WebRTC service implements:

1. **Backpressure Handling**: Uses `bufferedAmountLowThreshold` event for efficient flow control
   - HIGH_WATER_MARK: 1MB (pause threshold)
   - LOW_WATER_MARK: 256KB (resume threshold)
   - BUFFER_DRAIN_TIMEOUT: 30 seconds

2. **All Protocol Methods**:
   - `sendFileStart()` - Returns boolean for success/failure
   - `sendFileChunk()` - Async with backpressure, returns Promise<boolean>
   - `sendFileComplete()` - Includes file hash
   - `sendFileStartAck()` - Accept/reject with reason
   - `sendChunkAck()` - Per-chunk acknowledgment with hash
   - `sendChunkRetryRequest()` - Request specific chunk retransmissions
   - `sendFileCompleteAck()` - Final verification with missing chunks list
   - `sendTransferCancel()` - Clean cancellation

3. **Event System**: All reliable protocol events are wired up:
   - `onFileStartAck?`
   - `onChunkAck?`
   - `onChunkRetryRequest?`
   - `onFileCompleteAck?`
   - `onTransferCancel?`

### FileTransferManager (fileTransferManager.ts)

A comprehensive file transfer manager has been implemented with:

#### Configuration Constants
```typescript
CHUNK_SIZE = 16 * 1024;           // 16KB chunks (WebRTC-safe)
MAX_RETRIES_PER_CHUNK = 3;        // 3 retries before failure
CHUNK_ACK_TIMEOUT = 5000;         // 5 seconds per-chunk timeout
TRANSFER_IDLE_TIMEOUT = 60000;    // 1 minute idle timeout
MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB buffer limit
MAX_CHUNKS_IN_FLIGHT = 10;        // Sliding window size
```

#### Key Features Implemented

1. **SHA-256 Hash Computation**
   - `computeHash()` - Per-chunk hashing
   - `computeFileHash()` - Complete file hashing

2. **Chunk Tracking (Sender Side)**
   ```typescript
   interface SentChunkInfo {
     data: string;      // Encrypted base64 data
     hash: string;      // SHA-256 of plaintext chunk
     sentAt: number;    // Timestamp
     retries: number;   // Current retry count
     acked: boolean;    // Acknowledgment received
   }
   ```

3. **Chunk Tracking (Receiver Side)**
   ```typescript
   interface ReceivedChunkInfo {
     data: Uint8Array;
     hash: string;
     receivedAt: number;
   }
   ```

4. **Sliding Window Protocol**
   - `sendChunksWithWindow()` - Sends up to MAX_CHUNKS_IN_FLIGHT concurrently
   - Waits when window is full
   - Monitors chunk acknowledgments

5. **Per-Chunk Timeout Mechanism**
   - Individual timeouts for each chunk
   - `setChunkTimeout()` - Schedules retry
   - `handleChunkTimeout()` - Triggers resend

6. **Idle Transfer Detection**
   - Periodic check every 10 seconds
   - Fails transfers idle for more than 60 seconds
   - Sends `transfer_cancel` with 'timeout' reason

7. **Progress Tracking**
   ```typescript
   interface FileTransfer {
     ackedChunks?: number;
     failedChunks?: number[];
     retryCount?: number;
     state?: TransferState;
     lastActivityTime?: number;
     transferSpeed?: number;
     estimatedTimeRemaining?: number;
     direction?: 'sending' | 'receiving';
   }
   ```

8. **Hash Verification**
   - Sender computes and sends chunk hashes in `file_start`
   - Receiver verifies each chunk against expected hash
   - Full file hash verification on completion

9. **Missing Chunk Detection**
   - On `file_complete`, receiver identifies missing chunks
   - Sends `file_complete_ack` with `missingChunks` array
   - Also sends `chunk_retry` request for immediate resend

### UI Components (FileTransfer.tsx)

The UI already supports:
- Progress bar with percentage
- Transfer speed display (KB/s, MB/s)
- Estimated time remaining
- Retry count display
- Failed chunk count display
- Cancel button for active transfers
- Retry button for failed receiving transfers
- Direction indicator ([Sending] / [Receiving])
- Status messages for all transfer states

## Missing Features / Gaps Identified

### 1. Exponential Backoff for Retries

**Current State**: Retries use a fixed 5-second timeout with up to 3 attempts.

**Recommendation**: Implement exponential backoff with jitter to prevent thundering herd:

```typescript
function calculateBackoff(retryCount: number): number {
  const baseDelay = 1000; // 1 second
  const maxDelay = 30000; // 30 seconds

  // Exponential: 2^retries * base, capped at max
  const exponentialDelay = Math.min(
    Math.pow(2, retryCount) * baseDelay,
    maxDelay
  );

  // Add jitter (random value up to 25% of delay)
  const jitter = Math.random() * exponentialDelay * 0.25;

  return exponentialDelay + jitter;
}
```

### 2. SACK-Style Cumulative Acknowledgments

**Current State**: Individual chunk ACKs are sent per chunk.

**Recommendation**: Implement SACK (Selective Acknowledgment) for efficiency:

```typescript
interface SACKMessage {
  type: 'sack';
  fileId: string;
  cumulativeAck: number;  // All chunks up to this index received
  sackBlocks?: Array<{    // Additional received ranges
    start: number;        // First chunk in block
    end: number;          // Last chunk in block + 1
  }>;
}
```

This reduces acknowledgment traffic and provides better gap detection.

### 3. Adaptive Timeout Based on RTT

**Current State**: Fixed 5-second timeout for chunk acknowledgments.

**Recommendation**: Implement RTT measurement and adaptive timeout:

```typescript
class RTTEstimator {
  private srtt: number = 0;      // Smoothed RTT
  private rttvar: number = 0;    // RTT variance
  private rto: number = 5000;    // Retransmission timeout

  update(measuredRtt: number): void {
    // Jacobson/Karels algorithm (from TCP)
    const alpha = 0.125;
    const beta = 0.25;

    if (this.srtt === 0) {
      this.srtt = measuredRtt;
      this.rttvar = measuredRtt / 2;
    } else {
      this.rttvar = (1 - beta) * this.rttvar +
                    beta * Math.abs(this.srtt - measuredRtt);
      this.srtt = (1 - alpha) * this.srtt + alpha * measuredRtt;
    }

    // RTO = SRTT + max(G, K*RTTVAR) where G=granularity, K=4
    this.rto = Math.max(1000, Math.min(60000, this.srtt + 4 * this.rttvar));
  }

  getTimeout(): number {
    return this.rto;
  }
}
```

### 4. Resume Capability After Reconnection

**Current State**: Transfers fail completely on connection drop.

**Recommendation**: Add resume protocol:

```typescript
interface ResumeRequestMessage {
  type: 'resume_request';
  fileId: string;
  receivedChunks: number[];  // What receiver already has
  expectedFileHash: string;  // Verify same file
}

interface ResumeResponseMessage {
  type: 'resume_response';
  fileId: string;
  accepted: boolean;
  startFromChunk?: number;   // Resume point
}
```

### 5. Parallel Chunk Sending Optimization

**Current State**: Sliding window of 10 chunks.

**Recommendation**: Dynamic window sizing based on network conditions:

```typescript
class CongestionController {
  private cwnd: number = 2;        // Congestion window
  private ssthresh: number = 64;   // Slow start threshold

  onAck(): void {
    if (this.cwnd < this.ssthresh) {
      // Slow start: exponential growth
      this.cwnd += 1;
    } else {
      // Congestion avoidance: linear growth
      this.cwnd += 1 / this.cwnd;
    }
  }

  onTimeout(): void {
    this.ssthresh = Math.max(this.cwnd / 2, 2);
    this.cwnd = 1;
  }

  getWindowSize(): number {
    return Math.floor(this.cwnd);
  }
}
```

## Research: Industry Solutions

### WebRTC Data Channel Protocols

Based on [RFC 8831](https://datatracker.ietf.org/doc/html/rfc8831):
- SCTP provides built-in SACK mechanism
- Transmission Sequence Number (TSN) for packet tracking
- Automatic retransmission for reliable mode
- 64KB recommended maximum chunk size

Key recommendations from [MDN WebRTC Data Channels](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels):
- Monitor `bufferedAmount` to prevent overflow
- Use `bufferedAmountLowThreshold` for efficient backpressure
- Message interleaving (RFC 8260) helps with large transfers

### WebTorrent / BitTorrent Chunking

From [BitTorrent v2 specification](https://blog.libtorrent.org/2020/09/bittorrent-v2/):
- SHA-256 for piece verification
- Merkle hash trees for block-level validation (16KB blocks)
- Immediate detection and rejection of corrupted data
- Peer identification for bad data sources

### Signal File Transfer

From [Signal Protocol documentation](https://signal.org/docs/):
- Double Ratchet for key management
- AES-256-CTR with HMAC-SHA256 for encryption
- Per-attachment integrity verification
- 45-day server-side storage for async delivery

### Exponential Backoff Best Practices

From [AWS Builders Library](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/):

```
Formula: min(cap, base * 2^attempt)
With jitter: random_between(0, min(cap, base * 2^attempt))
Full jitter: random_between(0, calculated_delay)
```

Key principles:
1. Cap maximum delay (typically 32-64 seconds)
2. Add jitter to prevent thundering herd
3. Limit total retry attempts
4. Distinguish retryable vs non-retryable errors

From [Better Stack Guide](https://betterstack.com/community/guides/monitoring/exponential-backoff/):
- Monitor for retry amplification
- Use queue-based retry for production systems
- Log retries for debugging

## Implementation Recommendations

### Priority 1: Quick Improvements (Low Effort)

1. **Add Exponential Backoff with Jitter**
   - Location: `fileTransferManager.ts` - `setChunkTimeout()`
   - Change fixed 5s timeout to exponential backoff
   - Add jitter to prevent synchronized retries

2. **Dynamic Timeout Based on Observed ACK Times**
   - Track RTT for each chunk ACK
   - Adjust timeout dynamically

### Priority 2: Protocol Enhancements (Medium Effort)

1. **SACK-Style Cumulative ACKs**
   - Reduces acknowledgment message count
   - Better gap detection for bulk retransmission

2. **Adaptive Sliding Window**
   - Start small (2-3 chunks)
   - Grow on successful ACKs
   - Shrink on timeouts/failures

### Priority 3: Advanced Features (Higher Effort)

1. **Resume After Disconnect**
   - Store transfer state locally
   - Exchange resume messages on reconnect
   - Verify file identity with hash

2. **Merkle Tree for Efficient Verification**
   - Compute Merkle root instead of flat hash list
   - Log(n) verification path for any chunk

## Test Scenarios

### Unit Tests Needed

1. `FileTransferManager` chunk tracking
2. Hash computation functions
3. Backoff calculation with jitter
4. RTT estimation algorithm
5. Window size adjustment

### Integration Tests Needed

1. Chunk loss simulation (drop random chunks)
2. Network throttling (slow connection)
3. Connection drop mid-transfer
4. Large file transfer (100MB+)
5. Multiple concurrent transfers
6. Hash mismatch detection
7. Timeout triggering and retry

### Manual Testing Checklist

- [ ] Transfer with browser tab backgrounded
- [ ] Transfer on slow/unstable connection
- [ ] Cancel during transfer (both sides)
- [ ] Peer disconnects during transfer
- [ ] Resume after brief disconnection
- [ ] Large file memory handling

## Conclusion

The Zajel codebase already has a well-designed reliable file transfer protocol with:
- Chunk-level acknowledgments
- SHA-256 hash verification
- Per-chunk retry mechanism
- Timeout detection
- Sliding window flow control
- Backpressure handling
- Comprehensive UI feedback

The main areas for improvement are:
1. Exponential backoff with jitter (currently fixed timeout)
2. Adaptive timeout based on RTT
3. Resume capability after reconnection
4. SACK-style acknowledgments for efficiency

The existing implementation follows industry best practices from WebRTC, BitTorrent, and TCP, making it a solid foundation for reliable file transfer.

## References

### Standards and RFCs
- [RFC 8831 - WebRTC Data Channels](https://datatracker.ietf.org/doc/html/rfc8831)
- [RFC 8832 - WebRTC Data Channel Establishment Protocol](https://datatracker.ietf.org/doc/html/rfc8832)
- [RFC 2018 - TCP SACK](https://datatracker.ietf.org/doc/html/rfc2018)

### WebRTC Resources
- [MDN: Using WebRTC Data Channels](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)
- [WebRTC for the Curious: Data Communication](https://webrtcforthecurious.com/docs/07-data-communication/)
- [web.dev: WebRTC Data Channels](https://web.dev/articles/webrtc-datachannels)

### Retry and Backoff
- [AWS: Timeouts, Retries and Backoff with Jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [Better Stack: Exponential Backoff Guide](https://betterstack.com/community/guides/monitoring/exponential-backoff/)
- [Baeldung: Exponential Backoff and Jitter](https://www.baeldung.com/resilience4j-backoff-jitter)

### File Sharing Applications
- [Signal Protocol Documentation](https://signal.org/docs/)
- [BitTorrent v2 Specification](https://blog.libtorrent.org/2020/09/bittorrent-v2/)
- [ShareDrop GitHub Repository](https://github.com/ShareDropio/sharedrop)
- [WebTorrent Documentation](https://webtorrent.io/docs)
