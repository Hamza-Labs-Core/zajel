# Zajel

Private peer-to-peer encrypted communication platform.

**Zajel** (Arabic for "carrier pigeon") enables secure, private messaging between devices with:

- End-to-end encryption (X25519 + ChaCha20-Poly1305)
- Peer connections via signaling servers with pairing codes and QR scanning
- Federated VPS relay servers with SWIM gossip protocol discovery
- Rendezvous-based peer discovery (meeting points, dead drops, live matching)
- Channels (broadcast, polls, live streaming, RTMP ingest)
- Groups (mesh P2P, sender key encryption, vector clock sync)
- Voice and video calls (WebRTC, call controls, incoming call handling)
- Encrypted file transfer (chunked, per-chunk encryption)
- App attestation and binary verification
- Cross-platform: Android, iOS, Windows, Linux, macOS, Web

## Packages

This is a monorepo containing:

| Package | Path | Description |
|---------|------|-------------|
| **app** | [`packages/app`](packages/app) | Flutter mobile and desktop app (Android, iOS, Windows, Linux, macOS) |
| **server** | [`packages/server`](packages/server) | Cloudflare Worker signaling server with Durable Objects (bootstrap registry, relay registry, rendezvous, attestation, chunk distribution) |
| **server-vps** | [`packages/server-vps`](packages/server-vps) | Node.js VPS signaling server with SQLite, federation (SWIM gossip, DHT), WebSocket relay, and chunk caching |
| **web-client** | [`packages/web-client`](packages/web-client) | React web client linked to mobile app via WebRTC tunnel proxy |
| **website** | [`packages/website`](packages/website) | React marketing website and user guide, built with Vite and React Router, deployed to Cloudflare Pages |
| **admin-cf** | [`packages/admin-cf`](packages/admin-cf) | Cloudflare Workers admin dashboard (Preact) for monitoring and management |
| **headless-client** | [`packages/headless-client`](packages/headless-client) | Python headless test client for the Zajel P2P messaging protocol (used in E2E tests) |
| **integration-tests** | [`packages/integration-tests`](packages/integration-tests) | Cross-package integration tests (VPS server, web client, Flutter app scenarios) |
| **wiki** | [`packages/wiki`](packages/wiki) | GitHub Wiki content sync tooling |

End-to-end tests live in the top-level [`e2e-tests/`](e2e-tests) directory with platform helpers for Android, Linux, Windows, and iOS (Appium, AT-SPI, pywinauto).

## Architecture

```
                          +-----------------------+
                          | Cloudflare Worker      |
                          | (Bootstrap Registry)   |
                          | - Server list (signed) |
                          | - Attestation registry |
                          +----------+------------+
                                     |
                          server list + attestation
                                     |
              +----------------------+----------------------+
              |                                             |
     +--------v---------+                        +----------v--------+
     | VPS Server A     |  <-- SWIM gossip -->   | VPS Server B      |
     | - Signaling (WS) |                        | - Signaling (WS)  |
     | - Relay registry |                        | - Relay registry  |
     | - Rendezvous     |                        | - Rendezvous      |
     | - Chunk cache    |                        | - Chunk cache     |
     | - Federation/DHT |                        | - Federation/DHT  |
     +--------+---------+                        +----------+--------+
              |                                             |
       WebSocket + WebRTC signaling                  WebSocket + WebRTC
              |                                             |
     +--------v---------+                        +----------v--------+
     | Flutter App       |  <-- WebRTC P2P -->   | Flutter App        |
     | (or Web Client)   |     (data channels)   | (or Web Client)    |
     +-------------------+                        +-------------------+

Channel Chunk Distribution:
     Owner --> encrypt + sign chunks --> push to VPS cache
     VPS cache --> fan-out to subscribers (swarm seeding)
     Subscribers <--> announce/pull chunks <--> VPS relay

Group Mesh:
     Member A <-- WebRTC --> Member B
     Member A <-- WebRTC --> Member C
     Member B <-- WebRTC --> Member C
     (Full N*(N-1)/2 mesh with sender key encryption)
```

### Directory Structure

```
zajel/
├── packages/
│   ├── app/                       # Flutter application
│   │   ├── lib/
│   │   │   ├── core/              # Crypto, network, storage, media, notifications
│   │   │   ├── features/          # Chat, channels, groups, calls, contacts,
│   │   │   │                        settings, onboarding, help, attestation
│   │   │   └── shared/            # Widgets, theme, routing
│   │   └── [platforms]/           # android, ios, windows, linux, macos, web
│   │
│   ├── server/                    # Cloudflare Worker
│   │   ├── src/                   # Worker, Durable Objects (signaling, relay,
│   │   │                            rendezvous, server registry, attestation,
│   │   │                            chunk index)
│   │   └── wrangler.toml          # Cloudflare config with domain routes
│   │
│   ├── server-vps/                # VPS signaling server (Node.js + SQLite)
│   │   ├── src/
│   │   │   ├── federation/        # SWIM gossip, DHT, bootstrap client
│   │   │   ├── storage/           # SQLite with migrations
│   │   │   └── ...                # Signaling, relay, rendezvous, chunk relay
│   │   └── tests/                 # Unit and integration tests
│   │
│   ├── web-client/                # React web client (Vite)
│   │   ├── src/                   # React components, crypto, VoIP, signaling
│   │   └── tests/                 # Vitest unit tests, Playwright E2E
│   │
│   ├── website/                   # React marketing site (Vite + React Router)
│   │   ├── app/                   # React components (landing, guide, downloads)
│   │   └── public/                # Static assets
│   │
│   ├── admin-cf/                  # Admin dashboard (Cloudflare Workers + Preact)
│   ├── headless-client/           # Python headless test client
│   ├── integration-tests/         # Cross-package integration test scenarios
│   └── wiki/                      # GitHub Wiki content
│
├── e2e-tests/                     # End-to-end tests (pytest + Appium/AT-SPI)
│   ├── platforms/                 # android, linux, windows, ios helpers
│   └── tests/                     # Smoke, pairing, messaging, channels, groups
│
├── docs/                          # Documentation
│   ├── features/                  # Feature inventory and detail files
│   ├── plans/                     # Implementation plans (01-09)
│   ├── voip/                      # VoIP protocol and architecture docs
│   ├── issues/                    # Issue investigation docs
│   ├── testing/                   # CI limitations and test docs
│   └── technologies/              # Copyright and license tracking
│
└── shared/                        # Shared branding assets
```

## Quick Start

### Flutter App

```bash
cd packages/app
flutter pub get
flutter run -d linux  # or -d windows, -d macos, -d chrome, -d android, -d ios
flutter test
```

### Cloudflare Worker Signaling Server

```bash
cd packages/server
npm install
npm run dev      # local development
npm run deploy   # deploy to Cloudflare
```

### VPS Signaling Server

```bash
cd packages/server-vps
npm install
npm run migrate  # initialize SQLite database
npm run dev      # local development (single node)
npm run dev:cluster  # local multi-node federation cluster
npm run build && npm start  # production
npm test         # run tests
```

### Web Client

```bash
cd packages/web-client
npm install
npm run dev      # local development
npm run build    # production build
npm run test:run # run tests
```

### Website

```bash
cd packages/website
npm install
npm run dev      # local development (React Router dev server)
npm run build    # production build
npm run preview  # preview via Cloudflare Pages locally
npm run deploy   # deploy to Cloudflare Pages
```

### Admin Dashboard

```bash
cd packages/admin-cf
npm install
npm run dev:dashboard  # local Preact dashboard
npm run dev            # local Cloudflare Worker
npm run deploy         # deploy to Cloudflare
```

### Headless Client (Python)

```bash
cd packages/headless-client
pip install -e ".[dev]"
pytest tests/
```

### E2E Tests

```bash
cd e2e-tests
pip install -r requirements.txt
pytest tests/
```

### Integration Tests

```bash
cd packages/integration-tests
npm install
npm test
```

## Security

- **End-to-End Encryption**: All 1:1 messages encrypted with ChaCha20-Poly1305 AEAD
- **Key Exchange**: X25519 elliptic curve Diffie-Hellman with ephemeral session keys
- **Forward Secrecy**: Session keys derived via HKDF; new keys per session
- **Zero-Knowledge Server**: Signaling servers route WebRTC setup only, never see message content
- **Channel Encryption**: Ed25519 signing (ownership and admin) + X25519 + ChaCha20-Poly1305 (content encryption) with epoch-based key rotation
- **Group Encryption**: Sender key distribution with ChaCha20-Poly1305 AEAD per member
- **Fingerprint Verification**: SHA-256 fingerprints of X25519 public keys for out-of-band MITM detection
- **App Attestation**: Build token registration, dynamic binary attestation (HMAC-SHA256 challenge-response), server identity verification, anti-tamper checks (debugger, root/jailbreak, emulator detection)
- **Version Management**: Minimum/recommended/blocked version enforcement with force-update and update-prompt dialogs
- **Certificate Pinning**: Platform-specific certificate pinning for Android and iOS

## How It Works

### Connection Lifecycle

1. **Bootstrap**: The app fetches a signed list of VPS servers from the Cloudflare Worker bootstrap registry. Ed25519 signature verification ensures the list is authentic.

2. **Server Selection**: The app selects a VPS server based on region preference and freshness, connecting via WebSocket.

3. **Pairing**: Users share a 6-character pairing code (generated via cryptographic rejection sampling) or scan a QR code (zajel:// URI scheme). Both peers connect to the signaling server and exchange WebRTC SDP offers/answers.

4. **WebRTC P2P**: A direct peer-to-peer connection is established via WebRTC data channels (ordered, 3 max retransmits). All subsequent communication bypasses the server.

5. **Cryptographic Handshake**: Peers exchange X25519 public keys over the WebRTC data channel and derive a shared session key via HKDF.

6. **Encrypted Messaging**: Messages are encrypted with ChaCha20-Poly1305 using the session key.

### Rendezvous (Reconnection Without Pairing Codes)

When trusted peers need to reconnect (e.g., after app restart):

- **Meeting Points**: Deterministic daily meeting point hashes are derived from both peers' public keys (3-day window). Peers register these with VPS servers.
- **Live Matching**: If both peers are online, the VPS server notifies them of the match and they establish a new WebRTC connection.
- **Dead Drops**: If one peer is offline, the online peer leaves an encrypted dead drop (connection info) at the meeting point. When the offline peer comes online and checks the meeting point, they decrypt the dead drop and connect.
- **Federated Redirects**: Meeting points may resolve to different VPS servers in the federation; the client follows redirects transparently.

### Relay Introduction

When direct WebRTC connections fail (strict NAT, firewalls):

- Peers register as relays with capacity info on VPS servers.
- A peer needing a relay sends an introduction request through the VPS.
- The VPS forwards the introduction to an available relay peer.
- The relay peer facilitates the connection between the two peers.

### Channels (Broadcast)

Channels are one-to-many broadcast streams with Ed25519 signing and X25519 encryption:

- **Owner** creates a channel with signing and encryption keypairs, generating a signed manifest.
- **Content** is split into 64KB chunks, encrypted with the channel key, and signed by the author.
- **Distribution** uses a swarm model: chunks are pushed to VPS cache, subscribers pull from cache or from other subscribers who announce as chunk sources.
- **Subscribers** perform 5-step verification: signature check, authorization check, manifest check, trusted owner check, decryptability check.
- **Upstream** messaging allows subscribers to send replies, votes, and reactions to the owner via ephemeral encryption.
- **Admins** can be delegated signing authority. Removing an admin triggers encryption key rotation.
- **Live Streaming** supports real-time frame relay through VPS (SFU mode) with RTMP ingest for external streaming tools.
- **Censorship Resistance** uses rotating routing hashes (HMAC with epoch period) and blocking pattern detection with fallback to alternative VPS servers.

### Groups (Mesh P2P)

Groups use full mesh WebRTC connections with sender key encryption:

- **Creation**: Creator generates a group ID and sender key, becoming the first member.
- **Invitations**: Sent over existing 1:1 P2P channels, carrying group metadata and sender keys.
- **Mesh Connections**: Each member connects to every other member via WebRTC (N*(N-1)/2 connections).
- **Encryption**: Each member has a sender key (ChaCha20-Poly1305). Messages are encrypted with the sender's key and broadcast to all members.
- **Sync**: Vector clocks track per-device message sequences. Members detect and request missing messages via clock comparison.
- **Key Rotation**: Triggered on member removal for forward secrecy.

### Voice and Video Calls (VoIP)

- WebRTC peer connections with STUN/TURN for NAT traversal.
- Call signaling (offer, answer, reject, hangup, ICE candidates) via the signaling server.
- Media controls: mute, video toggle, camera switch, audio processing (noise suppression, echo cancellation, auto gain), background blur.
- Incoming call dialog with accept (audio or video) and decline options.
- Call duration tracking, 60-second ringing timeout, 10-second reconnection timeout.

## Deployment

### App Releases

Releases are built automatically via GitHub Actions on tag push:
- Android APK/AAB
- iOS IPA
- Windows MSIX/ZIP
- macOS DMG
- Linux tarball

### Cloudflare Worker (Signaling + Bootstrap)

```bash
cd packages/server
npm run deploy
```

### VPS Server

```bash
cd packages/server-vps
npm run build
npm start
```

The VPS server uses SWIM gossip protocol for federation -- multiple VPS nodes discover each other and form a DHT hash ring for distributed relay and rendezvous services.

### Website (Cloudflare Pages)

```bash
cd packages/website
npm run build
npm run deploy
```

### Admin Dashboard (Cloudflare Workers)

```bash
cd packages/admin-cf
npm run deploy
```

## Documentation

- **[Feature Inventory](docs/features/FEATURES.md)** -- Comprehensive list of all features by package
- **[VoIP Architecture](docs/voip/)** -- Protocol, server, web, and Flutter VoIP documentation
- **[Implementation Plans](docs/plans/)** -- Historical plans (01-09) for server relay, rendezvous, channels, groups, attestation, and more
- **[CI Limitations](docs/testing/CI_LIMITATIONS.md)** -- Known CI/testing constraints
- **[Copyright and Licenses](docs/technologies/COPYRIGHT.md)** -- Third-party license tracking
- **[Privacy Policy](packages/app/PRIVACY.md)** -- Data handling policy
- **[Audit Report](docs/AUDIT_REPORT.md)** -- Documentation audit and gap analysis

## Links

- **Website**: [zajel.app](https://zajel.app)
- **Company**: [hamzalabs.dev](https://hamzalabs.dev)
- **Issues**: [GitHub Issues](https://github.com/Hamza-Labs-Core/zajel/issues)

## License

MIT
