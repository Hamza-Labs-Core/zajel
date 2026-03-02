# Build and Deploy

This page covers building, testing, and deploying all Zajel packages.

---

## Prerequisites

| Tool | Minimum Version | Purpose |
|------|----------------|---------|
| Node.js | 20.0.0 | Server, website, web client, integration tests |
| Flutter | 3.x | Mobile and desktop app |
| Dart | (bundled with Flutter) | App development |
| npm | (bundled with Node.js) | Package management |
| Wrangler | Latest | Cloudflare Workers deployment |

---

## Monorepo Setup

```bash
# Clone the repository
git clone https://github.com/nicekid1/Zajel.git
cd zajel

# Install all npm dependencies (workspaces)
npm ci

# Build all npm packages
npm run build --workspaces
```

The monorepo uses npm workspaces. All packages under `packages/` are linked automatically.

---

## Flutter App (`packages/app`)

### Development

```bash
cd packages/app

# Run on connected device or emulator
flutter run

# Run on specific platform
flutter run -d chrome          # Web (development only)
flutter run -d linux           # Linux desktop
flutter run -d windows         # Windows desktop
flutter run -d macos           # macOS desktop
flutter run -d <device-id>     # Specific device
```

### Testing

```bash
cd packages/app

# Run all unit tests
flutter test

# Run a specific test file
flutter test test/path/to/test_file.dart

# Run with coverage
flutter test --coverage
```

### Release Builds

```bash
cd packages/app

# Android APK
flutter build apk --release

# Android App Bundle (for Play Store)
flutter build appbundle --release

# iOS (requires macOS + Xcode)
flutter build ios --release

# Linux
flutter build linux --release

# Windows
flutter build windows --release

# macOS
flutter build macos --release
```

### Environment Configuration

Build-time environment variables are passed via `--dart-define`:

```bash
flutter run \
  --dart-define=BOOTSTRAP_URL=https://signal.zajel.hamzalabs.dev \
  --dart-define=SIGNALING_URL=wss://signal.zajel.hamzalabs.dev \
  --dart-define=BUILD_TOKEN=<signed-token> \
  --dart-define=E2E_TEST_MODE=false
```

| Variable | Description |
|----------|-------------|
| `BOOTSTRAP_URL` | URL for fetching the server list |
| `SIGNALING_URL` | WebSocket URL for signaling server |
| `BUILD_TOKEN` | Signed build token for attestation |
| `E2E_TEST_MODE` | Enable auto-pairing behavior for E2E tests |

---

## Signaling Server (`packages/server`)

### Development

```bash
# Run locally with Wrangler
cd packages/server
npx wrangler dev
```

### Testing

```bash
cd packages/server
npm test
```

Tests cover:
- WebSocket handler message routing
- Relay registry (registration, load tracking, selection)
- Rendezvous registry (daily points, hourly tokens, dead drops, expiration)
- Chunk index (announcement, source tracking, caching, pending requests)
- WebSocket chunk handlers (announce, request, push, multicast)

### Deployment

```bash
cd packages/server

# Deploy to production
npx wrangler deploy

# Deploy to QA environment
npx wrangler deploy --env qa
```

### Configuration (`wrangler.jsonc`)

```jsonc
{
  "name": "zajel-signaling",
  "main": "src/index.js",
  "compatibility_date": "2024-01-01",
  "durable_objects": {
    "bindings": [
      { "name": "SIGNALING_ROOM", "class_name": "SignalingRoom" },
      { "name": "RELAY_REGISTRY", "class_name": "RelayRegistryDO" },
      { "name": "SERVER_REGISTRY", "class_name": "ServerRegistryDO" },
      { "name": "ATTESTATION_REGISTRY", "class_name": "AttestationRegistryDO" }
    ]
  }
}
```

### Environments

| Environment | Domain | Config |
|-------------|--------|--------|
| Production | `signal.zajel.hamzalabs.dev` | Default bindings |
| QA | `signal-qa.zajel.hamzalabs.dev` | Separate Durable Object namespaces |

---

## VPS Relay Server (`packages/server-vps`)

### Build

```bash
npm run build --workspace=@zajel/server-vps
```

### Development

```bash
npm run dev --workspace=@zajel/server-vps
```

The VPS relay server provides WebSocket relay connectivity for peers that cannot establish direct P2P connections. It registers with the bootstrap server and sends periodic heartbeats.

---

## Website (`packages/website`)

### Development

```bash
cd packages/website

# Start dev server
npm run dev
```

### Build

```bash
cd packages/website

# Production build
npm run build
```

### Deployment

The website is deployed to Cloudflare Pages:

```bash
cd packages/website

# Deploy to production
npx wrangler pages deploy build/client --project-name=zajel-website

# Deploy to QA
npx wrangler pages deploy build/client --project-name=zajel-website --branch=qa
```

### Stack

- React Router v7 (SPA mode)
- Vite (build tool)
- CSS custom properties (dark theme with Indigo/Emerald palette)
- Cloudflare Pages (static hosting)

---

## Web Client (`packages/web-client`)

### Build

```bash
npm run build --workspace=@zajel/web-client
```

### Development

```bash
npm run dev --workspace=@zajel/web-client
```

The web client links to a mobile app and operates through the mobile device as a proxy.

---

## Integration Tests (`packages/integration-tests`)

```bash
# Run all integration tests
npm run test:integration

# Run specific suites
npm run test:integration:web-to-web
npm run test:integration:pairing
```

---

## E2E Tests

End-to-end tests use the headless client (`packages/headless-client`) built in Python:

```bash
cd e2e-tests

# Install dependencies
pip install -r requirements.txt

# Run E2E tests
pytest
```

---

## CI/CD Overview

The CI pipeline performs:

1. **Lint**: Dart format check, lint rules
2. **Unit tests**: Flutter app tests, server tests
3. **Integration tests**: Web-to-web, pairing flows
4. **E2E tests**: Full app flow with headless client
5. **Build**: Release builds for all platforms
6. **Attestation**: Upload reference binaries for attestation verification
7. **Deploy**: Server to Cloudflare Workers, website to Cloudflare Pages

### Key CI Principles

- Every test is a real gate (no `|| true`, no `exit 0`)
- Tests are never removed to make CI pass; failures are fixed
- All failures on the branch are investigated and resolved
