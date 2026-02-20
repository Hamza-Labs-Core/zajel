# Zajel Project Guidelines

## Behavioral Rules

- **NEVER dismiss failures** — Do not say things like "this is not related to your/our code changes", "this is a pre-existing issue", or any variation that deflects responsibility for CI/test failures. Every failure on the branch is our problem to investigate and fix.
- **FIX ALL** — Never defer, skip, or leave items as "intentionally deferred". Every identified issue must be fixed. No exceptions for "ops tasks", "new features", or "cosmetic" — if it's in the plan, implement it.
- **NO informational tests** — Every test in CI must be a real gate. Never use `|| true`, `exit 0`, `set +e`, or any pattern that swallows test failures.
- **NEVER remove tests** — If a test fails, fix it. Do not delete, skip, or comment out tests to make CI pass.
- **Test-driven bug fixing** — When fixing bugs, always use the `/fix` skill.

## Skills

### /fix — Test-driven bug fixing
1. **Add tests** — Write tests that reproduce the bug
2. **Run tests** — Run them, update tests until they **fail** (proving the bug exists)
3. **Fix the issue** — Apply the minimal fix
4. **Run tests** — Run them, fix until they **pass** (proving the fix works)

Never skip steps. Never combine steps. Each step must complete before moving to the next.

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
