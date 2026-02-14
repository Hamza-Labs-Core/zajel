# Parallel Execution Plan — 102 Security Issues

## Strategy

The three packages (headless, server, website) have **zero file overlap**, so all 3 can always run in parallel. Within each package, issues are grouped by shared files to avoid merge conflicts, then ordered by severity (CRITICAL → HIGH → MEDIUM → LOW).

**5 parallel agents** are used: 2 for headless (most file contention), 2 for server (most file contention), 1 for website.

---

## Wave 1 — CRITICAL + HIGH (27 issues, 5 agents)

All CRITICAL issues plus HIGH issues, grouped to avoid file conflicts.

### Agent 1: Headless — client.py + crypto.py + channels.py group
**Files**: `client.py`, `crypto.py`, `channels.py`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | headless-05 | HIGH | Handshake key exchange peer identity confusion |
| 2 | headless-06 | HIGH | Encrypted message tries all peers (depends on 05) |
| 3 | headless-08 | HIGH | Channel invite link embeds private key |
| 4 | headless-04 | HIGH | HKDF key derivation uses empty salt |
| 5 | headless-11 | MEDIUM | Group invitation auto-accepted without verification |

### Agent 2: Headless — daemon.py + protocol.py + file_transfer.py + signaling.py group
**Files**: `daemon.py`, `protocol.py`, `file_transfer.py`, `signaling.py`, `peer_storage.py`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | headless-01 | CRITICAL | UNIX socket no permission restrictions |
| 2 | headless-10 | HIGH | Socket path unsanitized, symlink attacks |
| 3 | headless-09 | HIGH | No size limits on daemon socket messages |
| 4 | headless-02 | CRITICAL | File path traversal in received file names |
| 5 | headless-03 | HIGH | Weak pairing code non-cryptographic PRNG |
| 6 | headless-07 | HIGH | SQLite stores session keys in plaintext |

### Agent 3: Server — attestation-registry-do.js + index.js + cors.js group
**Files**: `attestation-registry-do.js`, `index.js`, `cors.js`, `rate-limiter.js`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-1 | CRITICAL | Wildcard CORS allows any origin |
| 2 | server-4 | HIGH | No rate limiting on any endpoint |
| 3 | server-8 | HIGH | Unbounded nonce storage growth |
| 4 | server-9 | HIGH | Unbounded device/server storage growth |
| 5 | server-11 | HIGH | Timing-based secret comparison |
| 6 | server-12 | HIGH | No input size limits on HTTP bodies |

### Agent 4: Server — websocket-handler.js + relay-registry-do.js + signaling-room.js group
**Files**: `websocket-handler.js`, `relay-registry-do.js`, `signaling-room.js`, `server-registry-do.js`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-2 | CRITICAL | No auth on server registration/deletion |
| 2 | server-3 | CRITICAL | WebSocket peer identity self-asserted |
| 3 | server-5 | HIGH | SignalingRoom no Upgrade header check |
| 4 | server-6 | HIGH | No WebSocket connection limit per DO |
| 5 | server-7 | HIGH | Pairing code no format validation |
| 6 | server-10 | HIGH | PeerId takeover via re-registration |
| 7 | server-13 | HIGH | Unbounded rendezvous registration |
| 8 | server-14 | HIGH | Unbounded chunk announce arrays |

### Agent 5: Website — all HIGH issues
**Files**: `MermaidDiagram.tsx`, `wiki.tsx`, `_headers`, `root.tsx`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | website-1 | HIGH | XSS via Mermaid SVG innerHTML injection |
| 2 | website-6 | MEDIUM | Mermaid securityLevel not set (same file as 1) |
| 3 | website-9 | MEDIUM | Module-level mutable state in Mermaid (same file) |
| 4 | website-2 | HIGH | Slug parameter injection in wiki errors |
| 5 | website-3 | HIGH | No Content Security Policy headers |
| 6 | website-21 | MEDIUM | Missing security headers (same _headers file as 3) |

---

## Wave 2 — MEDIUM severity (46 issues, 5 agents)

### Agent 1: Headless — client.py + groups.py (MEDIUM batch)
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

### Agent 3: Server — attestation + server-registry (MEDIUM batch)
**Files**: `attestation-registry-do.js`, `server-registry-do.js`, `index.js`, `attestation.js`, `signing.js`
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

### Agent 4: Server — websocket + relay + chunk (MEDIUM batch)
**Files**: `websocket-handler.js`, `relay-registry-do.js`, `relay-registry.js`, `chunk-index.js`, `signaling-room.js`, `rendezvous-registry.js`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-18 | MEDIUM | Math.random() for security operations |
| 2 | server-19 | MEDIUM | Double JSON parsing of WebSocket messages |
| 3 | server-20 | MEDIUM | PeerId not validated for format/length |
| 4 | server-25 | MEDIUM | No WebSocket message size limit |
| 5 | server-26 | MEDIUM | Stale relay peers never cleaned |
| 6 | server-27 | MEDIUM | maxConnections not validated |
| 7 | server-31 | MEDIUM | Chunk cache unbounded memory |
| 8 | server-32 | MEDIUM | SignalingRoom broadcasts all pairing codes |

### Agent 5: Website — MEDIUM + remaining
**Files**: `home.tsx`, `wiki.tsx`, `MarkdownRenderer.tsx`, `WikiSidebar.tsx`, `global.css`, `vite.config.ts`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | website-4 | MEDIUM | GitHub API response not validated |
| 2 | website-5 | MEDIUM | Download URLs not domain-validated |
| 3 | website-7 | MEDIUM | Arbitrary lang parameter accepted |
| 4 | website-8 | MEDIUM | Google Fonts loaded without SRI |
| 5 | website-18 | MEDIUM | No error boundary for wiki rendering |

---

## Wave 3 — LOW severity (29 issues, 5 agents)

### Agent 1: Headless — LOW batch A
**Files**: `hooks.py`, `webrtc.py`, `client.py`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | headless-31 | LOW | Event emitter silently swallows exceptions |
| 2 | headless-32 | LOW | WebRTC maxRetransmits=3 may lose messages |
| 3 | headless-33 | LOW | No ICE server configuration validation |
| 4 | headless-34 | LOW | No event name validation for handler registration |
| 5 | headless-38 | LOW | Private key accessible via public crypto property |

### Agent 2: Headless — LOW batch B
**Files**: `file_transfer.py`, `protocol.py`, `signaling.py`, `crypto.py`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | headless-35 | LOW | File transfer busy-wait loop |
| 2 | headless-36 | LOW | CLI protocol discards data after first newline |
| 3 | headless-37 | LOW | Signaling server messages not validated |

### Agent 3: Server — LOW batch A
**Files**: `attestation-registry-do.js`, `server-registry-do.js`, `index.js`
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-34 | LOW | Missing security headers |
| 2 | server-35 | LOW | Sequential await in stale server cleanup |
| 3 | server-41 | LOW | No audit logging |
| 4 | server-42 | LOW | Endpoint URL not validated |

### Agent 4: Server — LOW batch B
**Files**: `attestation.js`, `signing.js`, `relay-registry-do.js`, dead code files
| Order | Issue | Severity | Summary |
|-------|-------|----------|---------|
| 1 | server-36 | LOW | Dead code files still present |
| 2 | server-37 | LOW | Session token uses base64 not base64url |
| 3 | server-38 | LOW | compareVersions doesn't handle non-semver |
| 4 | server-39 | LOW | Spread operator on signatures risks stack overflow |
| 5 | server-40 | LOW | Stats endpoint unauthenticated |

### Agent 5: Website — LOW batch
**Files**: `home.tsx`, `Nav.tsx`, `root.tsx`, `wiki.tsx`, `MarkdownRenderer.tsx`, `WikiSidebar.tsx`, `global.css`, `vite.config.ts`, `guide.tsx`
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
| 1 | 27 | 5 | All CRITICAL + HIGH (security-critical) |
| 2 | 46 | 5 | All MEDIUM (hardening + robustness) |
| 3 | 29 | 5 | All LOW (quality + polish) |
| **Total** | **102** | **3 waves × 5 agents** | |

### Rules
1. **Never skip waves** — complete Wave 1 fully before starting Wave 2
2. **Commit after each wave** — create a checkpoint commit after each wave completes
3. **Run tests between waves** — `npm run test --workspaces` and `cd packages/app && flutter test`
4. **Within a wave, agents run fully in parallel** — file grouping ensures no conflicts
5. **Each agent reads its plan files**, applies the fixes, and runs relevant tests
