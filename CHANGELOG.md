# Changelog

All notable changes to Zajel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security — Comprehensive Audit (94 fixes across 3 waves)

A full security audit identified 94 issues across 4 packages (headless client, CF Worker server,
VPS server, website). All issues were resolved in 3 waves ordered by severity.

#### Wave 1 — CRITICAL + HIGH (29 issues) — commit b97ff6e

**Headless Client (`packages/headless-client/`)**
- headless-01: UNIX socket permissions restricted to 0o600 (CRITICAL)
- headless-02: File path traversal blocked via basename sanitization (CRITICAL)
- headless-03: Cryptographic PRNG for pairing codes using `secrets` module (HIGH)
- headless-04: HKDF key derivation now includes both public keys as salt (HIGH)
- headless-05: Peer identity bound to WebRTC connection during handshake (HIGH)
- headless-06: Encrypted messages use peer identity lookup instead of try-all (HIGH)
- headless-07: Session keys encrypted with ChaCha20-Poly1305 at rest (HIGH)
- headless-08: Channel invite links no longer embed private keys (HIGH)
- headless-09: 1 MB message size limits on daemon socket (HIGH)
- headless-10: Socket path symlink prevention (HIGH)
- headless-11: Group invitation requires explicit verification (MEDIUM, grouped with HIGH)

**CF Worker Server (`packages/server/`)**
- server-1: CORS origin allowlist replacing wildcard * (CRITICAL)
- server-2: Authentication required on server registration and deletion (CRITICAL)
- server-4: Rate limiting at 100 req/min/IP (HIGH)
- server-8: Nonce storage bounded with TTL expiry (HIGH)
- server-9: Device and server storage growth limits (HIGH)
- server-11: Timing-safe secret comparison (HIGH)
- server-12: JSON body size limits (HIGH)

**VPS Server (`packages/server-vps/`)**
- server-3: PeerId consistency verification (CRITICAL)
- server-6: Connection limits — 10,000 total, 50 per IP (HIGH)
- server-10: PeerId takeover prevention (HIGH)
- server-13: Rendezvous registration limits (HIGH)
- server-14: Chunk announce array limits (HIGH)

**Website (`packages/website/`)**
- website-1: DOMPurify SVG sanitization for Mermaid diagrams (HIGH)
- website-2: JSX-escaped slug parameters preventing injection (HIGH)
- website-3: Content Security Policy and security headers (HIGH)
- website-6: Mermaid securityLevel set to 'strict' (MEDIUM, grouped with HIGH)
- website-9: React useId() replacing mutable module-level counter (MEDIUM, grouped with HIGH)
- website-21: Additional security headers (MEDIUM, grouped with HIGH)

#### Wave 2 — MEDIUM (38 issues) — commit 00fc0c9

**Headless Client (`packages/headless-client/`) — 19 issues**
- headless-12: Message content redacted from logs
- headless-13: WebSocket URL scheme validation (wss:// enforced)
- headless-14: Peers held in pending state until key exchange completes
- headless-15: File transfer size limits (100 MB max)
- headless-16: Modern asyncio API (get_running_loop)
- headless-17: Bounded in-memory storage (1,000 chunks, 5,000 messages)
- headless-18: Exponential backoff reconnection
- headless-19: Nonce-based replay protection
- headless-20: Channel chunk sequence validation
- headless-21: SO_PEERCRED daemon socket authentication
- headless-22: SHA-256 file transfer hash verification
- headless-23: Group message sequence validation
- headless-24: Graceful async task cancellation with timeout
- headless-25: Strict invite link prefix validation
- headless-26: File path containment check
- headless-27: Tiered error handling — no stack trace leakage
- headless-28: Sender key zeroization on group leave
- headless-29: WebRTC cleanup on connection failure
- headless-30: JSON schema validation for group messages

**CF Worker Server (`packages/server/`) — 11 issues**
- server-15: Generic error responses — no internal message leakage
- server-16: CORS headers on all Durable Object responses
- server-17: Build token validity reduced to 30 days
- server-21: Separate signing keys for build vs session tokens
- server-22: Constant-time HMAC comparison
- server-23: hexToBytes input validation
- server-24: Single DO instance scaling documented
- server-28: Storage key injection prevention
- server-29: Server deletion requires ownership proof
- server-30: Path traversal prevention in server ID
- server-33: Generic attestation verification messages

**VPS Server (`packages/server-vps/`) — 3 issues**
- server-18: crypto.randomInt() replaces Math.random()
- server-20: PeerId format validation
- server-27: maxConnections clamped to safe range

**Website (`packages/website/`) — 5 issues**
- website-4: GitHub API response validation
- website-5: Download URL domain allowlist
- website-7: Language parameter validation
- website-8: Self-hosted fonts replacing external CDN
- website-18: Error boundary for wiki rendering

#### Wave 3 — LOW (27 issues) — commit 2e5bcc2

**Headless Client (`packages/headless-client/`) — 8 issues**
- headless-31: Event emitter surfaces exceptions instead of swallowing
- headless-32: Reliable SCTP delivery (maxRetransmits removed)
- headless-33: ICE server configuration validation
- headless-34: Event name validation for handler registration
- headless-35: Event-driven file transfer replacing busy-wait loop
- headless-36: CLI protocol buffer handling for multi-line messages
- headless-37: Signaling message field validation
- headless-38: Crypto property deprecation (public_key_base64)

**CF Worker Server (`packages/server/`) — 7 issues**
- server-34: Security headers (HSTS, X-Frame-Options, X-Content-Type-Options)
- server-35: Batch stale server deletion
- server-37: Base64url session tokens (RFC 4648)
- server-38: Strict semver validation
- server-39: Loop-based bytesToBase64 replacing spread operator (stack overflow prevention)
- server-41: Structured audit logging
- server-42: Endpoint URL validation (scheme check, private IP rejection)

**VPS Server (`packages/server-vps/`) — 1 issue**
- server-40: Stats/metrics endpoints require authentication

**Website (`packages/website/`) — 11 issues**
- website-10: rel="noopener noreferrer" on download links
- website-11: ARIA attributes on navigation
- website-12: Dynamic html lang attribute for Arabic
- website-13: OG/Twitter meta tags
- website-14: WikiSidebar focus trap and Escape key handling
- website-15: clientLoader for release data
- website-16: Robust wiki link detection
- website-17: Absolute Vite dev server path
- website-19: Smooth scrolling with reduced-motion preference
- website-20: Variable shadowing fix in MarkdownRenderer
- website-22: CSS reset extended to pseudo-elements

#### Previously Resolved (8 issues — addressed by VPS architecture)

8 issues originally targeting deleted CF Worker relay/signaling code were verified as already
addressed in the VPS implementation:
- server-5 (HIGH): `ws` library validates Upgrade header automatically
- server-7 (HIGH): `PAIRING_CODE.REGEX` validates format
- server-19 (MEDIUM): Single `JSON.parse` per message
- server-25 (MEDIUM): `maxPayload: 256KB` on WebSocketServer
- server-26 (MEDIUM): Heartbeat timeout cleanup for stale relay peers
- server-31 (MEDIUM): SQLite + LRU eviction (1,000 cap) for chunk cache
- server-32 (MEDIUM): Targeted lookup only — no pairing code broadcast
- server-36 (LOW): Dead code files removed in commit 366c85d

### Added
- Initial project setup
- P2P encrypted messaging with X25519 key exchange and ChaCha20-Poly1305 encryption
- mDNS/DNS-SD peer discovery using Bonsoir
- WebRTC-based peer-to-peer connections
- Cross-platform support (Android, iOS, macOS, Windows, Linux)
- CI/CD workflows for automated releases
