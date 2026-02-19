# [HIGH] No rate limiting on any endpoint enables denial of service

**Area**: Server
**File**: packages/server/src/index.js (all endpoints)
**Type**: Security

**Description**: There is no rate limiting on any HTTP endpoint or WebSocket message handler. The server accepts unlimited requests from any source. This applies to:
- HTTP endpoints: `/servers`, `/attest/*`, `/health`
- WebSocket messages: `register`, `chunk_announce`, `chunk_request`, `register_rendezvous`, etc.

**Impact**:
- An attacker can flood the server with registration requests, filling Durable Object storage.
- An attacker can spam WebSocket messages at high volume, consuming CPU and memory in the Durable Object.
- Repeated attestation challenge requests create nonce entries in storage that persist for 5 minutes each, enabling storage exhaustion.
- Chunk announce/request spam can fill the in-memory chunk index and cache.
- Cloudflare Workers billing is usage-based, so an attack directly increases costs.

**Fix**:
1. Implement per-IP rate limiting using Cloudflare's built-in rate limiting rules or a custom solution with a counter in Durable Object storage.
2. For WebSocket connections, track message count per connection and close connections that exceed a threshold (e.g., 100 messages/second).
3. Consider using Cloudflare's `cf.botManagement` or `cf.threat_score` to block suspicious traffic.
4. Add a maximum number of entries per storage prefix (e.g., max 10,000 devices, max 1,000 servers).
