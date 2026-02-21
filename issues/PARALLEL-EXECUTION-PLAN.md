# Parallel Execution Plan — 94 Active Security Issues

## Strategy

The project has **four** packages with security issues, but **zero file overlap** between them:
- `packages/headless-client/` (Python) — 38 issues
- `packages/server/` (Cloudflare Workers — bootstrap/attestation) — 25 issues
- `packages/server-vps/` (Node.js VPS — signaling/relay/channels/chunks) — 9 issues
- `packages/website/` (React) — 22 issues

**Architecture note**: The server tier is split across two packages:
- **CF Worker** (`packages/server/`): Only does VPS server registry (`ServerRegistryDO`) and binary attestation (`AttestationRegistryDO`)
- **VPS** (`packages/server-vps/`): Handles ALL client-facing functionality — signaling, relay, rendezvous, channels, chunks, calls, federation

Issues are grouped by shared files to avoid merge conflicts, then ordered by severity (CRITICAL → HIGH → MEDIUM → LOW).

**5 parallel agents**: 2 for headless, 1 for CF Worker server, 1 for VPS server, 1 for website.

### Resolved Issues (removed from plan)

8 issues originally targeting deleted CF Worker relay/signaling code were verified as already addressed in the VPS implementation:

| Issue | Severity | Original Problem | VPS Status |
|-------|----------|------------------|------------|
| server-5 | HIGH | No Upgrade header check | `ws` library validates automatically |
| server-7 | HIGH | No pairing code validation | `PAIRING_CODE.REGEX` validates format |
| server-19 | MEDIUM | Double JSON parsing | Single `JSON.parse` per message |
| server-25 | MEDIUM | No message size limit | `maxPayload: 256KB` on WebSocketServer |
| server-26 | MEDIUM | Stale relay peers | Heartbeat timeout cleanup |
| server-31 | MEDIUM | Unbounded chunk cache | SQLite + LRU eviction (1000 cap) |
| server-32 | MEDIUM | Broadcasts pairing codes | Targeted lookup only |
| server-36 | LOW | Dead code files present | Removed in commit 366c85d |

---

## Wave 1 — CRITICAL + HIGH (29 issues, 5 agents)

All CRITICAL issues plus HIGH issues, grouped to avoid file conflicts.

### Agent 1: Headless — client.py + crypto.py + channels.py group
**Package**: `packages/headless-client/zajel/`
**Files**: `client.py`, `crypto.py`, `channels.py`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | headless-05 | HIGH | Handshake key exchange peer identity confusion |
| 2 | headless-06 | HIGH | Encrypted message tries all peers (depends on 05) |
| 3 | headless-08 | HIGH | Channel invite link embeds private key |
| 4 | headless-04 | HIGH | HKDF key derivation uses empty salt |
| 5 | headless-11 | MEDIUM | Group invitation auto-accepted without verification |

### Agent 2: Headless — daemon.py + protocol.py + file_transfer.py + signaling.py group
**Package**: `packages/headless-client/zajel/`
**Files**: `daemon.py`, `protocol.py`, `file_transfer.py`, `signaling.py`, `peer_storage.py`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | headless-01 | CRITICAL | UNIX socket no permission restrictions |
| 2 | headless-10 | HIGH | Socket path unsanitized, symlink attacks |
| 3 | headless-09 | HIGH | No size limits on daemon socket messages |
| 4 | headless-02 | CRITICAL | File path traversal in received file names |
| 5 | headless-03 | HIGH | Weak pairing code non-cryptographic PRNG |
| 6 | headless-07 | HIGH | SQLite stores session keys in plaintext |

### Agent 3: CF Worker Server — index.js + attestation-registry-do.js + server-registry-do.js
**Package**: `packages/server/src/`
**Files**: `index.js`, `durable-objects/attestation-registry-do.js`, `durable-objects/server-registry-do.js`, `crypto/signing.js`, `crypto/attestation.js`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-1 | CRITICAL | Wildcard CORS allows any origin |
| 2 | server-2 | CRITICAL | No auth on server registration/deletion |
| 3 | server-4 | HIGH | No rate limiting on any endpoint |
| 4 | server-8 | HIGH | Unbounded nonce storage growth |
| 5 | server-9 | HIGH | Unbounded device/server storage growth |
| 6 | server-11 | HIGH | Timing-based secret comparison |
| 7 | server-12 | HIGH | No input size limits on HTTP bodies |

### Agent 4: VPS Server — handler.ts + index.ts + registries
**Package**: `packages/server-vps/src/`
**Files**: `client/handler.ts`, `index.ts`, `registry/relay-registry.ts`, `registry/rendezvous-registry.ts`, `registry/distributed-rendezvous.ts`, `client/chunk-relay.ts`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-3 | CRITICAL | WebSocket peer identity self-asserted |
| 2 | server-6 | HIGH | No WebSocket connection limit |
| 3 | server-10 | HIGH | PeerId takeover via re-registration |
| 4 | server-13 | HIGH | Unbounded rendezvous registration |
| 5 | server-14 | HIGH | Unbounded chunk announce arrays |

### Agent 5: Website — all HIGH issues
**Package**: `packages/website/app/`
**Files**: `components/wiki/MermaidDiagram.tsx`, `routes/wiki.tsx`, `public/_headers`, `root.tsx`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | website-1 | HIGH | XSS via Mermaid SVG innerHTML injection |
| 2 | website-6 | MEDIUM | Mermaid securityLevel not set (same file as 1) |
| 3 | website-9 | MEDIUM | Module-level mutable state in Mermaid (same file) |
| 4 | website-2 | HIGH | Slug parameter injection in wiki errors |
| 5 | website-3 | HIGH | No Content Security Policy headers |
| 6 | website-21 | MEDIUM | Missing security headers (same _headers file as 3) |

---

## Wave 2 — MEDIUM severity (38 issues, 5 agents)

### Agent 1: Headless — client.py + groups.py (MEDIUM batch)
**Package**: `packages/headless-client/zajel/`
**Files**: `client.py`, `groups.py`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | headless-12 | MEDIUM | Plaintext message content logged at INFO |
| 2 | headless-14 | MEDIUM | Race condition: peer added before key exchange |
| 3 | headless-16 | MEDIUM | Deprecated asyncio.get_event_loop() usage |
| 4 | headless-20 | MEDIUM | Channel chunk sequence not validated |
| 5 | headless-23 | MEDIUM | Group message sequence numbers not validated |
| 6 | headless-24 | MEDIUM | Async tasks not awaited on cancellation |
| 7 | headless-29 | MEDIUM | WebRTC connection not cleaned up on failure |
| 8 | headless-30 | MEDIUM | JSON deserialization without schema validation |

### Agent 2: Headless — daemon.py + file_transfer.py + signaling.py + channels.py (MEDIUM batch)
**Package**: `packages/headless-client/zajel/`
**Files**: `daemon.py`, `file_transfer.py`, `signaling.py`, `channels.py`, `protocol.py`, `hooks.py`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | headless-13 | MEDIUM | WebSocket connection no TLS verification option |
| 2 | headless-15 | MEDIUM | No file size validation on incoming transfers |
| 3 | headless-17 | MEDIUM | Unbounded in-memory storage for channels/groups |
| 4 | headless-18 | MEDIUM | No WebSocket reconnection logic |
| 5 | headless-19 | MEDIUM | No replay protection for encrypted P2P messages |
| 6 | headless-21 | MEDIUM | No authentication on daemon socket commands |
| 7 | headless-22 | MEDIUM | File transfer no hash verification |
| 8 | headless-25 | MEDIUM | Channel invite link decoding accepts arbitrary prefixes |
| 9 | headless-26 | MEDIUM | send_file passes arbitrary file paths |
| 10 | headless-27 | MEDIUM | Exception details leaked in error responses |
| 11 | headless-28 | MEDIUM | Sender keys never zeroized on group leave |

### Agent 3: CF Worker Server — attestation + server-registry (MEDIUM batch)
**Package**: `packages/server/src/`
**Files**: `durable-objects/attestation-registry-do.js`, `durable-objects/server-registry-do.js`, `index.js`, `crypto/attestation.js`, `crypto/signing.js`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-15 | MEDIUM | Error responses leak internal messages |
| 2 | server-16 | MEDIUM | CORS headers missing from DO responses |
| 3 | server-17 | MEDIUM | Build token 1-year validity window |
| 4 | server-21 | MEDIUM | Same key for build tokens and session tokens |
| 5 | server-22 | MEDIUM | HMAC non-constant-time comparison |
| 6 | server-23 | MEDIUM | hexToBytes no input validation |
| 7 | server-24 | MEDIUM | Single global DO instance |
| 8 | server-28 | MEDIUM | Storage key injection via unsanitized IDs |
| 9 | server-29 | MEDIUM | Unauthenticated server deletion |
| 10 | server-30 | MEDIUM | Path traversal in server ID extraction |
| 11 | server-33 | MEDIUM | Attestation verify leaks error details |

### Agent 4: VPS Server — handler.ts + relay-registry.ts (MEDIUM batch)
**Package**: `packages/server-vps/src/`
**Files**: `client/handler.ts`, `registry/relay-registry.ts`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-18 | MEDIUM | Math.random() for security operations |
| 2 | server-20 | MEDIUM | PeerId not validated for format/length |
| 3 | server-27 | MEDIUM | maxConnections not validated |

### Agent 5: Website — MEDIUM + remaining
**Package**: `packages/website/app/`
**Files**: `routes/home.tsx`, `routes/wiki.tsx`, `components/wiki/MarkdownRenderer.tsx`, `components/wiki/WikiSidebar.tsx`, `styles/global.css`, `vite.config.ts`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | website-4 | MEDIUM | GitHub API response not validated |
| 2 | website-5 | MEDIUM | Download URLs not domain-validated |
| 3 | website-7 | MEDIUM | Arbitrary lang parameter accepted |
| 4 | website-8 | MEDIUM | Google Fonts loaded without SRI |
| 5 | website-18 | MEDIUM | No error boundary for wiki rendering |

---

## Wave 3 — LOW severity (27 issues, 5 agents)

### Agent 1: Headless — LOW batch A
**Package**: `packages/headless-client/zajel/`
**Files**: `hooks.py`, `webrtc.py`, `client.py`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | headless-31 | LOW | Event emitter silently swallows exceptions |
| 2 | headless-32 | LOW | WebRTC maxRetransmits=3 may lose messages |
| 3 | headless-33 | LOW | No ICE server configuration validation |
| 4 | headless-34 | LOW | No event name validation for handler registration |
| 5 | headless-38 | LOW | Private key accessible via public crypto property |

### Agent 2: Headless — LOW batch B
**Package**: `packages/headless-client/zajel/`
**Files**: `file_transfer.py`, `protocol.py`, `signaling.py`, `crypto.py`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | headless-35 | LOW | File transfer busy-wait loop |
| 2 | headless-36 | LOW | CLI protocol discards data after first newline |
| 3 | headless-37 | LOW | Signaling server messages not validated |

### Agent 3: CF Worker Server — LOW batch
**Package**: `packages/server/src/`
**Files**: `index.js`, `durable-objects/attestation-registry-do.js`, `durable-objects/server-registry-do.js`, `crypto/signing.js`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-34 | LOW | Missing security headers |
| 2 | server-35 | LOW | Sequential await in stale server cleanup |
| 3 | server-37 | LOW | Session token uses base64 not base64url |
| 4 | server-38 | LOW | compareVersions doesn't handle non-semver |
| 5 | server-39 | LOW | Spread operator on signatures risks stack overflow |
| 6 | server-41 | LOW | No audit logging |
| 7 | server-42 | LOW | Endpoint URL not validated |

### Agent 4: VPS Server — LOW batch
**Package**: `packages/server-vps/src/`
**Files**: `index.ts`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-40 | LOW | Stats endpoint unauthenticated |

### Agent 5: Website — LOW batch
**Package**: `packages/website/app/`
**Files**: `routes/home.tsx`, `components/Nav.tsx`, `root.tsx`, `routes/wiki.tsx`, `components/wiki/MarkdownRenderer.tsx`, `components/wiki/WikiSidebar.tsx`, `styles/global.css`, `vite.config.ts`, `routes/guide.tsx`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | website-10 | LOW | Missing rel attributes on download links |
| 2 | website-11 | LOW | Missing ARIA attributes on Nav |
| 3 | website-12 | LOW | HTML lang hardcoded to "en" |
| 4 | website-13 | LOW | Missing OG/Twitter meta tags |
| 5 | website-14 | LOW | WikiSidebar missing focus trap/Escape |
| 6 | website-15 | LOW | Client-side-only release data fetching |
| 7 | website-16 | LOW | isWikiLink heuristic misclassifies links |
| 8 | website-17 | LOW | Vite dev server fs.allow uses relative path |
| 9 | website-19 | LOW | No smooth scrolling for anchor navigation |
| 10 | website-20 | LOW | Variable shadowing in MarkdownRenderer |
| 11 | website-22 | LOW | CSS universal reset impacts performance |

---

## Execution Summary

| Wave | Issues | Agents | Description |
|------|--------|--------|-------------|
| 1 | 29 | 5 | All CRITICAL + HIGH (security-critical) |
| 2 | 38 | 5 | All MEDIUM (hardening + robustness) |
| 3 | 27 | 5 | All LOW (quality + polish) |
| **Total** | **94** | **3 waves x 5 agents** | |

### Issue Distribution by Package

| Package | Wave 1 | Wave 2 | Wave 3 | Total |
|---------|--------|--------|--------|-------|
| Headless (`packages/headless-client/`) | 11 | 19 | 8 | 38 |
| CF Worker (`packages/server/`) | 7 | 11 | 7 | 25 |
| VPS (`packages/server-vps/`) | 5 | 3 | 1 | 9 |
| Website (`packages/website/`) | 6 | 5 | 11 | 22 |
| **Total** | **29** | **38** | **27** | **94** |

### Rules
1. **Never skip waves** — complete Wave 1 fully before starting Wave 2
2. **Commit after each wave** — create a checkpoint commit after each wave completes
3. **Run tests between waves** — `npm run test --workspaces` and `cd packages/app && flutter test`
4. **Within a wave, agents run fully in parallel** — file grouping ensures no conflicts
5. **Each agent reads its plan files**, applies the fixes, and runs relevant tests
6. **CF Worker and VPS never conflict** — different packages, safe to always parallelize
