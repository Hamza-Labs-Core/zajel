# Zajel

**Zajel** is an end-to-end encrypted, peer-to-peer messaging application. It requires no accounts, no phone numbers, and no email addresses. Peers connect directly using pairing codes and communicate over WebRTC data channels encrypted with X25519 key exchange and ChaCha20-Poly1305 AEAD.

---

## Quick Links

| Topic | Description |
|-------|-------------|
| [Architecture Overview](Architecture-Overview) | System diagram, monorepo layout, tech stack |
| [Connection Lifecycle](Connection-Lifecycle) | Pairing flow, reconnection, connection states |
| [Security Architecture](Security-Architecture) | Encryption, key hierarchy, threat model |
| [Privacy Model](Privacy-Model) | Zero-knowledge design, data flow |
| [Channels Architecture](Channels-Architecture) | Broadcast channels with Ed25519 signing chains |
| [Groups Architecture](Groups-Architecture) | Group chat with sender key encryption |
| [VoIP Architecture](VoIP-Architecture) | Voice and video call setup |
| [Server Architecture](Server-Architecture) | Cloudflare Workers and Durable Objects |
| [Data Storage](Data-Storage) | SQLite, secure storage, data lifecycle |
| [App Attestation](App-Attestation) | Device verification and anti-tamper |
| [Build and Deploy](Build-and-Deploy) | Build targets, CI/CD, deployment |
| [Feature Reference](Feature-Reference) | Complete feature list |
| [Code Index](Code-Index) | Feature-to-code mapping for developers |

---

## Key Design Principles

1. **No identity infrastructure** -- No accounts, no phone numbers, no email. Identity is a locally generated X25519 keypair.
2. **End-to-end encrypted** -- All message content is encrypted on the sender's device and decrypted on the recipient's. The server never sees plaintext.
3. **Peer-to-peer** -- After the initial signaling handshake, peers communicate directly over WebRTC without routing through any server.
4. **Forward secrecy** -- Ephemeral session keys are generated per connection. Compromising a key does not expose past sessions.
5. **Zero-knowledge server** -- The signaling server facilitates connections but cannot read messages, identify users, or reconstruct social graphs.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile/Desktop App | Flutter (Dart) |
| Signaling Server | Cloudflare Workers + Durable Objects (JavaScript) |
| Website | React Router + Vite, deployed on Cloudflare Pages |
| P2P Transport | WebRTC data channels |
| Encryption | X25519 ECDH, ChaCha20-Poly1305, Ed25519, HKDF-SHA256 |
| Local Storage | SQLite (messages), FlutterSecureStorage (keys) |
| VoIP | WebRTC media streams |

---

## Getting Started for Developers

```bash
# Clone and install
git clone https://github.com/nicekid1/Zajel.git
cd zajel
npm ci

# Run the Flutter app
cd packages/app
flutter run

# Run the server locally
npm run dev --workspace=@zajel/server

# Run tests
cd packages/app && flutter test
npm test --workspace=@zajel/server
```

See [Build and Deploy](Build-and-Deploy) for detailed instructions.
