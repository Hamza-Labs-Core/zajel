# Issue #31: No Backpressure in File Transfer

## Problem Summary

The current file transfer implementation in `packages/web-client/src/lib/webrtc.ts` and `packages/web-client/src/App.tsx` does not check the data channel's `bufferedAmount` before sending chunks. This can lead to buffer overflow, causing:

1. Memory exhaustion on the sender side
2. Data channel closure (Chrome closes DataChannel when buffer exceeds 16MB)
3. Latency jitter and degraded performance
4. Potential data loss or connection failure

## Current Implementation Analysis

### webrtc.ts - sendFileChunk Method (Lines 232-243)

```typescript
sendFileChunk(fileId: string, chunkIndex: number, data: string): void {
  if (this.fileChannel?.readyState === 'open') {
    this.fileChannel.send(
      JSON.stringify({
        type: 'file_chunk',
        fileId,
        chunkIndex,
        data,
      })
    );
  }
}
```

**Issues:**
- No check of `bufferedAmount` before sending
- No flow control mechanism
- Blindly sends data regardless of network conditions

### App.tsx - File Sending Loop (Lines 374-398)

```typescript
for (let i = 0; i < totalChunks; i++) {
  const start = i * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, file.size);
  const chunk = bytes.slice(start, end);

  // Encrypt chunk
  const base64 = btoa(String.fromCharCode(...chunk));
  const encrypted = cryptoService.encrypt(peerCode, base64);

  webrtcRef.current.sendFileChunk(fileId, i, encrypted);

  // Update progress
  setTransfers((prev) =>
    prev.map((t) =>
      t.id === fileId ? { ...t, receivedChunks: i + 1 } : t
    )
  );

  // Small delay to prevent overwhelming
  await new Promise((r) => setTimeout(r, 10));
}
```

**Issues:**
- Uses fixed 10ms delay which is inefficient:
  - Too slow when network is fast (wasted throughput)
  - Too fast when network is congested (buffer overflow)
- No awareness of actual buffer state
- No adaptive flow control

## WebRTC Data Channel Buffer Behavior

According to [MDN bufferedAmount documentation](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount) and [WebRTC specifications](https://www.w3.org/TR/webrtc/):

1. **bufferedAmount**: Read-only property returning bytes queued for sending
2. **bufferedAmountLowThreshold**: Threshold that triggers `bufferedamountlow` event when buffer falls below
3. **Chrome buffer limit**: 16MB maximum - channel closes immediately if exceeded
4. **Firefox/Chrome behavior**: Data handed to SCTP immediately; `bufferedAmount` only grows when SCTP buffers fill

## Proposed Solution

### 1. Add Buffer Constants (webrtc.ts)

```typescript
// Buffer management constants
const HIGH_WATER_MARK = 1024 * 1024;      // 1MB - pause sending
const LOW_WATER_MARK = 256 * 1024;        // 256KB - resume sending
const MAX_BUFFER_SIZE = 16 * 1024 * 1024; // 16MB - Chrome's hard limit
```

### 2. Enhance sendFileChunk with Backpressure (webrtc.ts)

```typescript
/**
 * Sends a file chunk with backpressure handling.
 * Returns a promise that resolves when buffer has space.
 */
async sendFileChunk(fileId: string, chunkIndex: number, data: string): Promise<boolean> {
  if (this.fileChannel?.readyState !== 'open') {
    return false;
  }

  // Wait for buffer to drain if it's too full
  await this.waitForBufferDrain();

  try {
    this.fileChannel.send(
      JSON.stringify({
        type: 'file_chunk',
        fileId,
        chunkIndex,
        data,
      })
    );
    return true;
  } catch (error) {
    console.error('Failed to send chunk:', error);
    return false;
  }
}

private waitForBufferDrain(): Promise<void> {
  return new Promise((resolve) => {
    if (!this.fileChannel) {
      resolve();
      return;
    }

    // Check if buffer is below threshold
    if (this.fileChannel.bufferedAmount <= HIGH_WATER_MARK) {
      resolve();
      return;
    }

    // Set up threshold-based resume
    this.fileChannel.bufferedAmountLowThreshold = LOW_WATER_MARK;

    const onBufferLow = () => {
      this.fileChannel?.removeEventListener('bufferedamountlow', onBufferLow);
      resolve();
    };

    this.fileChannel.addEventListener('bufferedamountlow', onBufferLow);

    // Safety timeout to prevent infinite wait
    setTimeout(() => {
      this.fileChannel?.removeEventListener('bufferedamountlow', onBufferLow);
      resolve();
    }, 30000);
  });
}
```

### 3. Add Buffer Status Getter (webrtc.ts)

```typescript
get fileChannelBufferedAmount(): number {
  return this.fileChannel?.bufferedAmount ?? 0;
}

get isFileChannelBufferFull(): boolean {
  return (this.fileChannel?.bufferedAmount ?? 0) > HIGH_WATER_MARK;
}
```

### 4. Update File Sending Loop (App.tsx)

```typescript
const handleSendFile = useCallback(
  async (file: File) => {
    if (!peerCode || !webrtcRef.current) return;

    const fileId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Add to transfers
    setTransfers((prev) => {
      const updated = [
        ...prev,
        {
          id: fileId,
          fileName: file.name,
          totalSize: file.size,
          totalChunks,
          receivedChunks: 0,
          status: 'sending' as const,
        },
      ];
      // Limit tracking
      if (updated.length > MAX_TRANSFERS) {
        const activeTransfers = updated.filter(t => t.status !== 'complete');
        const completedTransfers = updated.filter(t => t.status === 'complete');
        const toKeep = MAX_TRANSFERS - activeTransfers.length;
        return [...completedTransfers.slice(-Math.max(0, toKeep)), ...activeTransfers];
      }
      return updated;
    });

    // Send file start
    webrtcRef.current.sendFileStart(fileId, file.name, file.size, totalChunks);

    // Read and send chunks with backpressure
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    for (let i = 0; i < totalChunks; i++) {
      // Check if transfer was cancelled
      const currentTransfer = transfers.find(t => t.id === fileId);
      if (currentTransfer?.status === 'failed') {
        return;
      }

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = bytes.slice(start, end);

      // Encrypt chunk
      const base64 = btoa(String.fromCharCode(...chunk));
      const encrypted = cryptoService.encrypt(peerCode, base64);

      // Send with backpressure handling (awaits buffer drain)
      const sent = await webrtcRef.current.sendFileChunk(fileId, i, encrypted);

      if (!sent) {
        // Channel closed or error
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === fileId
              ? { ...t, status: 'failed', error: 'Connection lost' }
              : t
          )
        );
        return;
      }

      // Update progress
      setTransfers((prev) =>
        prev.map((t) =>
          t.id === fileId ? { ...t, receivedChunks: i + 1 } : t
        )
      );
    }

    // Send complete
    webrtcRef.current.sendFileComplete(fileId);
    setTransfers((prev) =>
      prev.map((t) => (t.id === fileId ? { ...t, status: 'complete' } : t))
    );
  },
  [peerCode, transfers]
);
```

### 5. Optional: Add Transfer Progress with Throughput Info

```typescript
interface FileTransfer {
  id: string;
  fileName: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: number;
  status: 'sending' | 'receiving' | 'complete' | 'failed';
  error?: string;
  data?: Uint8Array[];
  // New fields for monitoring
  startTime?: number;
  bytesPerSecond?: number;
  isPaused?: boolean; // True when waiting for buffer drain
}
```

## Alternative Approaches Considered

### 1. requestIdleCallback-based Sending

```typescript
function sendChunksIdle(chunks: Uint8Array[], index: number) {
  requestIdleCallback((deadline) => {
    while (deadline.timeRemaining() > 0 && index < chunks.length) {
      if (channel.bufferedAmount > HIGH_WATER_MARK) break;
      channel.send(chunks[index++]);
    }
    if (index < chunks.length) {
      sendChunksIdle(chunks, index);
    }
  });
}
```

**Pros**: Doesn't block main thread
**Cons**: Less predictable timing, may still overflow buffer between checks

### 2. Worker-based File Reading

Offload file reading and encryption to a Web Worker to avoid blocking UI.

**Pros**: Better UI responsiveness
**Cons**: Adds complexity, main issue of backpressure still needs addressing

### 3. Streaming with ReadableStream

Use the Streams API for more elegant flow control:

```typescript
const stream = file.stream();
const reader = stream.getReader();

async function pump() {
  const { done, value } = await reader.read();
  if (done) return;

  await waitForBufferDrain();
  channel.send(value);
  return pump();
}
```

**Pros**: Modern, elegant, memory-efficient
**Cons**: Requires refactoring, encryption integration more complex

## Recommended Implementation Priority

1. **High Priority**: Add `bufferedAmount` check before sending in `sendFileChunk`
2. **High Priority**: Use `bufferedamountlow` event instead of fixed timeout
3. **Medium Priority**: Add buffer status getters for monitoring
4. **Low Priority**: Consider Web Worker for large file handling

## Testing Considerations

1. **Large File Transfer**: Test with files > 100MB
2. **Slow Network Simulation**: Use browser DevTools to throttle network
3. **Concurrent Transfers**: Test multiple simultaneous file transfers
4. **Buffer Overflow**: Verify channel doesn't close under stress
5. **Progress Accuracy**: Ensure UI reflects actual send progress vs queued

## References

- [MDN: RTCDataChannel.bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount)
- [MDN: RTCDataChannel.bufferedAmountLowThreshold](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmountLowThreshold)
- [WebRTC Specification - Data Channels](https://www.w3.org/TR/webrtc/#rtcdatachannel)
- [GetStream - WebRTC Buffers Guide](https://getstream.io/resources/projects/webrtc/advanced/buffers/)
- [WebRTC for the Curious - Data Communication](https://webrtcforthecurious.com/docs/07-data-communication/)
- [Pion WebRTC - bufferedAmount Control Issue](https://github.com/pion/webrtc/issues/811)
- [Chrome Bug: DataChannel Buffer State](https://bugs.chromium.org/p/webrtc/issues/detail?id=2866)

## Research: How Other Apps Solve This

This section documents how various WebRTC applications and libraries handle backpressure and flow control in data channels.

### 1. WebRTC Data Channel API (Browser Built-in)

The browser's RTCDataChannel API provides two key properties for flow control:

#### bufferedAmount Property

From [MDN RTCDataChannel.bufferedAmount](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmount):

- Returns the number of bytes currently queued for sending
- Does not include framing overhead or OS/network hardware buffering
- Chrome and Firefox hand data to SCTP immediately; `bufferedAmount` only grows when SCTP buffers fill
- Browser limit: Chrome closes the DataChannel if buffer exceeds 16MB

#### bufferedAmountLowThreshold Property

From [MDN RTCDataChannel.bufferedAmountLowThreshold](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmountLowThreshold):

- Default value is 0
- When `bufferedAmount` falls to or below this value, the `bufferedamountlow` event fires
- Enables efficient queue-based sending patterns

#### Standard Pattern from MDN

```javascript
let dc = pc.createDataChannel("SendFile");
let source = /* file handle or data source */;

dc.bufferedAmountLowThreshold = 65536; // 64KB

dc.addEventListener("bufferedamountlow", (ev) => {
  if (source.position <= source.length) {
    dc.send(source.readFile(65536));
  }
});
```

### 2. Pion WebRTC (Go Implementation)

From [Pion WebRTC data-channels-flow-control example](https://github.com/pion/webrtc/tree/master/examples/data-channels-flow-control):

Pion provides a reference implementation demonstrating proper flow control:

#### Constants

```go
const (
    bufferedAmountLowThreshold uint64 = 512 * 1024  // 512 KB - resume threshold
    maxBufferedAmount          uint64 = 1024 * 1024 // 1 MB - pause threshold
)
```

#### Sender Implementation

```go
dataChannel.OnOpen(func() {
    for {
        err := dataChannel.Send(buf)
        if err != nil { return }

        // Pause when buffer exceeds high water mark
        if dataChannel.BufferedAmount() > maxBufferedAmount {
            <-sendMoreCh  // Block until signaled to resume
        }
    }
})

// Configure threshold for resume signal
dataChannel.SetBufferedAmountLowThreshold(bufferedAmountLowThreshold)

// Resume callback when buffer drains
dataChannel.OnBufferedAmountLow(func() {
    select {
    case sendMoreCh <- struct{}{}:
    default:
    }
})
```

**Key Insight**: Pion uses a channel-based blocking pattern. The sender blocks when `bufferedAmount > 1MB` and resumes when the buffer drops below 512KB.

**Performance**: This pattern achieves 179-218 Mbps throughput in benchmarks.

### 3. libdatachannel (C/C++ Implementation)

From [libdatachannel documentation](https://github.com/paullouisageneau/libdatachannel/blob/master/DOC.md):

libdatachannel is a standalone C/C++ WebRTC implementation used in many native applications.

#### Key APIs

```c
// Get current buffered amount
int rtcGetBufferedAmount(int id);

// Set threshold for low buffer callback
int rtcSetBufferedAmountLowThreshold(int id, int amount);

// Register callback for buffer drain notification
int rtcSetBufferedAmountLowCallback(int id, rtcBufferedAmountLowCallbackFunc cb);

// Callback signature
void myBufferedAmountLowCallback(int id, void *user_ptr);
```

#### Flow Control Behavior

- Messages are sent immediately if possible, otherwise buffered
- If flow control or congestion control prevents immediate send, data queues
- `rtcGetBufferedAmount` only counts user-level buffering, not transport-level
- Initial threshold is 0 (callback fires when buffer empties completely)
- Applications should set a higher threshold for continuous streaming

### 4. WebTorrent / simple-peer

From [WebTorrent/simple-peer](https://github.com/feross/simple-peer) and [bittorrent-protocol](https://github.com/webtorrent/bittorrent-protocol):

WebTorrent uses Node.js stream semantics for flow control:

#### Stream-Based Architecture

- simple-peer implements a duplex stream interface
- Backpressure handled through Node.js Streams conventions
- The `write()` method returns `false` when buffer is full
- Consumer waits for `drain` event before sending more

#### Chunking Strategy

- Files split into chunks (typically 16KB for cross-browser compatibility)
- Messages sent sequentially through the stream
- Stream backpressure automatically pauses the file reader
- P2PT (WebTorrent-based signaling) handles: "Data splitted into chunks, sent, received and reassembled all by the library"

#### Implementation Pattern

```javascript
// Simplified stream-based sending
const peer = new SimplePeer();
const fileStream = file.stream();

fileStream.pipe(peer);  // Backpressure handled automatically
```

### 5. WebRTC Samples (Official Examples)

From [WebRTC samples filetransfer](https://webrtc.github.io/samples/src/content/datachannel/filetransfer/):

The official WebRTC samples demonstrate queue-based flow control:

```javascript
// Queue-based sending with pause/resume
class Channel {
  static BUFFER_THRESHOLD = 256 * 1024; // 256KB
  #queue = [];
  #paused = false;

  send(data) {
    this.#queue.push(data);
    if (this.#paused) return;
    this.shiftQueue();
  }

  shiftQueue() {
    this.#paused = false;
    let message = this.#queue.shift();

    while (message) {
      if (this.#channel.bufferedAmount > Channel.BUFFER_THRESHOLD) {
        this.#paused = true;
        this.#queue.unshift(message);
        this.#channel.addEventListener("bufferedamountlow", () => {
          this.shiftQueue();
        }, { once: true });
        return;
      }
      this.#channel.send(message);
      message = this.#queue.shift();
    }
  }
}
```

**Key Points**:
- Uses 256KB as buffer threshold
- Queue holds pending chunks when paused
- `bufferedamountlow` triggers queue drain
- `{ once: true }` prevents listener accumulation

### 6. SCTP Protocol (Underlying Layer)

From [RFC 4960](https://datatracker.ietf.org/doc/html/rfc4960), [RFC 8831](https://datatracker.ietf.org/doc/html/rfc8831), and [WebRTC for the Curious](https://webrtcforthecurious.com/docs/07-data-communication/):

WebRTC data channels use SCTP over DTLS over UDP. Understanding SCTP helps explain browser behavior:

#### Flow Control via a_rwnd (Advertised Receiver Window)

```
SCTP Flow Control:
  Sender                              Receiver
    |                                    |
    | -------- DATA chunks ---------->   |
    |                                    |
    | <------- SACK (a_rwnd=X) --------  |
    |                                    |
    | Sender limits outstanding data     |
    | to min(cwnd, a_rwnd)               |
```

- **a_rwnd**: Receiver's available buffer space (up to 4GB)
- **cwnd**: Congestion window (sender's rate limit)
- Actual send rate = min(cwnd, a_rwnd) / RTT
- Firefox uses 1MB as default SCTP window size (Bug 1051685)
- Chrome's usrsctp uses 128KB initial window

#### Congestion Control

SCTP uses TCP-like congestion control:

1. **Slow Start**: cwnd starts small, doubles each RTT
2. **Congestion Avoidance**: Linear growth after threshold
3. **Fast Retransmit**: Based on SACK gap reports
4. **Fast Recovery**: Halve cwnd on packet loss

#### Browser-Level vs Application-Level Backpressure

The SCTP layer provides backpressure through a_rwnd, but this happens below the JavaScript API. The `bufferedAmount` property reflects:

1. Data queued in the browser's DataChannel implementation
2. Data queued in the usrsctp/dcSCTP buffer waiting for SCTP transmission
3. Does NOT include data successfully handed to the network stack

When `bufferedAmount` grows, it indicates the SCTP layer is flow-controlled by either:
- Network congestion (cwnd limited)
- Receiver buffer full (a_rwnd limited)

### 7. Memory Pressure Considerations

From [Mozilla WebRTC blog](https://blog.mozilla.org/webrtc/large-data-channel-messages/) and [Firefox Bug 953084](https://bugzilla.mozilla.org/show_bug.cgi?id=953084):

#### Large Message Problem

The RTCDataChannel API is high-level and doesn't support streaming:
- Entire message must be in memory when calling `send()`
- Receiver buffers entire message before delivering to JavaScript
- 1GB file = 1GB sender memory + 1GB receiver memory (minimum)

#### Browser Protections

- **Chrome**: Closes DataChannel when buffer > 16MB
- **Firefox**: May unload tabs under memory pressure (respects WebRTC tabs)
- Both: No explicit memory limit API for applications

#### Recommendations

1. Keep chunk sizes small (16-64KB for cross-browser compatibility)
2. Monitor `bufferedAmount` to prevent memory exhaustion
3. Consider Web Workers for encryption/processing
4. Implement application-level flow control, don't rely solely on SCTP

### 8. Adaptive Sending Patterns

From [GetStream WebRTC Buffers Guide](https://getstream.io/resources/projects/webrtc/advanced/buffers/) and throughput research:

#### Throughput-Aware Sending

```javascript
class AdaptiveSender {
  constructor(channel) {
    this.channel = channel;
    this.bytesSent = 0;
    this.startTime = Date.now();
    this.lastCheck = Date.now();
    this.throughput = 0;
  }

  async send(chunk) {
    // Wait if buffer too full
    await this.waitForBuffer();

    this.channel.send(chunk);
    this.bytesSent += chunk.byteLength;

    // Calculate throughput every second
    const now = Date.now();
    if (now - this.lastCheck > 1000) {
      this.throughput = this.bytesSent / ((now - this.startTime) / 1000);
      this.lastCheck = now;
    }
  }

  async waitForBuffer() {
    if (this.channel.bufferedAmount < HIGH_WATER_MARK) return;

    return new Promise(resolve => {
      this.channel.bufferedAmountLowThreshold = LOW_WATER_MARK;
      this.channel.addEventListener('bufferedamountlow', resolve, { once: true });
    });
  }

  getThroughput() {
    return this.throughput; // bytes/second
  }
}
```

#### Buffer Growth as Congestion Signal

Monitor buffer growth rate to detect network issues:

```javascript
let lastBufferedAmount = 0;
let bufferGrowthRate = 0;

setInterval(() => {
  const current = channel.bufferedAmount;
  bufferGrowthRate = current - lastBufferedAmount;
  lastBufferedAmount = current;

  if (bufferGrowthRate > 100000) {
    console.warn('Network congestion detected, buffer growing rapidly');
  }
}, 1000);
```

### Summary of Best Practices

| Aspect | Recommended Approach |
|--------|---------------------|
| **High Water Mark** | 1MB (Pion) or 256KB (WebRTC samples) |
| **Low Water Mark** | 512KB (Pion) or 64KB (MDN examples) |
| **Chunk Size** | 16-64KB for cross-browser compatibility |
| **Event Model** | Use `bufferedamountlow` with `{ once: true }` |
| **Blocking Pattern** | Promise-based wait for buffer drain |
| **Timeout Safety** | Add 30s timeout to prevent infinite waits |
| **Progress Tracking** | Track "sent to buffer" vs "acknowledged by peer" |
| **Memory Safety** | Keep file chunks on disk/stream, not all in memory |

### Additional References from Research

- [Pion WebRTC Flow Control Example](https://github.com/pion/webrtc/tree/master/examples/data-channels-flow-control)
- [libdatachannel GitHub](https://github.com/paullouisageneau/libdatachannel)
- [simple-peer GitHub](https://github.com/feross/simple-peer)
- [WebTorrent bittorrent-protocol](https://github.com/webtorrent/bittorrent-protocol)
- [SCTP RFC 4960](https://datatracker.ietf.org/doc/html/rfc4960)
- [WebRTC Data Channels RFC 8831](https://datatracker.ietf.org/doc/html/rfc8831)
- [Mozilla Large Data Channel Messages Blog](https://blog.mozilla.org/webrtc/large-data-channel-messages/)
- [W3C WebRTC Issue #1979: bufferedamountlow usage](https://github.com/w3c/webrtc-pc/issues/1979)
- [Firefox Bug 1051685: SCTP window size](https://bugzilla.mozilla.org/show_bug.cgi?id=1051685)
