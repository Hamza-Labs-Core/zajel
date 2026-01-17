# Zajel Project Guidelines

## Licensing & IP Guidelines

### Third-Party Licensing
- **Document all third-party licenses** - A NOTICE file listing third-party licenses is maintained at `docs/technologies/COPYRIGHT.md`
- All dependencies must be MIT, BSD, Apache-2.0, or similarly permissive licenses
- **No GPL/AGPL dependencies** - These are incompatible with the project's licensing model

### Cryptographic Implementation
- **Do NOT use Signal Protocol** - Continue with current X25519 + ChaCha20-Poly1305 approach
- Signal Protocol (Double Ratchet) is AGPL-licensed and architecturally different from our session-based encryption
- Our approach: Direct ephemeral key exchange per session (simpler, sufficient for P2P use case)
- Approved algorithms: X25519, Ed25519, ChaCha20-Poly1305, SHA-256, HKDF (all public domain/royalty-free)

### WebRTC Usage
- WebRTC is covered by Google's royalty-free patent grant
- Standard data channel usage (signaling, P2P messaging, file transfer) is safe

## Build & Test Commands

```bash
# Install dependencies
npm ci

# Build all packages
npm run build --workspaces

# Run tests
npm run test --workspaces

# Web client specific
npm run dev --workspace=@zajel/web-client
npm run test:run --workspace=@zajel/web-client

# Flutter app
cd packages/app && flutter run
cd packages/app && flutter test
```

## Architecture Notes

- **Signaling**: WebSocket-based pairing code exchange
- **P2P**: WebRTC data channels for direct communication
- **Encryption**: X25519 key exchange + ChaCha20-Poly1305 AEAD
- **Federation**: SWIM gossip protocol for server discovery
