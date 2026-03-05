# Zajel DDoS Risk Analysis

**Date:** 2026-03-01
**Scope:** All server-side components (CF Workers Bootstrap, VPS Signaling Servers, Federation Layer)

---

## Executive Summary

Zajel's peer-to-peer architecture provides inherent resilience against denial-of-service attacks. Once peers establish WebRTC connections, they communicate directly — server downtime does not disrupt existing conversations, file transfers, calls, or group mesh connections. DDoS primarily threatens **new connection establishment** (pairing, rendezvous, channel chunk distribution) rather than ongoing communication.

The CF Workers bootstrap server benefits from Cloudflare's global DDoS infrastructure. The VPS signaling servers, which run as single-process Node.js applications directly exposed to the internet, represent the primary attack surface. The federated SWIM gossip architecture provides redundancy — if one VPS server is taken down, clients can fail over to other servers discovered via the bootstrap registry.

**Overall risk: MEDIUM** — The system has solid application-layer protections but lacks infrastructure-layer DDoS mitigation on VPS servers.

---

## Architecture Context

```
Clients (Flutter, Web)
    ↕ WebSocket (signaling only)
VPS Server Cluster (SWIM gossip federation, DHT hash ring)
    ↕ Signed server list, attestation
CF Workers Bootstrap (Cloudflare global network)

After pairing:
Client A ←— WebRTC P2P (direct, no server) —→ Client B
```

**Key architectural properties relevant to DDoS:**

1. **Zero-knowledge servers** — Servers never see message content. They only relay WebRTC signaling (SDP offers/answers, ICE candidates) and pairing codes.
2. **Ephemeral signaling** — Server involvement is transient. Once WebRTC is established, the server connection can be dropped without affecting the conversation.
3. **Federated redundancy** — Multiple VPS servers form a cluster via SWIM gossip. Clients can switch servers if one becomes unavailable.
4. **Rendezvous independence** — Meeting points are distributed across VPS servers via DHT. Taking down one server doesn't eliminate all rendezvous points.

---

## Attack Surface Analysis

### 1. CF Workers Bootstrap Server (Cloudflare)

**Risk: LOW**

| Asset | Protection | Notes |
|-------|-----------|-------|
| `GET /servers` | Cloudflare DDoS mitigation + 100 req/min/IP rate limit | Public endpoint, read-only |
| `POST /servers` | Auth required (`SERVER_REGISTRY_SECRET`) + rate limit | **See Finding #1 below** |
| `DELETE /servers/:id` | Auth required + ownership proof | Protected |
| `POST /servers/heartbeat` | Auth required | Protected |
| `/attest/*` endpoints | Rate limits + per-device caps (10 reg/hour, 5 nonces) | Well-bounded |

**Why LOW:**
- Cloudflare provides L3/L4/L7 DDoS protection at the edge
- The Worker runs on Cloudflare's global network with automatic scaling
- Durable Objects have built-in rate limiting and bounded storage (100K devices max)
- Application-layer rate limiting provides defense-in-depth

**Residual risk:** A sustained volumetric attack could theoretically exhaust the Cloudflare plan's limits, but this requires extraordinary resources and is covered by Cloudflare's abuse protections.

### 2. VPS Signaling Servers (Node.js)

**Risk: HIGH** (primary attack surface)

| Attack Vector | Current Protection | Gap |
|---------------|-------------------|-----|
| TCP SYN flood | None (application-layer only) | No L4 protection unless behind reverse proxy |
| WebSocket connection flood | 10K total, 50/IP limit | Attackers with many IPs bypass per-IP limits |
| Message flood (per-connection) | 100 msgs/60s per WebSocket | Adequate for single connections |
| Pairing code exhaustion | 10 pair requests/60s per WebSocket | 32^6 = ~1B codes; exhaustion unlikely |
| Oversized messages | 256KB `maxPayload` on WebSocket | Adequate |
| Slowloris / slow read | Node.js default timeouts | No explicit HTTP request timeout configured |
| CPU exhaustion via JSON parsing | 256KB message size cap | Parsing 256KB JSON is fast; low risk |
| Memory exhaustion | Bounded data structures throughout | Well-protected |
| Federation message flood | Ed25519 signature verification on all messages | Signature verification is CPU-intensive |

**Why HIGH:**
- VPS servers are directly exposed on the internet as single-process Node.js applications
- No infrastructure-level DDoS protection is assumed (no Cloudflare proxy, no AWS Shield)
- The 50-connections-per-IP limit is easily bypassed with a botnet using many source IPs
- A distributed connection flood consuming all 10K slots would prevent legitimate users from connecting
- Node.js is single-threaded — CPU-intensive operations (JSON parsing, signature verification) can block the event loop

### 3. Federation Layer (Server-to-Server)

**Risk: MEDIUM**

| Attack Vector | Current Protection | Gap |
|---------------|-------------------|-----|
| Rogue server joining federation | Ed25519 handshake + bootstrap verification | **See Finding #1** |
| Federation message amplification | Direct SWIM gossip (no amplification by design) | Adequate |
| Gossip protocol flooding | SWIM protocol has bounded message rates (1s ping interval) | Adequate |
| DHT poisoning | Consistent hashing with 150 virtual nodes, replication factor 3 | Adequate |
| Reconnect storm | Exponential backoff (1s to 30s) | **See Finding #2** |

### 4. Channel Chunk Distribution

**Risk: MEDIUM**

| Attack Vector | Current Protection | Gap |
|---------------|-------------------|-----|
| Chunk cache exhaustion | 1000 entries max with LRU eviction, 30-min TTL | Adequate |
| Announce array flood | 100 chunks per announce message | Adequate |
| Upstream queue flood | 100 messages per channel, 5-min TTL | Adequate |
| Chunk relay amplification | Multicast optimization (pull once, serve many) | Actually reduces amplification |

---

## Findings

### Finding #1: Bootstrap Auth Bypass When SECRET Not Configured (CRITICAL for DDoS)

**Source:** `docs/issues/codebase-review-2026-02-17.md` (Issue S3)

The `SERVER_REGISTRY_SECRET` in the CF Workers bootstrap server is optional. When not configured, server registration fails open — **any attacker can register rogue VPS servers** in the bootstrap registry. This has cascading DDoS implications:

- Clients discover and connect to attacker-controlled servers
- Attacker servers can harvest client metadata (IP addresses, pairing codes)
- Attacker can inject poisoned server entries that point to non-existent endpoints, causing client connection timeouts
- Legitimate VPS servers could be diluted in the server list

**Impact on DDoS resilience:** If an attacker registers many fake servers, clients would waste time connecting to them, creating an effective denial of service without attacking the VPS servers directly.

**Mitigation status:** The code supports `SERVER_REGISTRY_SECRET` — the risk depends entirely on whether it is configured in production. **Verify that `SERVER_REGISTRY_SECRET` is set in the production Cloudflare Workers environment.**

**Risk:** CRITICAL if unconfigured, LOW if configured.

### Finding #2: Federation Reconnect Configuration (Issue S4)

**Source:** `docs/issues/codebase-review-2026-02-17.md` (Issue S4)

The VPS server's federation transport is configured with `maxReconnectAttempts: 0` (infinite reconnects). While intended for resilience, combined with the codebase review finding that the reconnect guard has a logic bug (`!== 0` blocks infinite reconnects), federation servers may never reconnect after a disruption.

**Impact on DDoS resilience:** If an attacker temporarily disrupts server-to-server connections, the federation may not self-heal, permanently fragmenting the DHT and reducing rendezvous coverage.

**Risk:** HIGH — federation resilience is a key DDoS mitigation.

### Finding #3: No Infrastructure-Layer DDoS Protection on VPS

The VPS signaling servers have no documented infrastructure-layer protection:

- No reverse proxy (nginx/Caddy) configured for connection rate limiting
- No cloud provider DDoS protection (AWS Shield, Cloudflare Spectrum, etc.)
- No TCP SYN cookie protection at the application layer
- No IP reputation or geo-blocking capability

The application-layer protections (connection limits, rate limits) only apply **after** the TCP and WebSocket handshakes complete — they cannot protect against volumetric or protocol-level attacks.

**Risk:** HIGH — a moderate-scale DDoS (10K+ connections/sec) would overwhelm the server before application protections engage.

### Finding #4: Health Endpoint Information Disclosure

**Source:** `docs/issues/codebase-review-2026-02-17.md` (Issue S20)

The `/health` endpoint on VPS servers exposes:
- `serverId` (full Ed25519 public key)
- `env` (deployment environment)
- `uptime` (how long since restart — useful for timing attacks after DDoS)

This information aids reconnaissance for targeted attacks.

**Risk:** LOW — the information is useful but not sufficient alone.

### Finding #5: Single-Threaded Event Loop Vulnerability

Node.js VPS servers are single-threaded. CPU-intensive operations can block the event loop and effectively deny service to all connected clients:

- JSON parsing of 256KB messages
- Ed25519 signature verification for federation messages
- SQLite queries for rendezvous lookups
- Cleanup intervals processing large datasets

While each individual operation is fast, a sustained flood of operations that each take even 1-2ms can accumulate to block the event loop.

**Risk:** MEDIUM — mitigated by message rate limits but not eliminated.

---

## Impact Assessment by Feature

| Feature | DDoS Impact | Resilience |
|---------|-------------|------------|
| **Existing 1:1 chats** | None — P2P via WebRTC, no server needed | Excellent |
| **Existing calls** | None — P2P via WebRTC | Excellent |
| **Existing group mesh** | None — full mesh P2P connections | Excellent |
| **New pairing** | Full — requires signaling server | Poor |
| **Reconnection (rendezvous)** | Full — requires VPS server for meeting points | Medium (federated) |
| **Channel chunk distribution** | Full — requires VPS server for chunk relay | Medium (swarm seeding helps) |
| **Live streaming** | Full — requires VPS as SFU relay | Poor |
| **Bootstrap discovery** | Low — protected by Cloudflare | Excellent |
| **Attestation** | Low — protected by Cloudflare | Excellent |

---

## Existing Protections Summary

### Well-Implemented

| Protection | Location | Effectiveness |
|-----------|----------|---------------|
| Connection limits (10K total, 50/IP) | `server-vps/src/index.ts` | Good against casual attacks |
| Message rate limits (100/60s general, 10/60s pair) | `server-vps/src/client/handler.ts` | Good per-connection |
| WebSocket message size limit (256KB) | `server-vps/src/constants.ts` | Effective |
| Heartbeat-based stale client cleanup (60s timeout) | `server-vps/src/client/handler.ts` | Effective |
| Peer ID validation and takeover prevention | `server-vps/src/client/handler.ts` | Effective |
| Bounded data structures throughout | Various | Effective |
| CF Workers rate limiting (100/min/IP) | `server/src/rate-limiter.js` | Effective |
| CORS origin allowlist | `server/src/cors.js` | Effective |
| Request body size limits | `server/src/index.js` | Effective |
| Ed25519 federation authentication | `server-vps/src/federation/` | Effective |
| Attestation device caps (100K devices, 5 nonces, 10 reg/hour) | `server/src/durable-objects/attestation-registry-do.js` | Effective |

### Gaps

| Gap | Severity | Recommendation |
|-----|----------|----------------|
| No infrastructure-layer DDoS protection on VPS | HIGH | Deploy behind Cloudflare Spectrum, or nginx with rate limiting + fail2ban |
| `SERVER_REGISTRY_SECRET` may not be configured | CRITICAL | Verify and enforce in production deployment |
| Federation reconnect bug (S4) | HIGH | Fix the `!== 0` guard logic in `server-connection.ts` |
| No HTTP request timeout on VPS | MEDIUM | Add `server.requestTimeout` and `server.headersTimeout` to Node.js HTTP server |
| Health endpoint leaks server identity | LOW | Remove `serverId`, `env` from unauthenticated `/health` response |
| No IP reputation / geo-blocking | MEDIUM | Implement at reverse proxy layer |
| In-memory rate limiter on CF Workers resets on isolate eviction | LOW | Acceptable — Cloudflare provides its own protections |
| No WebSocket connection rate limit (new connections per second per IP) | MEDIUM | Add connection establishment rate limiting in `httpServer.on('upgrade')` |

---

## Recommendations

### Priority 1: Immediate (Operational)

1. **Verify `SERVER_REGISTRY_SECRET` is configured** in production CF Workers. This is the single most important action — without it, the bootstrap registry is open to poisoning.

2. **Deploy VPS servers behind a reverse proxy** (nginx or Caddy) with:
   - Connection rate limiting (e.g., 10 new connections/sec per IP)
   - TCP SYN cookie support
   - TLS termination
   - Request buffering to absorb slow clients

3. **Fix federation reconnect bug (S4)** — ensure VPS servers can recover after temporary network disruptions.

### Priority 2: Short-Term (Code Changes)

4. **Add WebSocket upgrade rate limiting** — limit new WebSocket connections per IP per second at the `httpServer.on('upgrade')` handler, before the connection is accepted.

5. **Add HTTP server timeouts** — configure `requestTimeout` and `headersTimeout` on the Node.js HTTP server to defend against slowloris attacks.

6. **Reduce health endpoint information disclosure** — remove `serverId` and `env` from the unauthenticated `/health` response, or require auth for the full response.

7. **Add connection establishment logging with IP** — ensure all connection attempts (including rejected ones) are logged with source IP for post-incident analysis.

### Priority 3: Medium-Term (Infrastructure)

8. **Consider Cloudflare Spectrum** for VPS servers to get L4 DDoS protection on WebSocket endpoints.

9. **Implement IP reputation scoring** — track IPs that repeatedly hit rate limits or connection limits, and temporarily block them at a lower level.

10. **Add cluster-aware rate limiting** — share rate limit state across VPS servers in the federation so an attacker can't bypass limits by distributing connections across servers.

### Priority 4: Architecture (Long-Term)

11. **Client-side server failover** — ensure clients automatically try alternative VPS servers when the current one becomes unresponsive, using the signed bootstrap server list.

12. **Proof-of-work for pairing** — require clients to solve a lightweight computational puzzle before accepting pairing code registration, raising the cost of connection-based attacks.

---

## Threat Scenarios

### Scenario 1: Distributed Connection Flood on VPS

**Attack:** Botnet opens 10K+ WebSocket connections from many IPs, exhausting the `MAX_TOTAL_CONNECTIONS` limit.

**Current impact:** All 10K connection slots consumed. Legitimate users cannot connect. Existing P2P conversations continue unaffected.

**Mitigations in place:** 50-connection-per-IP limit (ineffective against distributed attacks), heartbeat timeout cleanup (60s).

**Residual risk:** HIGH — once at capacity, new connections are rejected until attackers disconnect or heartbeat timeout triggers cleanup.

**Recovery time:** 60 seconds (heartbeat timeout) if attackers stop sending heartbeats; indefinite if they maintain connections.

### Scenario 2: Bootstrap Registry Poisoning

**Attack:** Register hundreds of fake VPS servers in the bootstrap registry (only possible if `SERVER_REGISTRY_SECRET` is not set).

**Current impact:** Clients discover and attempt to connect to fake servers, experiencing timeouts and delays. Effective denial of service without attacking real infrastructure.

**Mitigations in place:** Server heartbeat requirement (5-min TTL) means fake entries expire if not maintained. Bootstrap response signing prevents response tampering in transit.

**Residual risk:** CRITICAL if secret is not configured; NEGLIGIBLE if configured.

### Scenario 3: Channel Chunk Distribution Disruption

**Attack:** Flood chunk announce/request messages for popular channels to exhaust VPS cache and relay capacity.

**Current impact:** Cache fills with attacker chunks (LRU eviction), legitimate chunks are evicted. Channel subscribers experience missed content.

**Mitigations in place:** 1000-entry cache limit with LRU, 100-chunk announce limit, 5-minute upstream TTL.

**Residual risk:** MEDIUM — the swarm model means subscribers who already have chunks can seed to others, reducing dependence on VPS cache.

### Scenario 4: Federation Partition

**Attack:** Disrupt server-to-server connections to fragment the federation, preventing distributed rendezvous from functioning.

**Current impact:** DHT ring fragmentes. Meeting points on isolated servers become unreachable. Clients must fall back to their directly-connected server's local rendezvous only.

**Mitigations in place:** SWIM failure detection (5s timeout), reconnection with backoff.

**Residual risk:** HIGH — especially given the reconnect bug (Finding #2).

---

## Comparison with Similar Systems

| Property | Zajel | Signal | Matrix |
|----------|-------|--------|--------|
| Server role | Signaling relay only | Full message routing | Full message routing + federation |
| DDoS impact on existing chats | None (P2P) | Full (server-dependent) | Full (server-dependent) |
| Server redundancy | Federated VPS cluster | Centralized | Federated homeservers |
| Infrastructure DDoS protection | Cloudflare (bootstrap only) | Cloudflare + custom | Varies by homeserver |
| Rate limiting | Per-connection + per-IP | Per-account | Per-homeserver |

Zajel's P2P architecture provides a natural advantage: the server is only needed for initial connection setup. Once peers are connected, the system is inherently DDoS-resilient. The primary risk is disrupting the ability to establish **new** connections.
