# Issue #24: File Transfer Error Handling

## Summary

The current file transfer implementation lacks a chunk retry mechanism. If a single chunk fails during transmission, the entire file transfer becomes corrupted with no recovery option. Additionally, failures can occur silently without adequate user feedback.

## Current Implementation Analysis

### File Locations
- **packages/web-client/src/App.tsx** (lines 341-407): File sending logic
- **packages/web-client/src/lib/webrtc.ts**: WebRTC service with file channel
- **packages/web-client/src/lib/protocol.ts**: Protocol message types
- **packages/web-client/src/components/FileTransfer.tsx**: UI component

### Current Architecture

#### Sending Side (App.tsx lines 341-407)
```typescript
// Current flow:
1. Generate fileId and calculate totalChunks
2. Send file_start message
3. Loop through chunks:
   - Read chunk from ArrayBuffer
   - Encrypt chunk
   - Send via sendFileChunk()
   - Update progress (local only)
   - 10ms delay between chunks
4. Send file_complete message
5. Mark transfer as complete (sender side)
```

#### Receiving Side (App.tsx lines 150-271)
```typescript
// Current flow:
1. Receive file_start -> create transfer entry
2. Receive file_chunk -> decrypt and store in data[]
3. Receive file_complete:
   - Check for missing chunks
   - If missing, mark as failed with error message
   - If complete, combine and trigger download
```

### Protocol Messages (protocol.ts)
- `file_start`: Contains fileId, fileName, totalSize, totalChunks
- `file_chunk`: Contains fileId, chunkIndex, data (encrypted base64)
- `file_complete`: Contains fileId
- `file_error`: Contains fileId, error string

### WebRTC Data Channel Configuration
- Uses ordered: true (reliable in-order delivery)
- No explicit acknowledgment mechanism
- Fire-and-forget chunk sending

## Identified Failure Modes

### 1. Chunk Loss Without Detection
**Problem**: Despite WebRTC's ordered channel, chunks can still be lost if:
- Data channel buffer overflow (no backpressure handling)
- Connection interruption during transfer
- Browser tab backgrounded (throttling)

**Current Behavior**: Lost chunks result in undefined entries in the data[] array, detected only at file_complete.

**User Feedback**: "Missing chunks: X, Y, Z" error shown, but:
- No retry option
- User must manually restart transfer
- No indication of which side caused failure

### 2. Silent Send Failures
**Problem**: `sendFileChunk()` in webrtc.ts (lines 232-243) silently fails if channel is not open:
```typescript
sendFileChunk(fileId: string, chunkIndex: number, data: string): void {
  if (this.fileChannel?.readyState === 'open') {
    this.fileChannel.send(...);
  }
  // No else clause - silent failure!
}
```

**User Feedback**: Sender sees 100% progress, receiver gets corrupted file.

### 3. No Backpressure Handling
**Problem**: The 10ms delay between chunks is arbitrary and doesn't account for:
- WebRTC bufferedAmount (data waiting to be sent)
- Network conditions
- Receiver processing speed

**Result**: Buffer overflow can cause data loss on slow connections.

### 4. Decryption Failure Handling
**Problem**: When chunk decryption fails (lines 191-209):
- Transfer is marked as failed
- `sendFileError()` notifies peer
- But sender continues sending remaining chunks wastefully

### 5. Large File Memory Issues
**Problem**: Entire file is loaded into memory before sending:
```typescript
const buffer = await file.arrayBuffer();
const bytes = new Uint8Array(buffer);
```

**Result**: Large files cause memory spikes; browser may crash.

### 6. No Integrity Verification
**Problem**: No checksums or hashes to verify:
- Individual chunk integrity
- Complete file integrity
- Chunks could be corrupted in transit without detection

### 7. Connection Drop During Transfer
**Problem**: If WebRTC connection drops mid-transfer:
- In-progress transfer stuck in "receiving" state
- No timeout mechanism
- No resume capability

## Proposed Solution: Reliable File Transfer Protocol

### Architecture Overview

Implement an acknowledgment-based protocol with chunk-level retries:

```
Sender                                  Receiver
  |                                        |
  |------- file_start ------------------>  |
  |<------ file_start_ack ---------------  |
  |                                        |
  |------- file_chunk (0) -------------->  |
  |<------ chunk_ack (0) ----------------  |
  |                                        |
  |------- file_chunk (1) -------------->  |
  |        (timeout, no ack)               |
  |------- file_chunk (1) [retry] ------>  |
  |<------ chunk_ack (1) ----------------  |
  |                                        |
  |------- file_complete --------------->  |
  |<------ file_complete_ack ------------  |
```

### Proposed Protocol Messages

Add new message types to protocol.ts:

```typescript
// Acknowledgment messages
interface FileStartAckMessage {
  type: 'file_start_ack';
  fileId: string;
  accepted: boolean;
  reason?: string;  // If rejected: 'too_large', 'unsupported_type', etc.
}

interface ChunkAckMessage {
  type: 'chunk_ack';
  fileId: string;
  chunkIndex: number;
  status: 'received' | 'failed';
  hash?: string;  // Optional: SHA-256 of received chunk for verification
}

interface ChunkRetryRequestMessage {
  type: 'chunk_retry';
  fileId: string;
  chunkIndices: number[];  // Request retransmission of specific chunks
}

interface FileCompleteAckMessage {
  type: 'file_complete_ack';
  fileId: string;
  status: 'success' | 'failed';
  missingChunks?: number[];
  fileHash?: string;  // SHA-256 of complete file
}

interface TransferCancelMessage {
  type: 'transfer_cancel';
  fileId: string;
  reason: 'user_cancelled' | 'error' | 'timeout';
}
```

### Implementation Components

#### 1. ChunkTracker Class
```typescript
class ChunkTracker {
  private sentChunks: Map<number, {
    data: string;
    sentAt: number;
    retries: number
  }>;
  private ackedChunks: Set<number>;
  private readonly maxRetries = 3;
  private readonly ackTimeout = 5000; // 5 seconds

  public markSent(index: number, data: string): void;
  public markAcked(index: number): void;
  public getUnackedChunks(): number[];
  public getChunkForRetry(index: number): string | null;
  public shouldRetry(index: number): boolean;
}
```

#### 2. Backpressure Handler
```typescript
async function sendWithBackpressure(
  channel: RTCDataChannel,
  data: string
): Promise<void> {
  const MAX_BUFFERED = 1024 * 1024; // 1MB buffer limit

  while (channel.bufferedAmount > MAX_BUFFERED) {
    await new Promise(r => setTimeout(r, 50));
  }

  channel.send(data);
}
```

#### 3. Transfer State Machine
```typescript
enum TransferState {
  Idle,
  AwaitingStartAck,
  Transferring,
  AwaitingCompleteAck,
  Complete,
  Failed,
  Cancelled
}

class TransferStateMachine {
  private state: TransferState;
  private timeoutHandles: Map<string, NodeJS.Timeout>;

  public transition(event: TransferEvent): void;
  public getState(): TransferState;
  public canRetry(): boolean;
}
```

#### 4. Integrity Verification
```typescript
async function computeChunkHash(chunk: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', chunk);
  return btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
}

async function computeFileHash(chunks: Uint8Array[]): Promise<string> {
  const combined = new Blob(chunks);
  const buffer = await combined.arrayBuffer();
  return computeChunkHash(new Uint8Array(buffer));
}
```

### Updated Sending Flow

```typescript
async function sendFileReliable(file: File): Promise<void> {
  const fileId = crypto.randomUUID();
  const tracker = new ChunkTracker();
  const stateMachine = new TransferStateMachine();

  // 1. Send file_start and wait for ack
  sendFileStart(fileId, file.name, file.size, totalChunks);
  stateMachine.transition('start_sent');

  const startAck = await waitForAck('file_start_ack', fileId, 10000);
  if (!startAck.accepted) {
    throw new Error(`Transfer rejected: ${startAck.reason}`);
  }
  stateMachine.transition('start_acked');

  // 2. Send chunks with streaming (not loading entire file)
  const reader = file.stream().getReader();
  let chunkIndex = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    await sendChunkWithRetry(fileId, chunkIndex, value, tracker);
    updateProgress(chunkIndex, totalChunks);
    chunkIndex++;
  }

  // 3. Wait for all acks before completing
  await waitForAllAcks(tracker);

  // 4. Send file_complete with hash
  const fileHash = await computeFileHash(chunks);
  sendFileComplete(fileId, fileHash);

  const completeAck = await waitForAck('file_complete_ack', fileId, 30000);
  if (completeAck.status !== 'success') {
    // Handle missing chunks with retry
    await retryMissingChunks(completeAck.missingChunks, tracker);
  }
}

async function sendChunkWithRetry(
  fileId: string,
  index: number,
  data: Uint8Array,
  tracker: ChunkTracker
): Promise<void> {
  const encrypted = encryptChunk(data);
  const hash = await computeChunkHash(data);

  for (let attempt = 0; attempt < 3; attempt++) {
    tracker.markSent(index, encrypted);
    await sendWithBackpressure(fileChannel, JSON.stringify({
      type: 'file_chunk',
      fileId,
      chunkIndex: index,
      data: encrypted,
      hash
    }));

    try {
      const ack = await waitForChunkAck(fileId, index, 5000);
      if (ack.status === 'received') {
        tracker.markAcked(index);
        return;
      }
    } catch (timeout) {
      console.warn(`Chunk ${index} timeout, retry ${attempt + 1}/3`);
    }
  }

  throw new Error(`Failed to send chunk ${index} after 3 retries`);
}
```

### Updated Receiving Flow

```typescript
function handleFileStart(msg: FileStartMessage): void {
  // Validate and accept/reject
  if (msg.totalSize > MAX_FILE_SIZE) {
    sendFileStartAck(msg.fileId, false, 'too_large');
    return;
  }

  createTransferEntry(msg);
  sendFileStartAck(msg.fileId, true);
}

function handleFileChunk(msg: FileChunkMessage): void {
  const transfer = getTransfer(msg.fileId);
  if (!transfer) {
    sendChunkAck(msg.fileId, msg.chunkIndex, 'failed');
    return;
  }

  try {
    const decrypted = decrypt(msg.data);
    const hash = await computeChunkHash(decrypted);

    // Verify hash if provided
    if (msg.hash && msg.hash !== hash) {
      sendChunkAck(msg.fileId, msg.chunkIndex, 'failed');
      return;
    }

    storeChunk(msg.fileId, msg.chunkIndex, decrypted);
    sendChunkAck(msg.fileId, msg.chunkIndex, 'received', hash);

  } catch (e) {
    sendChunkAck(msg.fileId, msg.chunkIndex, 'failed');
  }
}

function handleFileComplete(msg: FileCompleteMessage): void {
  const transfer = getTransfer(msg.fileId);
  const missingChunks = findMissingChunks(transfer);

  if (missingChunks.length > 0) {
    sendFileCompleteAck(msg.fileId, 'failed', missingChunks);
    // Wait for retries
    return;
  }

  const fileHash = await computeFileHash(transfer.data);
  if (msg.fileHash && msg.fileHash !== fileHash) {
    sendFileCompleteAck(msg.fileId, 'failed');
    return;
  }

  sendFileCompleteAck(msg.fileId, 'success', [], fileHash);
  triggerDownload(transfer);
}
```

### User Feedback Improvements

#### Progress UI Updates
```typescript
interface EnhancedFileTransfer extends FileTransfer {
  sentChunks: number;      // Chunks sent by sender
  ackedChunks: number;     // Chunks acknowledged
  failedChunks: number[];  // Chunks that need retry
  retryCount: number;      // Current retry count
  state: TransferState;
  estimatedTimeRemaining?: number;
  transferSpeed?: number;  // bytes/second
}
```

#### Visual Indicators
1. **Progress bar color coding**:
   - Blue: Normal transfer
   - Yellow: Retrying chunks
   - Red: Failed
   - Green: Complete + verified

2. **Status messages**:
   - "Sending... (chunk 45/100)"
   - "Retrying chunk 23 (attempt 2/3)"
   - "Verifying file integrity..."
   - "Transfer complete - verified"
   - "Transfer failed: Network timeout after 3 retries"

3. **Retry button**: Allow user to manually retry failed transfers

4. **Cancel button**: Allow cancellation with proper cleanup

### Implementation Priority

1. **Phase 1: Critical Fixes** (Immediate)
   - Add send failure detection in `sendFileChunk()`
   - Implement backpressure handling
   - Stop sending after error notification
   - Add transfer timeout

2. **Phase 2: Basic Reliability** (Short-term)
   - Add chunk acknowledgments
   - Implement chunk-level retry (3 attempts)
   - Add file integrity hash
   - Improve error messages

3. **Phase 3: Advanced Features** (Long-term)
   - Streaming file read (avoid full memory load)
   - Transfer resume capability
   - Multiple concurrent transfers
   - Transfer speed display
   - Pause/resume functionality

## Quick Win Fixes

These can be implemented immediately with minimal changes:

### Fix 1: Silent Send Failure Detection
```typescript
// webrtc.ts - Add return value to sendFileChunk
sendFileChunk(fileId: string, chunkIndex: number, data: string): boolean {
  if (this.fileChannel?.readyState === 'open') {
    try {
      this.fileChannel.send(JSON.stringify({
        type: 'file_chunk',
        fileId,
        chunkIndex,
        data,
      }));
      return true;
    } catch (e) {
      console.error('Failed to send chunk:', e);
      return false;
    }
  }
  return false;
}
```

### Fix 2: Backpressure Check
```typescript
// App.tsx - Add backpressure in sending loop
for (let i = 0; i < totalChunks; i++) {
  // Wait if buffer is full
  while (webrtcRef.current?.fileChannel?.bufferedAmount > 1024 * 1024) {
    await new Promise(r => setTimeout(r, 50));
  }

  // ... existing chunk send logic
}
```

### Fix 3: Transfer Timeout
```typescript
// App.tsx - Add timeout for receiving transfers
useEffect(() => {
  const TRANSFER_TIMEOUT = 60000; // 1 minute idle timeout

  const checkStaleTransfers = setInterval(() => {
    const now = Date.now();
    setTransfers(prev => prev.map(t => {
      if (t.status === 'receiving' && t.lastActivity) {
        if (now - t.lastActivity > TRANSFER_TIMEOUT) {
          return { ...t, status: 'failed', error: 'Transfer timeout' };
        }
      }
      return t;
    }));
  }, 10000);

  return () => clearInterval(checkStaleTransfers);
}, []);
```

## Testing Recommendations

1. **Unit Tests**
   - ChunkTracker state management
   - Transfer state machine transitions
   - Hash computation functions

2. **Integration Tests**
   - Chunk loss simulation (drop random chunks)
   - Network throttling
   - Connection drop mid-transfer
   - Large file transfer (100MB)
   - Multiple concurrent transfers

3. **Manual Tests**
   - Transfer with browser tab backgrounded
   - Transfer on slow connection
   - Cancel during transfer
   - Peer disconnects during transfer

## Estimated Effort

| Phase | Tasks | Effort |
|-------|-------|--------|
| Quick Wins | Send failure detection, backpressure, timeout | 2-4 hours |
| Phase 1 | Critical fixes | 4-8 hours |
| Phase 2 | ACK protocol, retries, integrity | 16-24 hours |
| Phase 3 | Streaming, resume, advanced UI | 24-40 hours |

## References

- [WebRTC Data Channels](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel)
- [Reliable Data Transfer Protocols](https://en.wikipedia.org/wiki/Reliable_Data_Protocol)
- [TCP Congestion Control](https://en.wikipedia.org/wiki/TCP_congestion_control) (for backpressure concepts)
- [ARQ (Automatic Repeat Request)](https://en.wikipedia.org/wiki/Automatic_repeat_request)

## Research: How Other Apps Solve This

This section documents how major messaging apps and protocols handle reliable file transfers with error recovery.

### Signal

**Architecture Overview:**
Signal uses a CDN-based attachment storage system where attachments are uploaded to Signal's servers, encrypted client-side before transmission.

**Key Implementation Details:**

1. **Encryption**: Attachments are encrypted using AES-256 in CTR mode with HMAC-SHA256 for authentication. The encryption happens client-side before upload, ensuring the server never sees plaintext.

2. **Integrity Verification**: Each attachment includes a Message Authentication Code (MAC) computed on the concatenation of the initialization vector and ciphertext. The last 10 bytes contain the first 10 bytes of the HMAC for verification.

3. **Storage & Availability**: Encrypted attachments are stored on Signal's servers for 45 days, allowing offline devices to fetch them when they come online. After this period, attachments expire.

4. **Known Limitations**:
   - Users report "attachment is downloading" indefinitely with no way to retransmit
   - The peer who sent the attachment doesn't know if the recipient failed to receive it
   - No visible retry mechanism from the user's perspective

**Lessons for Zajel:**
- Implement per-chunk MAC verification (HMAC-SHA256)
- Consider sender notification when receiver fails to download
- Add explicit retry button for stuck transfers

**References:**
- [Signal Documentation](https://signal.org/docs/)
- [Signal Android Issues](https://github.com/signalapp/Signal-Android/issues/13258)
- [libsignal GitHub](https://github.com/signalapp/libsignal)

---

### Telegram

**Architecture Overview:**
Telegram uses the MTProto protocol with a sophisticated chunked upload/download system supporting files up to 4GB (2GB for non-premium users).

**Key Implementation Details:**

1. **Chunked Upload API** (`upload.saveBigFilePart`):
   - Files > 10MB use `upload.saveBigFilePart`
   - Smaller files use `upload.saveFilePart`
   - Part sizes must be power of 2: 1KB to 512KB allowed
   - Method signature: `saveBigFilePart(file_id, file_part, file_total_parts, bytes)`

2. **Parallel Upload for Performance**:
   - TDLib uploads 20 chunks in parallel for maximum throughput
   - Each successful part triggers the next part upload
   - Progress tracking via `part_size * completed_parts`

3. **Resume Limitations**:
   - Uploaded parts expire after "several minutes to several hours"
   - True resume after significant delay is not reliable
   - Upload must restart if parts expire

4. **Error Handling**:
   - `FILE_PARTS_INVALID`: Invalid number of parts
   - `FILE_PART_TOO_BIG`: Part exceeds 512KB limit
   - `FILE_PART_SIZE_CHANGED`: Inconsistent part sizes

5. **TDLib Reliability**:
   - Handles all network details and encryption
   - Stable on slow/unreliable connections
   - Fully asynchronous, non-blocking requests

**Lessons for Zajel:**
- Use consistent chunk sizes (power of 2, e.g., 64KB or 256KB)
- Implement parallel chunk sending with a configurable window (e.g., 5-10 chunks)
- Track which chunks are in-flight vs. acknowledged
- Handle chunk expiration gracefully (restart if too much time passes)

**References:**
- [Telegram API: Uploading Files](https://core.telegram.org/api/files)
- [upload.saveBigFilePart](https://core.telegram.org/method/upload.saveBigFilePart)
- [TDLib Documentation](https://core.telegram.org/tdlib)

---

### WhatsApp

**Architecture Overview:**
WhatsApp uses the Signal Protocol for encryption and a server-relay model for all message/media delivery.

**Key Implementation Details:**

1. **End-to-End Encryption for Media**:
   - Uses Signal Protocol (Curve25519, AES-256, HMAC-SHA256)
   - Media encrypted before upload to servers
   - Server never sees plaintext content

2. **Double Ratchet Algorithm**:
   - Provides forward secrecy and post-compromise security
   - Keys rotate with every message
   - Limits damage if a key is compromised

3. **Multi-Device Sync** (Client Fanout):
   - Separate encrypted messages sent to each device
   - Attachments stored server-side with encryption keys in messages
   - Each device fetches and decrypts independently

4. **Security Key Verification**:
   - SHA-512 hash iterated 5200 times over public Identity Key
   - Result split into 5-byte chunks for fingerprint verification

**Lessons for Zajel:**
- Implement key rotation for long-lived connections
- Consider how multi-device scenarios affect file transfer
- Use established primitives (AES-256, HMAC-SHA256)

**References:**
- [WhatsApp Encryption FAQ](https://faq.whatsapp.com/820124435853543)
- [WhatsApp Encryption Deep Dive](https://dev.to/binoy123/a-deep-dive-into-whatsapps-encryption-identity-keys-and-message-security-53h6)

---

### WebRTC Data Channels Best Practices

**Protocol Foundation:**
WebRTC data channels use SCTP over DTLS, providing reliable, ordered delivery by default.

**Chunk Acknowledgment (SACK):**

1. **Built-in SCTP Acknowledgments**:
   - SACK (Selective Acknowledgment) chunks notify sender of received packets
   - Sender retransmits DATA chunks until SACK is received
   - Gap Ack Blocks indicate received packets after a gap

2. **Recommended Chunk Size**:
   - **16 KiB or less** for cross-browser stability
   - Larger chunks cause head-of-line blocking
   - RFC 8260 message interleaving helps but isn't universally supported

**Buffer Management & Backpressure:**

```javascript
// Set threshold for "buffer low" event
dataChannel.bufferedAmountLowThreshold = 64 * 1024; // 64KB

// Pause sending when buffer is full
async function sendWithBackpressure(chunk) {
  const MAX_BUFFER = 1024 * 1024; // 1MB

  while (dataChannel.bufferedAmount > MAX_BUFFER) {
    await new Promise(resolve => {
      dataChannel.onbufferedamountlow = resolve;
    });
  }

  dataChannel.send(chunk);
}
```

**Critical Limits:**
- Chrome closes data channel if buffer exceeds ~16 MiB
- Message interleaving should be enabled (RFC 8260)
- Monitor `bufferedAmount` to prevent overflow

**Reliability Options:**
- `ordered: true, maxRetransmits: undefined` = fully reliable (default)
- `ordered: false, maxRetransmits: 3` = partial reliability
- `maxPacketLifeTime: 5000` = time-limited retry

**Progress Tracking:**

```javascript
// Sender-side progress
const progress = {
  sent: chunksSent,
  buffered: dataChannel.bufferedAmount,
  acknowledged: chunksAcked // from receiver feedback
};

// Receiver-side progress
const progress = {
  received: chunksReceived,
  missing: findMissingChunks(),
  verified: chunksWithValidHash
};
```

**Lessons for Zajel:**
- Use 16KB chunks for reliability
- Implement backpressure using `bufferedAmountLowThreshold`
- Keep separate control channel for ACKs/NACKs
- Monitor and limit buffer to prevent channel closure

**References:**
- [MDN: Using WebRTC Data Channels](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)
- [RFC 8831: WebRTC Data Channels](https://datatracker.ietf.org/doc/html/rfc8831)
- [WebRTC for the Curious: Data Communication](https://webrtcforthecurious.com/docs/07-data-communication/)
- [RTCDataChannel Guide](https://webrtc.link/en/articles/rtcdatachannel-usage-and-message-size-limits/)

---

### BitTorrent

**Architecture Overview:**
BitTorrent is a P2P protocol designed for reliable distribution of large files across untrusted peers.

**Piece Verification:**

1. **SHA-1/SHA-256 Hashing**:
   - Files split into pieces (typically 256KB-1MB)
   - Each piece has a SHA-1 hash stored in the torrent file
   - BitTorrent v2 uses SHA-256 for improved security

2. **Hash Distribution**:
   - Torrent file (from trusted source) contains all piece hashes
   - Any peer can provide pieces; hashes verify integrity
   - Corrupted pieces are discarded and re-requested

3. **Piece Announcement**:
   - When a peer completes and verifies a piece, it announces via `have` message
   - Other peers know which pieces are available from whom

**BitTorrent v2 Improvements:**

- Merkle trees for 16KiB block verification
- Individual blocks can be verified and re-downloaded
- Better handling of corrupted data without discarding entire piece

**Resumable Transfer:**

```
Torrent File:
  - piece_length: 262144 (256KB)
  - pieces: [hash1, hash2, hash3, ...]

Resume State:
  - downloaded_pieces: [0, 1, 4, 5] (completed)
  - in_progress_pieces: [2, 3] (partial)
  - remaining: [6, 7, 8, ...]
```

**Lessons for Zajel:**
- Include hash with each chunk for per-chunk verification
- Store chunk hashes in file_start message for receiver validation
- Allow receiver to request specific missing chunks by index
- Consider Merkle tree for efficient whole-file verification

**References:**
- [BitTorrent Protocol (BEP 3)](https://www.bittorrent.org/beps/bep_0003.html)
- [BitTorrent v2 (BEP 52)](https://www.bittorrent.org/beps/bep_0052.html)
- [BitTorrent Specification](https://wiki.theory.org/BitTorrentSpecification)

---

### IPFS (InterPlanetary File System)

**Architecture Overview:**
IPFS uses content-addressing with Merkle DAGs for decentralized, verifiable file storage and transfer.

**Content Addressing (CID):**

1. **Hash-Based Identification**:
   - Files identified by cryptographic hash (CID) of content
   - Changing a single bit changes the CID
   - Built-in integrity verification

2. **Chunking Strategies**:
   - Fixed-size chunking (256KiB-1MiB typical)
   - Content-defined chunking (Rabin, Buzhash) for deduplication
   - Chunk strategy affects CID (same content can have different CIDs)

**Merkle DAG Structure:**

```
Root Block (CID: Qm...)
  ├── links: [
  │     { cid: Qm..., size: 262144 },  // Chunk 0
  │     { cid: Qm..., size: 262144 },  // Chunk 1
  │     { cid: Qm..., size: 131072 }   // Chunk 2 (last, smaller)
  │   ]
  └── data: (file metadata)
```

**Retrieval & Verification:**

1. **Content Routing**: Find peers with requested CID via DHT or Bitswap
2. **Block Fetching**: Fetch blocks from any peer (trustless)
3. **Verification**: Hash each block, verify against expected CID
4. **Assembly**: Combine blocks using DAG structure

**Resumable Transfers:**

- Each block independently addressable and verifiable
- Interrupted download resumes by fetching missing blocks
- No need to track "session" - just request blocks by CID
- Any peer with the block can provide it

**Lessons for Zajel:**
- Consider content-addressing for chunk IDs (hash of chunk data)
- Merkle root hash provides efficient whole-file verification
- Store mapping: fileId -> [chunkCID0, chunkCID1, ...]
- Any received chunk can be verified independently

**References:**
- [IPFS Content Addressing](https://docs.ipfs.tech/concepts/content-addressing/)
- [IPFS Merkle DAG](https://docs.ipfs.tech/concepts/merkle-dag/)
- [How IPFS Works](https://docs.ipfs.tech/concepts/how-ipfs-works/)

---

### Reliable Transfer Protocols (ARQ Patterns)

**Selective Repeat ARQ:**

Most relevant pattern for Zajel's needs:

1. **Sliding Window**:
   - Sender maintains window of N outstanding chunks
   - Receiver ACKs each chunk individually
   - Out-of-order chunks buffered until gaps filled

2. **Selective Acknowledgment (SACK)**:
   - Receiver reports which chunks received (even out of order)
   - Sender retransmits only missing chunks
   - More efficient than Go-Back-N for lossy connections

3. **Timer-Based Retransmission**:
   - Each chunk has individual timeout
   - Timeout triggers retransmission of that chunk
   - Adaptive timeout based on RTT estimation

**NACK (Negative Acknowledgment):**

```
Receiver detects gap:
  Received: [0, 1, 2, 5, 6]  // Missing 3, 4
  Send NACK: { fileId, missing: [3, 4] }

Sender responds:
  Retransmit chunks 3 and 4
```

**TCP SACK Implementation (RFC 2018):**

```
SACK Block Format:
  Left Edge: First sequence number of received block
  Right Edge: Last sequence number + 1

Example:
  Received: bytes 0-999, 2000-2999
  Missing: bytes 1000-1999
  SACK: [{ left: 2000, right: 3000 }]
  Cumulative ACK: 1000 (everything before this)
```

**Lessons for Zajel:**
- Implement sliding window with configurable size
- Use SACK-style ACKs reporting received chunk ranges
- Include timer per chunk for retry triggering
- Receiver sends NACK immediately on detecting gap

**References:**
- [RFC 2018: TCP SACK](https://datatracker.ietf.org/doc/html/rfc2018)
- [Retransmission (Wikipedia)](https://en.wikipedia.org/wiki/Retransmission_(data_networks))
- [Reliable Data Transfer Protocols](https://alphazwest.medium.com/reliable-data-transfer-protocols-rdt-the-reliability-guarantee-that-keeps-the-internet-running-e555a4fb375d)

---

### Progress Reporting Best Practices

**UX Research Findings:**
- Users with progress indicators wait 3x longer before abandoning (University of Nebraska-Lincoln)
- Determinate progress (percentage) preferred for larger files
- Indeterminate (spinner) acceptable only for very small files (~10MB or less)

**Recommended Progress States:**

| State | Visual | User Action |
|-------|--------|-------------|
| Waiting | Queue position | Cancel |
| Uploading/Downloading | Progress bar + percentage | Pause/Cancel |
| Retrying | Warning color + retry count | Cancel |
| Paused | Pause icon | Resume/Cancel |
| Verifying | Indeterminate or checkmark animation | - |
| Complete | Success checkmark | Open/Share |
| Failed | Error icon + message | Retry/Cancel |

**Error Message Best Practices:**

```
Bad:  "Transfer failed"
Good: "Connection lost. Retrying in 5 seconds... (Attempt 2/3)"

Bad:  "Error"
Good: "Chunk 45/100 failed to send. Tap to retry."
```

**Visual Feedback Recommendations:**

1. **Progress Bar Colors**:
   - Blue/Primary: Normal transfer
   - Yellow/Warning: Retrying
   - Red/Error: Failed
   - Green/Success: Complete + verified

2. **Information Display**:
   - Percentage complete
   - Transfer speed (KB/s or MB/s)
   - Time remaining estimate
   - Chunks sent/received vs total

3. **Recovery Actions**:
   - Automatic retry with exponential backoff
   - Manual retry button for persistent failures
   - Cancel with confirmation for large transfers

**References:**
- [File Uploader UX Best Practices](https://uploadcare.com/blog/file-uploader-ux-best-practices/)
- [Progress Indicators with Resumable Uploads](https://pinata.cloud/blog/how-to-implement-progress-indicators-and-resumable-uploads-with-pinata/)
- [Error Handling UX Patterns](https://medium.com/design-bootcamp/error-handling-ux-design-patterns-c2a5bbae5f8d)

---

### Summary: Recommended Approach for Zajel

Based on the research, here is a synthesized recommendation:

**1. Chunk Protocol:**
- 16KB chunk size (WebRTC-safe, cross-browser compatible)
- SHA-256 hash per chunk (BitTorrent/IPFS pattern)
- Sequential chunk indices with sliding window

**2. Acknowledgment System:**
- SACK-style ACKs from receiver after each chunk
- Cumulative ACK + gap report for efficiency
- NACK on gap detection for immediate retransmit

**3. Retry Mechanism:**
- Per-chunk timeout (5 seconds suggested)
- Max 3 retries per chunk before failure
- Exponential backoff on repeated failures

**4. Integrity Verification:**
- HMAC-SHA256 per chunk (Signal pattern)
- Merkle root hash for whole-file verification
- Send hash list in `file_start` message

**5. Flow Control:**
- Monitor `bufferedAmount` (WebRTC)
- Implement backpressure with `bufferedAmountLowThreshold`
- Sliding window of 5-10 chunks in flight

**6. Resume Capability:**
- Receiver reports received chunks on reconnection
- Sender resumes from first missing chunk
- Store transfer state for session recovery

**7. Progress & UX:**
- Determinate progress bar with percentage
- Show retry status distinctly (yellow/warning)
- Provide manual retry button for stuck transfers
- Clear error messages with actionable information

**Proposed Protocol Messages (Enhanced):**

```typescript
// Include chunk hashes in start message
interface FileStartMessage {
  type: 'file_start';
  fileId: string;
  fileName: string;
  totalSize: number;
  totalChunks: number;
  chunkSize: number;
  chunkHashes: string[];  // SHA-256 of each chunk
  fileHash: string;       // Merkle root or full-file hash
}

// Chunk includes its hash for immediate verification
interface FileChunkMessage {
  type: 'file_chunk';
  fileId: string;
  chunkIndex: number;
  data: string;           // Base64 encrypted
  hash: string;           // SHA-256 of plaintext chunk
}

// SACK-style acknowledgment
interface ChunkAckMessage {
  type: 'chunk_ack';
  fileId: string;
  cumulativeAck: number;  // All chunks up to this index received
  sackBlocks?: Array<{    // Additional received ranges
    start: number;
    end: number;
  }>;
  nack?: number[];        // Explicitly request these chunks
}

// Resume request from receiver
interface ResumeRequestMessage {
  type: 'resume_request';
  fileId: string;
  receivedChunks: number[]; // What receiver has
  expectedHash: string;     // Verify we're resuming same file
}
```

This approach combines the best practices from:
- Signal: Strong encryption, HMAC verification
- Telegram: Parallel uploads, progress tracking
- BitTorrent/IPFS: Per-chunk hashing, content verification
- WebRTC: Backpressure, buffer management
- TCP: Selective acknowledgment, sliding window
