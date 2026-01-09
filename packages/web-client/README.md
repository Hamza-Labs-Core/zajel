# Zajel Web Client

A standalone web client for Zajel with end-to-end encryption. Connect with peers using simple pairing codes and exchange messages and files securely through peer-to-peer WebRTC connections.

## Prerequisites

- Node.js 18 or higher
- A running Zajel signaling server (VPS)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create environment file:

```bash
cp .env.example .env
```

3. Configure the environment:

Edit `.env` and set `VITE_SIGNALING_URL` to your VPS server WebSocket URL:

```env
VITE_SIGNALING_URL=wss://your-signaling-server.com
```

## Development

Start the development server:

```bash
npm run dev
```

## Production

Build and run the production server:

```bash
npm run build
npm start
```

The server will start on port 3847 by default.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_SIGNALING_URL` | Yes | - | WebSocket URL of your signaling server |
| `PORT` | No | `3847` | Port for the static file server |

## Security Notes

### Key Storage

By default, identity keys are stored in `sessionStorage` and are cleared when the browser tab closes. This provides better security than persistent storage since an XSS vulnerability has a smaller window to exfiltrate keys.

### Key Fingerprints

The client generates key fingerprints (SHA-256 hash of public keys) that can be compared out-of-band to verify peer identity and prevent man-in-the-middle (MITM) attacks. Users should verify fingerprints through a trusted channel (phone call, in person, etc.) when security is critical.

### Encryption

All messages and files are encrypted end-to-end using:

- **X25519** - Elliptic curve Diffie-Hellman key exchange
- **HKDF-SHA256** - Key derivation function for session keys
- **ChaCha20-Poly1305** - Authenticated encryption for messages

The signaling server only facilitates initial connection and cannot decrypt any communication between peers.

## Architecture

The web client is organized into three main layers:

### Crypto Layer (`src/lib/crypto.ts`)

Handles all cryptographic operations:
- Key pair generation and storage (X25519)
- Session key establishment via ECDH
- Message encryption/decryption (ChaCha20-Poly1305)
- Key fingerprint generation for verification

### Signaling Layer (`src/lib/signaling.ts`)

Manages WebSocket communication with the signaling server:
- Connection and reconnection handling
- Pairing code generation and exchange
- WebRTC signaling (offer/answer/ICE candidates)
- Keepalive ping/pong

### WebRTC Layer (`src/lib/webrtc.ts`)

Handles peer-to-peer connections:
- RTCPeerConnection management
- Data channel setup for messages and files
- ICE candidate handling
- Connection state management
