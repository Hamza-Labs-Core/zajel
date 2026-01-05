# Zajel

Private peer-to-peer encrypted communication app.

**Zajel** (Arabic for "carrier pigeon") enables secure, private messaging between devices with:

- End-to-end encryption (X25519 + ChaCha20-Poly1305)
- Local network auto-discovery (mDNS/DNS-SD)
- External peer connections via signaling server
- File transfer support
- Cross-platform: Android, iOS, Windows, Linux, macOS

## Architecture

```
zajel/
├── lib/
│   ├── core/
│   │   ├── crypto/          # X25519 key exchange, ChaCha20 encryption
│   │   ├── network/         # WebRTC, mDNS discovery, signaling
│   │   ├── protocol/        # Wire protocol for messages
│   │   ├── models/          # Peer, Message data models
│   │   └── providers/       # Riverpod state management
│   ├── features/
│   │   ├── home/            # Peer discovery list
│   │   ├── chat/            # Messaging UI
│   │   ├── connection/      # QR code pairing
│   │   └── settings/        # App configuration
│   └── shared/
│       └── theme/           # App theming
└── server/                  # Node.js signaling server
```

## Security

- **End-to-End Encryption**: All messages encrypted with ChaCha20-Poly1305
- **Key Exchange**: X25519 elliptic curve Diffie-Hellman
- **Forward Secrecy**: Session keys derived via HKDF
- **Maximum Privacy Mode**: Ephemeral keys, minimal metadata
- **Zero-Knowledge Server**: Signaling server only routes WebRTC setup, never sees content

## Documentation

- **[User Guide](docs/USER_GUIDE.md)** - How to use Zajel, troubleshooting, FAQ
- **[Architecture](#architecture)** - Technical overview

## Getting Started

### Prerequisites

- Flutter 3.x
- Node.js 18+ (for signaling server)

### Run the App

```bash
# Install dependencies
flutter pub get

# Run on Linux desktop
flutter run -d linux

# Run on web
flutter run -d chrome
```

### Run Signaling Server

```bash
cd server
npm install
npm start
```

The signaling server runs on port 8080 by default.

## Local Network Mode

Devices on the same network automatically discover each other via mDNS. No internet required.

## External Mode

For connections across networks:
1. Both peers connect to the signaling server
2. Share pairing codes (6-character alphanumeric)
3. QR code scanning for easy pairing
4. WebRTC establishes direct connection

## License

MIT
