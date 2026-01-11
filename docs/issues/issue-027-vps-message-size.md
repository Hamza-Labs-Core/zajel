# Issue #27: VPS Server Message Size Validation

## Status: IMPLEMENTED

**Last Updated**: January 2026
**Implementation Status**: Complete
**Risk Level**: Mitigated

## Summary

This issue tracked the need for message size validation in the VPS server to prevent DoS attacks via large WebSocket messages. **The fix has been fully implemented** with defense-in-depth at multiple layers.

## Implementation Verification

### 1. WebSocket Server Level (Primary Protection)

**File**: `/home/meywd/zajel/packages/server-vps/src/index.ts` (lines 126-135)

The WebSocket servers are now configured with `maxPayload`:

```typescript
// maxPayload enforces size limits at the protocol level before buffering
// Messages exceeding the limit are rejected with close code 1009 ("Message Too Big")
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: WEBSOCKET.MAX_MESSAGE_SIZE,
});
const federationWss = new WebSocketServer({
  noServer: true,
  maxPayload: WEBSOCKET.MAX_MESSAGE_SIZE,
});
```

### 2. Centralized Constants

**File**: `/home/meywd/zajel/packages/server-vps/src/constants.ts` (lines 12-15)

```typescript
export const WEBSOCKET = {
  /** Maximum message size (64KB) - matches WebSocket server config */
  MAX_MESSAGE_SIZE: 64 * 1024,
} as const;
```

### 3. Application-Level Validation (Defense in Depth)

**File**: `/home/meywd/zajel/packages/server-vps/src/client/handler.ts` (lines 273-280)

```typescript
async handleMessage(ws: WebSocket, data: string): Promise<void> {
  // Size validation (defense in depth - primary limit is at WebSocket level)
  // This catches any messages that slip through or are used in testing
  if (data.length > WEBSOCKET.MAX_MESSAGE_SIZE) {
    console.warn(`[Security] Rejected oversized message: ${data.length} bytes (limit: ${WEBSOCKET.MAX_MESSAGE_SIZE})`);
    this.sendError(ws, 'Message too large');
    ws.close(1009, 'Message Too Big');
    return;
  }
  // ... continues with rate limiting and message processing
}
```

### 4. Federation Transport Validation

**File**: `/home/meywd/zajel/packages/server-vps/src/federation/transport/server-connection.ts`

Size validation is implemented in three locations:
- Line 242: Outgoing connection handshake messages
- Line 314: Incoming connection messages
- Line 427: Established connection messages

```typescript
// Size validation (defense in depth)
if (dataStr.length > WEBSOCKET.MAX_MESSAGE_SIZE) {
  logger.warn(`[Security] Rejected oversized federation message`, { bytes: dataStr.length });
  ws.close(1009, 'Message Too Big');
  return;
}
```

## Current Configuration

| Component | Limit | Implementation |
|-----------|-------|----------------|
| WebSocket `maxPayload` | 64 KB | `ws` library config in index.ts |
| Client handler validation | 64 KB | handler.ts defense in depth |
| Federation transport validation | 64 KB | server-connection.ts defense in depth |
| Rate limiting | 100 msg/min | handler.ts `checkRateLimit()` |

## DoS Risk Assessment

### Mitigated Attack Vectors

1. **Memory Exhaustion Attack**: MITIGATED
   - The `ws` library's `maxPayload` option rejects oversized messages at the frame level
   - Memory is never allocated for messages exceeding 64 KB
   - Connection closed with code 1009 before buffering

2. **JSON Parse Attack**: MITIGATED
   - Application-level validation runs before `JSON.parse()`
   - Combined with 64 KB limit, CPU impact is minimal
   - Rate limiting (100/min) further restricts total bandwidth

3. **Federation Amplification**: MITIGATED
   - Same 64 KB limit applies to server-to-server connections
   - All three message paths in server-connection.ts are protected

### Residual Risk

- **Low**: An attacker could still send 100 messages x 64 KB = 6.4 MB per minute per connection
- **Mitigation**: Rate limiting and connection management already in place
- **Recommendation**: Consider connection-level bandwidth limits if abuse is observed

## Comparison with Industry Standards

### Discord
- **Limit**: 15 KB payload
- **Zajel**: 64 KB (4x larger but still conservative)

### Slack
- **Limit**: 16 KB for WebSocket messages, 4000 characters recommended
- **Zajel**: 64 KB aligns with upper bound

### Matrix/Synapse
- **Limit**: 65 KB event size (spec mandated)
- **Zajel**: 64 KB matches Matrix specification rationale

### Signal
- **Limit**: 64 KB (Jetty defaults)
- **Zajel**: Identical to Signal's approach

## Why 64 KB (not 1 MB)?

The original issue mentioned a 1 MB client limit, but the implementation uses 64 KB for good reasons:

1. **WebRTC signaling payloads are small**: SDP offers are typically 1-5 KB
2. **Industry alignment**: Discord (15 KB), Matrix (65 KB), Signal (64 KB) all use similar limits
3. **Memory efficiency**: Smaller limits reduce per-connection memory overhead
4. **UDP datagram fit**: 65,507 bytes fits in a single UDP datagram without fragmentation

## Original Issue Context (Historical)

The original concern was that the server lacked message size validation while the client enforced a 1 MB limit. This asymmetry could allow DoS attacks. The implementation addressed this by:

1. Adding `maxPayload` to WebSocket server configuration
2. Choosing a more appropriate 64 KB limit (not 1 MB)
3. Adding defense-in-depth validation at application level
4. Ensuring consistent limits across client, server, and federation

---

## Appendix A: Original Attack Scenario (Now Mitigated)

This section documents the original vulnerability that existed before the fix was implemented.

### Attack Vector (Historical - Before Fix)

1. **Attacker Setup**: A malicious client establishes a WebSocket connection to the VPS server.

2. **Memory Exhaustion Attack**:
   - Attacker sends messages approaching 100MB each (the default `maxPayload` limit)
   - Each message must be fully buffered in memory before reaching the `on('message')` handler
   - Multiple concurrent connections can rapidly exhaust server memory

3. **JSON Parse Attack**:
   - Even with rate limiting (100 messages/minute), attacker can send ~100MB messages
   - That's potentially 10GB of data per minute per connection
   - `JSON.parse()` on large strings is CPU-intensive and creates additional memory overhead

4. **Impact**:
   - Memory exhaustion leading to server crashes
   - CPU saturation from parsing large JSON payloads
   - Degraded service for legitimate users
   - Potential cascading failures in the federated network

### Attack Code Example (For Reference)

```javascript
// This attack is now mitigated by the 64KB maxPayload limit
const ws = new WebSocket('wss://target-vps-server.com');

ws.onopen = () => {
  // This would have worked before the fix
  const hugePayload = JSON.stringify({
    type: 'register',
    peerId: 'attacker',
    padding: 'x'.repeat(50 * 1024 * 1024) // 50MB
  });

  // Now: Connection closed with code 1009 before payload is processed
  ws.send(hugePayload);
};
```

---

## Appendix B: Original Proposed Fix (Now Implemented)

**Note**: The implementation chose 64 KB instead of 1 MB for better security, based on industry research.

### 1. Configure maxPayload at WebSocket Server Level (Primary Fix) - DONE

**Status**: Implemented in `/home/meywd/zajel/packages/server-vps/src/index.ts`

The `ws` library `maxPayload` option:
- Enforces this limit during message buffering (frame level)
- Rejects with WebSocket close code 1009 ("Message Too Big")
- Memory is never allocated for oversized messages
- No application-level code runs for rejected messages

### 2. Add Application-Level Validation (Defense in Depth)

**File**: `/home/meywd/zajel/packages/server-vps/src/client/handler.ts`

```typescript
// Add constant at top of file
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB

// Update handleMessage method (around line 240)
async handleMessage(ws: WebSocket, data: string): Promise<void> {
  // Size validation BEFORE any processing
  if (data.length > MAX_MESSAGE_SIZE) {
    this.sendError(ws, 'Message too large');
    ws.close(1009, 'Message Too Big'); // Standard WebSocket close code
    return;
  }

  // Rate limiting check
  if (!this.checkRateLimit(ws)) {
    this.sendError(ws, 'Rate limit exceeded. Please slow down.');
    return;
  }

  let message: ClientMessage;

  try {
    message = JSON.parse(data);
  } catch (e) {
    this.sendError(ws, 'Invalid message format: JSON parse error');
    return;
  }
  // ... rest of handler
}
```

### 3. Add Size Validation to Federation Connections

**File**: `/home/meywd/zajel/packages/server-vps/src/federation/transport/server-connection.ts`

Apply similar validation to server-to-server message handlers at lines 235, 295, and 398.

### 4. Configuration Option (Optional Enhancement)

**File**: `/home/meywd/zajel/packages/server-vps/src/config.ts`

```typescript
export interface ServerConfig {
  // ... existing config
  websocket: {
    maxPayload: number;  // Maximum message size in bytes
  };
}

function loadConfig(): ServerConfig {
  return {
    // ... existing config
    websocket: {
      maxPayload: parseInt(process.env.ZAJEL_WS_MAX_PAYLOAD || '1048576', 10),
    },
  };
}
```

## Complete Patch

```diff
--- a/packages/server-vps/src/index.ts
+++ b/packages/server-vps/src/index.ts
@@ -18,6 +18,9 @@ import { DistributedRendezvous } from './registry/distributed-rendezvous.js';
 import { ClientHandler, type ClientHandlerConfig } from './client/handler.js';

+// Maximum WebSocket message size (1MB - matches client limit)
+const MAX_MESSAGE_SIZE = 1024 * 1024;
+
 export interface ZajelServer {
   httpServer: HttpServer;
   wss: WebSocketServer;
@@ -93,8 +96,16 @@ export async function createZajelServer(
   });

   // Create WebSocket servers (separate for clients and federation)
-  const wss = new WebSocketServer({ noServer: true });
-  const federationWss = new WebSocketServer({ noServer: true });
+  const wss = new WebSocketServer({
+    noServer: true,
+    maxPayload: MAX_MESSAGE_SIZE,
+  });
+
+  const federationWss = new WebSocketServer({
+    noServer: true,
+    maxPayload: MAX_MESSAGE_SIZE,
+  });

   // Federation configuration
   const federationConfig: FederationConfig = {
```

```diff
--- a/packages/server-vps/src/client/handler.ts
+++ b/packages/server-vps/src/client/handler.ts
@@ -14,6 +14,9 @@ import { DistributedRendezvous, type PartialResult } from '../registry/distribut
 import type { DeadDropResult, LiveMatchResult } from '../registry/rendezvous-registry.js';

+// Maximum message size (1MB - matches client and WebSocket server config)
+const MAX_MESSAGE_SIZE = 1024 * 1024;
+
 export interface ClientHandlerConfig {
   heartbeatInterval: number;   // Expected heartbeat interval from clients
   heartbeatTimeout: number;    // Time before considering client dead
@@ -237,6 +240,13 @@ export class ClientHandler extends EventEmitter {
    * Handle incoming WebSocket message
    */
   async handleMessage(ws: WebSocket, data: string): Promise<void> {
+    // Size validation (defense in depth - primary limit is at WebSocket level)
+    if (data.length > MAX_MESSAGE_SIZE) {
+      this.sendError(ws, 'Message too large');
+      ws.close(1009, 'Message Too Big');
+      return;
+    }
+
     // Rate limiting check
     if (!this.checkRateLimit(ws)) {
       this.sendError(ws, 'Rate limit exceeded. Please slow down.');
```

## Testing Approach

### Unit Tests

```typescript
// packages/server-vps/src/client/__tests__/handler.test.ts

import { WebSocket } from 'ws';
import { ClientHandler } from '../handler';

describe('ClientHandler Message Size Validation', () => {
  let handler: ClientHandler;
  let mockWs: jest.Mocked<WebSocket>;

  beforeEach(() => {
    // Setup handler with mocked dependencies
    mockWs = {
      readyState: WebSocket.OPEN,
      send: jest.fn(),
      close: jest.fn(),
    } as unknown as jest.Mocked<WebSocket>;

    // Initialize handler...
  });

  it('should reject messages exceeding 1MB', async () => {
    const largeMessage = 'x'.repeat(1024 * 1024 + 1); // 1MB + 1 byte

    await handler.handleMessage(mockWs, largeMessage);

    expect(mockWs.send).toHaveBeenCalledWith(
      expect.stringContaining('Message too large')
    );
    expect(mockWs.close).toHaveBeenCalledWith(1009, 'Message Too Big');
  });

  it('should accept messages under 1MB', async () => {
    const validMessage = JSON.stringify({ type: 'ping' });

    await handler.handleMessage(mockWs, validMessage);

    expect(mockWs.close).not.toHaveBeenCalled();
    expect(mockWs.send).toHaveBeenCalledWith(
      expect.stringContaining('pong')
    );
  });

  it('should accept messages exactly at 1MB limit', async () => {
    const paddedMessage = JSON.stringify({
      type: 'ping',
      padding: 'x'.repeat(1024 * 1024 - 50) // Leave room for JSON overhead
    });

    // This should be handled (though may fail validation on message content)
    await handler.handleMessage(mockWs, paddedMessage);

    // Should not be rejected for size
    expect(mockWs.close).not.toHaveBeenCalledWith(1009, expect.any(String));
  });
});
```

### Integration Tests

```typescript
// packages/server-vps/src/__tests__/message-size.integration.test.ts

import WebSocket from 'ws';
import { createZajelServer, ZajelServer } from '../index';

describe('WebSocket Message Size Limits', () => {
  let server: ZajelServer;
  const serverPort = 9999;

  beforeAll(async () => {
    server = await createZajelServer({
      network: { port: serverPort, host: '127.0.0.1', publicEndpoint: '' },
    });
  });

  afterAll(async () => {
    await server.shutdown();
  });

  it('should close connection for oversized messages with code 1009', (done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}`);

    ws.on('open', () => {
      // Try to send 2MB message (over 1MB limit)
      const oversizedMessage = 'x'.repeat(2 * 1024 * 1024);
      ws.send(oversizedMessage);
    });

    ws.on('close', (code, reason) => {
      expect(code).toBe(1009); // Message Too Big
      done();
    });
  });

  it('should accept normal-sized messages', (done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}`);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'ping' }));
    });

    ws.on('message', (data) => {
      const response = JSON.parse(data.toString());
      if (response.type === 'pong') {
        ws.close();
        done();
      }
    });
  });
});
```

### Manual Testing

```bash
# Test with wscat (install: npm install -g wscat)

# 1. Normal message (should work)
echo '{"type":"ping"}' | wscat -c ws://localhost:3000

# 2. Generate oversized message and test (should be rejected)
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000');
ws.on('open', () => {
  const big = JSON.stringify({ type: 'register', peerId: 'test', padding: 'x'.repeat(2*1024*1024) });
  console.log('Sending', big.length, 'bytes');
  ws.send(big);
});
ws.on('close', (code, reason) => {
  console.log('Closed:', code, reason.toString());
});
ws.on('error', console.error);
"
```

## Security Considerations

1. **Consistent Limits**: Ensure the same 1MB limit is used across client, server, and federation connections to prevent asymmetric attacks.

2. **Close Code**: Using WebSocket close code 1009 ("Message Too Big") is the standard way to indicate the reason for connection termination.

3. **Logging**: Consider logging rejected oversized messages (with limited info to avoid log injection) for security monitoring:
   ```typescript
   console.warn(`[Security] Rejected oversized message: ${data.length} bytes from ${clientIp}`);
   ```

4. **Rate Limiting Interaction**: The existing rate limiting (100 messages/minute) combined with size limiting effectively caps bandwidth to ~100MB/minute per connection.

## References

- [ws library maxPayload documentation](https://github.com/websockets/ws/blob/master/doc/ws.md)
- [WebSocket Close Code 1009](https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent/code)
- [ws library issue #469: Limit maximum incoming message size](https://github.com/websockets/ws/issues/469)
- [OWASP WebSocket Security Guidelines](https://cheatsheetseries.owasp.org/cheatsheets/WebSockets_Cheat_Sheet.html)

## Priority

**High** - This is a potential DoS vulnerability that could be exploited to crash server instances or degrade service quality across the federated network.

## Research: How Other Apps Solve This

This section documents how production messaging systems handle WebSocket message size limits and DoS protection, based on research conducted January 2026.

### Signal Server

Signal's server architecture uses **Jetty WebSockets** with the [WebSocket-Resources library](https://github.com/signalapp/WebSocket-Resources) that models WebSocket connections as bidirectional HTTP-style request/response channels.

**Key findings:**

- **Default Jetty limit**: 64 KB for text/binary messages (`@WebSocket(maxTextMessageSize = 64 * 1024)`)
- **Configurable via**: `Session.setMaxBinaryMessageBufferSize(int)` and `Session.setMaxTextMessageBufferSize(int)` in JSR 356
- **Signaling payloads**: Signal uses envelope encryption with relatively small signaling messages (SDP offers/answers, ICE candidates)
- **Attachment handling**: Large files are uploaded separately via REST API, not through WebSocket signaling
- **Buffer sizes**: The [libsignal-service-java](https://github.com/signalapp/libsignal-service-java/issues/56) uses 32KB buffer sizes for socket read/write operations

**Relevant for Zajel**: Signal's approach of keeping signaling messages small and handling media uploads separately aligns with Zajel's WebRTC signaling use case. A 64KB limit for signaling would be more than sufficient.

### Matrix Synapse

Matrix/Synapse implements multiple layers of size and rate limiting:

**Event Size Limits ([Matrix Spec](https://github.com/matrix-org/matrix-doc/issues/1021)):**
- **Maximum event size**: ~65 KB (spec mandates events MUST NOT exceed 65 KB)
- **Encrypted message limit**: 49,152 bytes (48 KB) - enforced at Olm/Megolm encryption layer
- **Rationale**: 65,507 bytes allows an event to fit in a single UDP datagram without fragmentation

**Upload Limits ([homeserver.yaml](https://matrix-org.github.io/synapse/latest/usage/configuration/config_documentation.html)):**
```yaml
max_upload_size: "50M"  # Default, configurable
```

**Rate Limiting ([Configuration](https://github.com/matrix-org/synapse/issues/6286)):**
- `per_second`: Duration of burst period
- `burst_count`: Maximum requests in that period
- Example: `per_second: 1` + `burst_count: 5` = max 5 requests/second

**Relevant for Zajel**: The layered approach (protocol-level event limits + encryption-level limits + configurable rate limits) provides defense in depth.

### Telegram MTProto

Telegram's [MTProto protocol](https://core.telegram.org/mtproto) uses a custom binary serialization (TL) with built-in DoS protections:

**Message Structure:**
- Message ID: 64 bits
- Sequence number: 32 bits
- Length: 32 bits (body in bytes, must be multiple of 4)
- Body: Variable size

**DoS Protection Mechanisms:**
- **Container limits**: Max 1024 messages per container
- **Service message batching**: Max 8192 IDs per acknowledgment/state request batch
- **Time validation**: Messages rejected if >300 seconds old or >30 seconds in future (replay protection)
- **Transport flood**: Error 429 returned when too many connections from same IP or container limits exceeded
- **Proof of work**: PQ decomposition in authorization serves as anti-DoS mechanism

**Relevant for Zajel**: Telegram's container message limits and time-based validation are interesting patterns for federation scenarios.

### Discord Gateway

Discord's WebSocket gateway has well-documented limits ([Gateway Docs](https://github.com/discord/discord-api-docs/discussions/6620)):

**Payload Limits:**
- **Maximum payload size**: **15 KB** - connections closed with code 4002 if exceeded
- **Serialization**: JSON or binary ETF

**Rate Limiting:**
- **Send rate limit**: 120 events per 60 seconds per connection (~2/second)
- **Identify limit**: 1000 identify calls per 24 hours (global across shards)
- **Penalty**: Immediate WebSocket close for rate limit violations

**Sharding:**
- Required at 2,500+ guilds
- Recommended: 1 shard per 1,000 guilds
- Distributes load across multiple WebSocket connections

**Relevant for Zajel**: Discord's 15 KB limit is notably aggressive and works well for real-time messaging. Their clear rate limiting (120/60s) is well-documented and predictable.

### Node.js ws Library Best Practices

The [ws library documentation](https://github.com/websockets/ws/blob/master/doc/ws.md) and [OWASP WebSocket Security guidelines](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html) recommend:

**maxPayload Configuration:**
```javascript
const wss = new WebSocket.Server({
  maxPayload: 64 * 1024  // 64 KB recommended for signaling
});
```

- **Default**: 100 MiB (too large for most use cases)
- **Enforcement**: Library rejects oversized messages with close code 1009
- **Memory safety**: Rejection happens at framing level, before full message buffering

**Additional Security Settings:**
```javascript
const wss = new WebSocket.Server({
  maxPayload: 64 * 1024,
  // Disable compression unless needed (CRIME/BREACH-like attack vectors)
  perMessageDeflate: false,
  // Use verifyClient for origin/auth checks
  verifyClient: (info, callback) => { /* ... */ }
});
```

**Key recommendations:**
- Never implement size limits manually by reading entire message first
- Disable `perMessageDeflate` unless specifically needed (security + performance)
- Use `verifyClient` callback for authentication during handshake
- Implement idle connection timeouts

### NGINX/Load Balancer Configuration

[NGINX WebSocket proxy configuration](https://websocket.org/guides/infrastructure/nginx/):

**Buffer Settings:**
```nginx
location /ws {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # Buffer configuration
    proxy_buffer_size 16k;
    proxy_buffers 4 16k;

    # Timeouts for long-lived connections
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

**Important Notes:**
- WebSocket connections use two buffers of `proxy_buffer_size` (upstream + downstream)
- WebSocket traffic never buffers to disk (unlike regular HTTP)
- Buffer sizes should align with memory page size (typically 4K)
- Keeping proxy buffering enabled is recommended (disabling breaks rate limiting/caching)

**Client body limits:**
```nginx
client_max_body_size 1m;  # For HTTP upgrade request
```

### Early Rejection Patterns

The most effective DoS prevention uses **early rejection before memory allocation**:

**Kong Gateway Implementation ([Kong WebSocket Size Limit](https://docs.konghq.com/hub/kong-inc/websocket-size-limit/)):**
- For limits ≤125 bytes: Check after reading entire message (unavoidable)
- For limits ≥126 bytes: Check from frame header BEFORE reading payload
- Aggregates continuation frames with running size tracking

**WebSocket Frame Structure:**
- Minimum frame: 2 bytes
- Maximum header: 14 bytes (client-to-server, payload >64KB)
- **Payload length in header**: Allows rejection before allocating payload buffers

**ws Library Behavior:**
- Checks payload length from frame header
- Closes connection with code 1009 before buffering oversized payloads
- Does not reveal exact limit in error message (security hardening)

### WebRTC Signaling Size Considerations

For WebRTC signaling servers like Zajel, typical message sizes are:

**SDP (Session Description Protocol):**
- Audio-video offer: ~1,500+ characters (before ICE candidates)
- Data channel only: ~400 bytes
- Minimal connection: ~100 characters each direction

**ICE Candidates:**
- Variable count depending on network interfaces
- Trickle ICE sends candidates incrementally
- `ice-ufrag`: 16 characters (RFC 5245 security requirement)

**Recommended Limit for Signaling:**
- 64 KB is generous for any WebRTC signaling scenario
- 16 KB would handle typical cases with margin
- Discord's 15 KB limit proves small limits work in production

### Summary: Recommended Limits for Zajel

Based on this research, the following limits are recommended:

| Component | Recommended Limit | Rationale |
|-----------|-------------------|-----------|
| WebSocket `maxPayload` | 64 KB | Sufficient for WebRTC signaling (SDP + ICE), matches Jetty defaults |
| Application validation | 64 KB | Defense in depth, consistent with WebSocket limit |
| Rate limiting | 100 msg/min | Already implemented, aligns with industry practice |
| NGINX `proxy_buffer_size` | 16 KB | Standard for WebSocket proxying |

**Key Patterns to Adopt:**
1. **Early rejection**: Use `maxPayload` at WebSocket level for pre-buffering rejection
2. **Defense in depth**: Validate at application level too
3. **Consistent limits**: Same limit across client, server, and federation
4. **Aggressive sizing**: Prefer smaller limits (64 KB vs 1 MB) for signaling
5. **Close code 1009**: Standard code for "Message Too Big"

### References

**Security Guidelines:**
- [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- [VideoSDK WebSocket Security Guide 2025](https://www.videosdk.live/developer-hub/websocket/websocket-security)
- [WebSocket.org Security Hardening Guide](https://websocket.org/guides/security/)

**ws Library (Node.js):**
- [ws Library Documentation](https://github.com/websockets/ws/blob/master/doc/ws.md)
- [ws npm Package](https://www.npmjs.com/package/ws)
- [ws Issue #513: Maximum message size limits](https://github.com/websockets/ws/issues/513)
- [ws Issue #1526: maxPayload client behavior](https://github.com/websockets/ws/issues/1526)
- [Snyk ws Vulnerability Analysis](https://snyk.io/node-js/ws)

**Industry Implementations:**
- [Discord Message Character Limits](https://support.discord.com/hc/en-us/articles/33694251638295-Discord-Account-Caps-Server-Caps-and-More)
- [Slack Message Payload Reference](https://api.slack.com/reference/messaging/payload)
- [Slack Rate Limits](https://docs.slack.dev/apis/web-api/rate-limits/)
- [Matrix Synapse Configuration](https://matrix-org.github.io/synapse/latest/usage/configuration/config_documentation.html)
- [Signal WebSocket-Resources](https://github.com/signalapp/WebSocket-Resources)
- [Telegram MTProto](https://core.telegram.org/mtproto)
- [Telegram Security Guidelines](https://core.telegram.org/mtproto/security_guidelines)

**Infrastructure:**
- [Kong WebSocket Size Limit Plugin](https://docs.konghq.com/hub/kong-inc/websocket-size-limit/)
- [NGINX WebSocket Proxy Guide](https://websocket.org/guides/infrastructure/nginx/)
- [Python websockets Memory Documentation](https://websockets.readthedocs.io/en/stable/topics/memory.html)
