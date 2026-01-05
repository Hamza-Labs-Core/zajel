# Zajel

Private peer-to-peer encrypted communication app.

**Zajel** (Arabic for "carrier pigeon") enables secure, private messaging between devices with:

- End-to-end encryption (X25519 + ChaCha20-Poly1305)
- Local network auto-discovery (mDNS/DNS-SD)
- External peer connections via signaling server
- File transfer support
- Cross-platform: Android, iOS, Windows, Linux, macOS

## Packages

This is a monorepo containing:

| Package | Description |
|---------|-------------|
| [`packages/app`](packages/app) | Flutter mobile & desktop app |
| [`packages/server`](packages/server) | Cloudflare Worker signaling server |
| [`packages/website`](packages/website) | Marketing website & user guide |

## Quick Start

### Run the App

```bash
cd packages/app
flutter pub get
flutter run -d linux  # or -d windows, -d macos, -d chrome
```

### Run Signaling Server (Local Development)

```bash
cd packages/server
npm install
npm run dev
```

### Preview Website

```bash
# Open packages/website/index.html in your browser
# Or use a local server:
npx serve packages/website
```

## Architecture

```
zajel/
├── packages/
│   ├── app/                    # Flutter application
│   │   ├── lib/
│   │   │   ├── core/           # Crypto, network, providers
│   │   │   ├── features/       # Home, chat, settings screens
│   │   │   └── shared/         # Widgets, theme
│   │   └── [platforms]/        # android, ios, windows, linux, macos, web
│   │
│   ├── server/                 # Cloudflare Worker
│   │   ├── src/                # Worker + Durable Objects
│   │   └── wrangler.toml       # Cloudflare config
│   │
│   └── website/                # Static marketing site
│       ├── index.html          # Landing page
│       └── guide.html          # User guide
│
├── docs/                       # Documentation
└── shared/                     # Shared branding assets
```

## Security

- **End-to-End Encryption**: All messages encrypted with ChaCha20-Poly1305
- **Key Exchange**: X25519 elliptic curve Diffie-Hellman
- **Forward Secrecy**: Session keys derived via HKDF
- **Zero-Knowledge Server**: Signaling server only routes WebRTC setup, never sees content

## How It Works

### Local Network Mode

Devices on the same network automatically discover each other via mDNS. No internet required.

### External Mode

For connections across networks:
1. Both peers connect to the signaling server
2. Share pairing codes (6-character alphanumeric)
3. QR code scanning for easy pairing
4. WebRTC establishes direct P2P connection

## Deployment

### App Releases

Releases are built automatically via GitHub Actions on tag push:
- Android APK/AAB
- iOS IPA
- Windows MSIX/ZIP
- macOS DMG
- Linux tarball

### Server (Cloudflare Workers)

```bash
cd packages/server
npm run deploy
```

### Website (Cloudflare Pages)

Automatically deployed on push to main via GitHub Actions.

## Documentation

- **[User Guide](packages/website/guide.html)** - How to use Zajel
- **[Privacy Policy](packages/app/PRIVACY.md)** - Data handling
- **[Deployment Guide](packages/app/DEPLOYMENT.md)** - Store submission

## Links

- **Website**: [zajel.app](https://zajel.app) (coming soon)
- **Company**: [hamzalabs.dev](https://hamzalabs.dev)
- **Issues**: [GitHub Issues](https://github.com/Hamza-Labs-Core/zajel/issues)

## License

MIT
