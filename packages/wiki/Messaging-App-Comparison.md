# Messaging App Comparison

This page compares Zajel against seven prominent secure messaging applications: Signal, WhatsApp, Telegram, Matrix/Element, Session, Briar, and SimpleX. The goal is to provide an honest, factual assessment of where Zajel fits in the secure messaging landscape, what it does differently, and where competitors have the edge.

All information reflects the state of each project as of early 2026. Where Zajel features are planned but not yet shipped, this is explicitly noted.

---

## Architecture Comparison

| Property | Zajel | Signal | WhatsApp | Telegram | Matrix/Element | Session | Briar | SimpleX |
|----------|-------|--------|----------|----------|----------------|---------|-------|---------|
| **Server model** | Federated VPS relay + CF Worker bootstrap | Centralized | Centralized (Meta) | Centralized (multi-DC) | Federated (homeservers) | Decentralized (service nodes) | Pure P2P (no servers) | Relay servers (no user data) |
| **Encryption protocol** | X25519 + ChaCha20-Poly1305 + HKDF | Signal Protocol (Double Ratchet + X3DH) | Signal Protocol | MTProto 2.0 (custom) | Olm/Megolm (Double Ratchet variant) | Session Protocol V2 (libsodium-based) | Bramble (custom, audited) | Double Ratchet + NaCl |
| **Key exchange** | X25519 ECDH (dual ephemeral + identity) | X3DH (triple DH with prekeys) | X3DH (via Signal Protocol) | DH-2048 / ECDH (MTProto) | Curve25519 (Olm) | X25519 + CRYSTALS-Kyber (V2) | Curve25519 | X25519 + X3DH |
| **Federation** | SWIM gossip + DHT hash ring | None (centralized) | None (centralized) | None (centralized) | Yes (Matrix federation protocol) | Decentralized node network | None (direct P2P) | None (independent relays) |
| **P2P support** | Yes (WebRTC data channels, primary transport) | No (server-relayed) | No (server-relayed) | No (server-relayed) | No (server-relayed) | No (routed via service nodes) | Yes (Bluetooth, Wi-Fi, Tor) | No (relay-based) |
| **Account/identity model** | No account; local X25519 keypair | Phone number required | Phone number required | Phone number required | Username@homeserver | No phone/email; random Session ID | No phone/email; local key | No identifiers at all |
| **Metadata exposure** | Minimal (timing, IP at signaling; meeting points are opaque hashes) | Low (phone number, timestamps, IP) | High (contacts, timing, IP, device info, usage patterns shared with Meta) | High (cloud chats: contacts, IPs, phone number, group membership) | Moderate (federation exposes room membership, server sees metadata) | Very low (onion routing hides IP; no phone/email) | Very low (Tor hides IP; no phone/email; local-only data) | Very low (pairwise queue IDs; no user identifiers; relay sees only queue addresses) |
| **Open source (client)** | Yes (MIT) | Yes (GPLv3) | No | Partially (client only) | Yes (Apache 2.0) | Yes (GPLv3) | Yes (GPLv3) | Yes (AGPLv3) |
| **Open source (server)** | Yes (MIT) | Yes (AGPLv3) | No | No | Yes (Apache 2.0) | Yes (GPLv3) | N/A (no server) | Yes (AGPLv3) |
| **Self-hostable** | Yes (VPS relay servers) | Technically possible but unsupported | No | No | Yes (homeservers) | Run your own service node | N/A (no server) | Yes (relay servers) |

---

## Encryption Comparison

| Property | Zajel | Signal | WhatsApp | Telegram | Matrix/Element | Session | Briar | SimpleX |
|----------|-------|--------|----------|----------|----------------|---------|-------|---------|
| **E2E by default** | Yes (all messages) | Yes (all messages) | Yes (all messages) | No (only Secret Chats; cloud chats use server-client encryption) | Yes (cross-signed devices; default since 2024 in Element) | Yes (all messages) | Yes (all messages) | Yes (all messages) |
| **Forward secrecy** | Yes (ephemeral key exchange per session + in-session key ratcheting) | Yes (Double Ratchet provides per-message forward secrecy) | Yes (via Signal Protocol) | Yes (in Secret Chats; limited in cloud chats) | Yes (Olm sessions for 1:1; Megolm for groups with periodic rotation) | Yes (Protocol V2 restores PFS via rotating per-device keys) | Yes (Bramble transport protocol) | Yes (Double Ratchet) |
| **Post-compromise security** | Partial (key ratcheting heals over time; identity key regeneration resets state) | Yes (Double Ratchet restores security after compromise) | Yes (via Signal Protocol) | No (Secret Chats lack post-compromise recovery) | Yes (new Olm sessions restore security) | Yes (Protocol V2 adds post-compromise recovery) | Yes | Yes (Double Ratchet) |
| **Post-quantum resistance** | No | In progress (PQXDH with CRYSTALS-Kyber announced) | No | No | No | In progress (Protocol V2 adds lattice-based PQE) | No | Yes (quantum-resistant key exchange shipped) |
| **Group encryption** | Sender keys (ChaCha20-Poly1305); O(1) encrypt/decrypt | Sender keys (since 2020) | Sender keys | No E2E for groups (server-side encryption only) | Megolm (shared ratchet per room) | Sender keys via closed groups | Per-contact 1:1 channels for group relay | Per-member Double Ratchet |
| **Key verification** | SHA-256 fingerprints (out-of-band comparison) | Safety numbers (QR + numeric code) | Security code (QR + 60-digit code) | Key visualization (Secret Chats only) | Cross-signing + emoji verification (SAS) | No built-in verification mechanism | QR code + visual key comparison | Out-of-band verification via SimpleX links |

---

## Privacy Comparison

| Property | Zajel | Signal | WhatsApp | Telegram | Matrix/Element | Session | Briar | SimpleX |
|----------|-------|--------|----------|----------|----------------|---------|-------|---------|
| **Phone number required** | No | Yes (hidden from contacts since 2024) | Yes | Yes | No (username@server) | No | No | No |
| **Server sees message content** | No | No | No (but Meta AI interactions may not be E2E encrypted) | Yes (cloud chats); No (Secret Chats) | No (when E2E enabled) | No | No server | No |
| **Server stores messages** | No (ephemeral state only; all server data has short TTLs) | Messages queued until delivered, then deleted | Messages queued until delivered; metadata retained indefinitely | Cloud chats stored permanently on Telegram servers | Homeserver stores encrypted messages indefinitely | Messages stored on service nodes for up to 14 days | No server; messages stored locally only | Relay holds messages until delivered, then deletes |
| **IP address exposure** | Server sees IP at signaling time; WebRTC exposes peer IPs | Server sees IP; peers do not see each other's IP | Server sees IP; peers do not see each other's IP | Server sees IP | Homeserver sees IP | Onion routing hides IP from service nodes | Tor hides IP (when internet available); local network for mesh | Relay sees IP; peers do not see each other's IP |
| **Contact discovery** | None (pairing codes only; no contact upload) | Phone number hashing (SGX secure enclave for private contact discovery) | Phone contacts uploaded to Meta servers | Phone contacts uploaded to Telegram servers | None (manual invite) | None (share Session ID out-of-band) | None (manual QR exchange) | None (share SimpleX link out-of-band) |
| **Data shared with third parties** | None | None | Metadata shared with Meta companies | Metadata available to Telegram; may be disclosed to authorities per policy | Depends on homeserver operator | None | None | None |

---

## Feature Comparison

| Feature | Zajel | Signal | WhatsApp | Telegram | Matrix/Element | Session | Briar | SimpleX |
|---------|-------|--------|----------|----------|----------------|---------|-------|---------|
| **1:1 messaging** | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| **Group chat** | Yes (mesh P2P with sender keys) | Yes (up to 1,000 members) | Yes (up to 1,024 members) | Yes (up to 200,000 members) | Yes (unlimited, federated rooms) | Yes (up to 100 members) | Yes (private groups, forums) | Yes (secret groups) |
| **Channels/broadcast** | Yes (Ed25519-signed, encrypted, with polls and live streaming) | No (broadcast lists only) | Yes (broadcast lists, channels) | Yes (channels with unlimited subscribers) | No (rooms serve this purpose) | No | Yes (blogs feature) | No |
| **Voice calls** | Yes (WebRTC P2P) | Yes (E2E encrypted) | Yes (E2E encrypted) | Yes (E2E encrypted) | Yes (via WebRTC, E2E encrypted) | Beta | No | Yes (E2E encrypted, WebRTC) |
| **Video calls** | Yes (WebRTC P2P) | Yes (E2E encrypted, group video up to 75) | Yes (E2E encrypted, group video up to 32) | Yes (group video up to 30) | Yes (via WebRTC, E2E encrypted) | Beta | No | Yes (E2E encrypted, WebRTC) |
| **File transfer** | Yes (chunked, SHA-256 verified, 100 MB limit) | Yes | Yes (up to 2 GB) | Yes (up to 4 GB) | Yes | Yes | No (images only on Android) | Yes |
| **Disappearing messages** | Yes (auto-delete with configurable durations) | Yes (configurable timer) | Yes (configurable timer) | Yes (self-destruct timer in Secret Chats; global auto-delete) | No (available via third-party bridges) | Yes (configurable timer) | No | Yes (configurable timer) |
| **Desktop apps** | Yes (Windows, macOS, Linux) | Yes (Windows, macOS, Linux) | Yes (Windows, macOS; web app) | Yes (Windows, macOS, Linux) | Yes (Windows, macOS, Linux) | Yes (Windows, macOS, Linux) | Limited (Linux stable; macOS/Windows experimental) | Yes (Windows, macOS, Linux) |
| **Web client** | Yes (linked via mobile) | No (desktop app only) | Yes (WhatsApp Web) | Yes (Telegram Web) | Yes (Element Web) | No | No | No |
| **Mobile platforms** | Android, iOS | Android, iOS | Android, iOS | Android, iOS | Android, iOS | Android, iOS | Android only | Android, iOS |
| **Auto-update (desktop)** | Yes (Go binary with rollback, SHA-256 verification) | Yes | Yes (via app stores) | Yes | Yes (via Flatpak/package managers) | Yes | N/A | Yes |
| **Offline messaging** | Dead drops at meeting points (48-hour TTL) | Queued on server until delivery | Queued on server until delivery | Stored in cloud indefinitely | Stored on homeserver until synced | Stored on service nodes for up to 14 days | Bluetooth/Wi-Fi mesh sync | Queued on relay until delivery |
| **Stories/status** | No | Yes (Signal Stories) | Yes (WhatsApp Status) | Yes (Telegram Stories) | No | No | No | No |
| **Payments** | No | No (removed) | Yes (WhatsApp Pay in select countries) | Yes (Telegram Stars, TON integration) | No | SESSION token (network staking) | No | No |

---

## Where Zajel Differs

Zajel occupies a specific niche in the secure messaging landscape. Its key differentiators are:

### No Account, No Phone Number, No Email

Like Session, Briar, and SimpleX, Zajel requires no personal information to use. Identity is a locally generated X25519 keypair. Unlike Signal, WhatsApp, and Telegram, there is no phone number requirement and no central user registry. There is nothing to look up, nothing to subpoena, and nothing to correlate across services.

### P2P-First Architecture

Zajel is one of only two apps in this comparison (alongside Briar) that routes message content directly between peers without passing through any server. After the initial WebRTC signaling handshake, all communication is direct peer-to-peer over encrypted data channels. The server is only involved in connection setup and never touches message content, not even in encrypted form.

### Federated VPS Relay Network

Unlike purely centralized services (Signal, WhatsApp, Telegram) or purely decentralized ones (Session, Briar), Zajel uses a hybrid model. A lightweight Cloudflare Worker handles bootstrap and attestation, while self-hostable VPS relay servers form a federated cluster using the SWIM gossip protocol and a DHT hash ring. Anyone can run a VPS relay node and join the federation.

### Ephemeral Server State

The signaling server stores no persistent user data. All server-side state (pairing codes, meeting points, dead drops, chunk caches) is ephemeral with short TTLs (3 hours to 48 hours). There is no user database, no message archive, and no social graph to compromise.

### Rendezvous-Based Reconnection

Instead of relying on a central server to store contact lists and route reconnections (as Signal, WhatsApp, and Telegram do), Zajel uses a cryptographic rendezvous system. Trusted peers derive deterministic meeting point hashes from their public keys and re-discover each other without revealing their relationship to the server.

### Rich Channel System

Zajel's channels go beyond simple broadcast lists. They include Ed25519-signed manifests, 5-step subscriber verification, encrypted content distribution via swarm seeding, admin delegation with key rotation, upstream messaging (replies, polls, reactions), and live streaming with RTMP ingest. This is closer to a decentralized publishing platform than a typical broadcast feature.

### Comprehensive Security Audit

Zajel has undergone a 94-issue security audit across all four packages (app, CF Worker, VPS server, headless client), with all issues resolved across three severity waves. The security hardening includes constant-time comparisons, sender key zeroization, session key encryption at rest, bounded storage with TTL eviction, and per-client rate limiting.

---

## Honest Assessment: What Competitors Do Better

No comparison is complete without acknowledging where Zajel falls short relative to mature, well-funded competitors.

### Maturity and User Base

Signal has approximately 40-70 million users. WhatsApp has over 2 billion. Telegram has over 900 million. Zajel is a new project with a small user base. Network effects matter enormously for messaging apps, and Zajel cannot yet match the reach of any established competitor.

### Cryptographic Protocol Maturity

Signal's Double Ratchet protocol has been formally analyzed in peer-reviewed academic papers, adopted by WhatsApp and Matrix, and battle-tested at scale for over a decade. Zajel's session-based X25519 + ChaCha20-Poly1305 scheme is cryptographically sound but has not undergone the same level of independent formal analysis. Signal also provides stronger per-message forward secrecy through continuous ratcheting, whereas Zajel ratchets periodically (every 100 messages or 30 minutes).

### Post-Quantum Cryptography

Signal is actively deploying PQXDH with CRYSTALS-Kyber. Session Protocol V2 adds lattice-based post-quantum key exchange. SimpleX has already shipped quantum-resistant encryption. Zajel has no post-quantum protections currently, leaving it potentially vulnerable to harvest-now-decrypt-later attacks.

### Large Group Support

Telegram supports groups of up to 200,000 members. WhatsApp supports 1,024. Signal supports 1,000. Matrix rooms can be effectively unlimited. Zajel's full-mesh group model (N*(N-1)/2 connections) does not scale to large groups. This is a fundamental architectural constraint.

### Offline Message Delivery

WhatsApp, Telegram, and Signal reliably deliver messages to offline recipients by queuing them on servers. Zajel's dead drop system (48-hour TTL at meeting points) provides offline delivery for trusted peers, but it is less reliable than centralized message queuing, especially for long offline periods.

### Rich Media and Social Features

WhatsApp and Telegram offer stories, payments, stickers, animated emoji, location sharing, and extensive media editing tools. Signal has stories and sophisticated media features. Zajel focuses on core messaging, calling, channels, and file transfer. It does not offer stories, payments, location sharing, or media editing.

### iOS Feature Parity

Briar has no iOS support at all. While Zajel targets iOS, the Flutter cross-platform approach may not match the native-level polish and system integration (push notifications, background execution, CallKit) that Signal and WhatsApp achieve with dedicated native iOS development.

### Metadata Protection

Session and Briar provide stronger metadata protection than Zajel. Session uses three-hop onion routing (similar to Tor) to hide IP addresses from service nodes. Briar routes traffic through Tor when internet is available. Zajel's signaling server sees IP addresses at connection time, and WebRTC connections expose peer IP addresses to each other. Zajel does not incorporate onion routing or Tor integration.

---

## Summary

Zajel is best suited for users who want:
- Encrypted messaging with no account or phone number
- Direct peer-to-peer communication without server intermediaries
- Self-hostable, federated infrastructure
- Rich channel/broadcast capabilities
- A single app across all major platforms (Android, iOS, Windows, macOS, Linux, Web)

It is less suited for users who need:
- A massive existing contact base
- Proven-at-scale, formally verified encryption protocols
- Post-quantum cryptographic protection (today)
- Very large groups (hundreds or thousands of members)
- Advanced social features (stories, payments, location sharing)
- Tor/onion-routing-level metadata protection
