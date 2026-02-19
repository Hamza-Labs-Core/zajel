# Plan 06: App Attestation & Content Safety

## Overview

Two complementary security layers to protect the Zajel infrastructure from abuse:

1. **App Attestation**: Ensure only official, unmodified Zajel builds can connect to VPS relay servers
2. **Content Safety**: Restrict channel content types to prevent distribution of harmful media

Both are Zajel-controlled with zero third-party dependency.

---

## 1. Content Safety: Text-Only Channels

### Problem
Channels distribute encrypted content through blind VPS relays. Servers cannot inspect content. Without controls, channels could distribute illegal media (CSAM, etc.).

### Solution
Restrict channels to text-only content at both the protocol and enforcement layers.

#### Manifest Rules
Add `allowedTypes` to the channel manifest:

```json
{
  "rules": {
    "replies_enabled": true,
    "polls_enabled": true,
    "max_upstream_size": 4096,
    "allowed_types": ["text"]
  }
}
```

#### Enforcement Layers

| Layer | Enforcement | Bypass Difficulty |
|-------|-------------|-------------------|
| **UI** | Compose bar only accepts text input, no file/media picker | Requires modified app |
| **Manifest** | `allowed_types` field verified by subscribers on chunk receipt | Requires forged manifest (impossible without owner key) |
| **VPS** | Max chunk size limit (e.g., 4KB) — text is always small, media is large | Requires modified server |
| **Subscriber** | After decryption, reject non-text content types | Requires modified app |

#### Future Media Support
Media content types (image, audio, video, file) can be enabled in the future when on-device content scanning infrastructure is ready (perceptual hashing, ML classification). Until then, text-only eliminates the most dangerous content moderation vectors.

---

## 2. Mutual Attestation

Both sides of every connection must prove they are official:

```
App ←── mutual challenge ──→ VPS Server
  "prove you're official"      "prove you're official"
```

### 2.1 App Verifies Server (Server Attestation)

Already partially implemented via bootstrap signing (Plan 02).

#### Flow
1. Bootstrap server signs its responses with Ed25519 (implemented)
2. App has pinned bootstrap public keys (implemented)
3. VPS servers register their identity keys in the bootstrap federation
4. App discovers VPS servers via bootstrap → each server's identity key is included
5. On WebSocket connect, VPS signs a handshake challenge with its registered key
6. App verifies against the key from bootstrap discovery
7. Unknown/invalid server → refuse connection

#### Trust Chain
```
Bootstrap (pinned key in app binary)
  └── signs VPS server registry
        └── each VPS server has registered identity key
              └── app verifies VPS on every connection
```

### 2.2 Server Verifies App (App Attestation)

#### The Problem
Prevent unauthorized clients (forks, bots, scrapers, modified builds with safety checks removed) from connecting to the Zajel VPS infrastructure.

#### Requirements
- Zajel-controlled — no dependency on Google Play Integrity or Apple App Attest
- Dynamic — not a static token that can be extracted and replayed
- Binary-bound — proof is tied to the exact unmodified app binary
- Unforgeable — cannot produce valid responses without the genuine binary

---

## 3. Dynamic Binary Attestation (Reverse 2FA)

### Core Concept
The app's own binary is the shared secret. Like 2FA where the authenticator seed is the app code itself — only the genuine binary can answer random questions about its own content.

### How It Works

#### Build Time (CI Pipeline)
1. CI builds the release binary (APK, IPA, Linux/Windows/macOS executable)
2. CI computes the full binary hash and stores the binary in bootstrap's attestation registry
3. CI generates a signed build token: `Sign(zajel_signing_key, {version, platform, build_hash, timestamp})`
4. Build token is embedded in the binary (this is the only static artifact)

#### First Launch (Registration)
1. App sends `{build_token, device_id}` to bootstrap
2. Bootstrap verifies build token signature → valid official build
3. Bootstrap registers the device as running a known build version
4. Bootstrap responds with attestation config (which binary regions to use, rotation schedule)

#### Every Connection (Dynamic Challenge-Response)
```
1. App connects to VPS via WebSocket
2. VPS requests attestation → contacts bootstrap
3. Bootstrap sends challenge:
   {
     nonce: "random-unique-value",
     regions: [
       { offset: 0x4A200, length: 4096 },
       { offset: 0xBF800, length: 2048 },
       { offset: 0x15C00, length: 8192 }
     ]
   }
4. App reads its OWN binary at the specified offsets
5. App computes: HMAC(binary_region_bytes, nonce) for each region
6. App sends responses to VPS → VPS forwards to bootstrap
7. Bootstrap computes the same HMACs against its stored reference binary
8. ALL match → genuine unmodified binary → allow connection
9. ANY mismatch → modified or fake binary → reject
```

### Why This Works

| Attack | Result |
|--------|--------|
| **Copy build token to custom client** | Different binary → wrong HMAC for every challenge → rejected |
| **Modify binary** (remove safety checks) | Changed bytes → wrong HMAC for any challenge hitting modified region → rejected |
| **Replay previous responses** | Different nonce each time → old responses are invalid |
| **Precompute all possible responses** | Millions of possible offset+length combinations → infeasible to precompute |
| **Extract binary and serve correct HMACs** | Requires shipping the entire official binary alongside custom code — at that point, you're running the official app |

### Challenge Randomization

Bootstrap varies its challenges to maximize coverage:

- **Different offsets** each connection — samples random regions of the binary
- **Different lengths** — varies the size of sampled regions
- **Multiple regions per challenge** — checks 3-5 sections simultaneously
- **Critical region weighting** — more frequently samples code sections containing safety checks, attestation logic, and content filtering
- **Rotation across connections** — over time, covers the entire binary

### Binary Region Strategy

```
Binary Layout:
┌─────────────────────────────┐
│ Headers & metadata          │ ← occasionally sampled
├─────────────────────────────┤
│ Core app code               │ ← frequently sampled
├─────────────────────────────┤
│ Safety & filtering logic    │ ← heavily sampled (critical)
├─────────────────────────────┤
│ Attestation code            │ ← heavily sampled (critical)
├─────────────────────────────┤
│ UI & non-critical code      │ ← occasionally sampled
├─────────────────────────────┤
│ Assets & resources          │ ← rarely sampled
└─────────────────────────────┘
```

Critical sections (safety checks, attestation logic, content filtering) are sampled more frequently, making it harder to patch only those sections.

---

## 4. Bootstrap Attestation Service

### New Bootstrap Responsibilities

Bootstrap gains a new role as the attestation authority:

```
Bootstrap Server
├── Server Registry (existing)
│     └── VPS discovery, SWIM gossip, signed responses
├── Attestation Registry (new)
│     ├── Reference binaries per version per platform
│     ├── Build token validation
│     ├── Challenge generation
│     └── Response verification
└── Version Management (new)
      ├── Active version allowlist
      ├── Revoked version blocklist
      └── Forced update thresholds
```

### Attestation API Endpoints

```
POST /attest/register
  Body: { build_token, device_id }
  Response: { status, attestation_config }

POST /attest/challenge
  Body: { device_id, build_version }
  Response: { nonce, regions: [{ offset, length }...] }

POST /attest/verify
  Body: { device_id, nonce, responses: [{ region_index, hmac }...] }
  Response: { valid: true/false, session_token }
```

### Session Tokens
After successful attestation, bootstrap issues a short-lived session token:
- VPS caches the session token → doesn't need to re-attest every message
- Token TTL: 1 hour (configurable)
- Re-attestation required on token expiry
- Token revocable by bootstrap (force re-attest on security events)

---

## 5. Version Management

### Forced Updates
Bootstrap controls which app versions are allowed to connect:

```json
{
  "minimum_version": "1.2.0",
  "recommended_version": "1.3.0",
  "blocked_versions": ["1.1.0", "1.1.1"],
  "sunset_date": {
    "1.2.0": "2026-06-01"
  }
}
```

- Below `minimum_version` → connection refused, must update
- In `blocked_versions` → connection refused (known vulnerability or leaked tokens)
- Below `recommended_version` → connection allowed with update prompt

### Build Token Revocation
If a build token is compromised:
1. Bootstrap adds it to revocation list
2. All sessions using that token are invalidated
3. Legitimate users update → get new token → continue normally
4. Attacker's copied token stops working

---

## 6. Platform Considerations

### Mobile (Android/iOS)
- Binary hash is deterministic per release (reproducible builds)
- Binary location is known and readable by the app at runtime
- App store distribution ensures most users get official builds
- Attestation catches sideloaded modified APKs

### Desktop (Linux/Windows/macOS)
- Binary is readable at runtime via `/proc/self/exe` (Linux), `GetModuleFileName` (Windows), `_NSGetExecutablePath` (macOS)
- No app store enforcement — sideloading is normal
- Attestation is the PRIMARY defense on desktop (no platform gatekeeper)

### Web
- Cannot read "own binary" — JavaScript is not a static binary
- **Fallback**: API key + rate limiting + behavioral analysis
- Web client is inherently the weakest attestation tier
- Consider: serve Web client from bootstrap-controlled CDN with Subresource Integrity (SRI)

### Attestation Strength by Platform

| Platform | Binary Attestation | Additional Controls |
|----------|-------------------|---------------------|
| Android | Full (APK hash) | App store distribution |
| iOS | Full (IPA hash) | App store enforcement |
| Linux | Full (ELF hash) | None (open platform) |
| Windows | Full (PE hash) | Code signing certificate |
| macOS | Full (Mach-O hash) | Gatekeeper notarization |
| Web | Not possible | API key + rate limiting |

---

## 7. Connection Handshake (Full Flow)

Complete WebSocket connection flow with mutual attestation:

```
┌──────┐          ┌──────┐          ┌───────────┐
│ App  │          │ VPS  │          │ Bootstrap │
└──┬───┘          └──┬───┘          └─────┬─────┘
   │                 │                    │
   │  1. WSS connect │                    │
   │────────────────>│                    │
   │                 │                    │
   │  2. Server challenge (VPS signs)     │
   │<────────────────│                    │
   │                 │                    │
   │  3. App verifies VPS signature       │
   │  against bootstrap registry          │
   │                 │                    │
   │  4. Send build_token + device_id     │
   │────────────────>│                    │
   │                 │  5. Forward to     │
   │                 │  bootstrap         │
   │                 │───────────────────>│
   │                 │                    │
   │                 │  6. Challenge      │
   │                 │  {nonce, regions}  │
   │                 │<───────────────────│
   │                 │                    │
   │  7. Binary challenge                 │
   │<────────────────│                    │
   │                 │                    │
   │  8. Read own binary at offsets       │
   │  Compute HMACs                       │
   │                 │                    │
   │  9. Send HMAC responses              │
   │────────────────>│                    │
   │                 │  10. Forward       │
   │                 │───────────────────>│
   │                 │                    │
   │                 │  11. Verify HMACs  │
   │                 │  against reference │
   │                 │  binary            │
   │                 │                    │
   │                 │  12. Result +      │
   │                 │  session_token     │
   │                 │<───────────────────│
   │                 │                    │
   │  13. Connection │                    │
   │  accepted/rejected                   │
   │<────────────────│                    │
   │                 │                    │
```

Subsequent messages include the session token. VPS validates locally (no bootstrap round-trip per message).

---

## 8. Security Properties

### What This Prevents

| Threat | How It's Prevented |
|--------|--------------------|
| Forked app with safety removed | Binary attestation fails — different binary hash |
| Bot/scraper connecting to VPS | No valid build token → rejected at registration |
| Man-in-the-middle VPS | App verifies VPS identity against bootstrap registry |
| Rogue VPS collecting data | App refuses unregistered servers |
| Token extraction + replay | Dynamic challenges require real binary, not just token |
| Old version with known vulnerability | Version management blocks outdated builds |
| Mass abuse from single token | Rate limiting per token + device flags anomalies |

### What This Does NOT Prevent

| Threat | Why | Mitigation |
|--------|-----|------------|
| Full binary extraction + emulation | Attacker ships entire official binary as library, delegates challenges to it | Obfuscate attestation code paths; detect emulation artifacts |
| Hardware-level instrumentation | Debugger reads binary memory directly | Anti-debug checks; detect instrumentation |
| Web client abuse | No binary to attest | Rate limiting, API keys, behavioral analysis |

### Defense in Depth

```
Layer 1: Build signing — only CI can produce valid build tokens
Layer 2: Binary attestation — only unmodified binaries pass challenges
Layer 3: Version management — revoke compromised or outdated builds
Layer 4: Session tokens — time-limited access, revocable
Layer 5: Rate limiting — anomaly detection on token/device usage
Layer 6: Text-only content — eliminates harmful media vectors
```

---

## 9. Implementation Phases

### Phase 1: Text-Only Enforcement
- Add `allowed_types` to `ChannelRules` in manifest model
- Enforce at UI (compose bar), subscriber (chunk validation), and VPS (size limit)
- All channels default to `["text"]`

### Phase 2: Build Token Infrastructure
- CI generates signed build tokens per release
- Bootstrap attestation registry stores reference binaries
- Build token embedded in release binaries
- Registration endpoint validates tokens

### Phase 3: Dynamic Binary Attestation
- Challenge-response protocol implementation
- App self-reads binary at requested offsets
- Bootstrap verifies HMAC responses against reference
- Session token issuance after successful attestation

### Phase 4: Mutual Server Attestation
- VPS identity keys registered in bootstrap
- App verifies VPS identity on every WebSocket connection
- Reject unknown/unregistered servers

### Phase 5: Version Management
- Minimum version enforcement
- Build token revocation
- Forced update flow in app UI
- Sunset scheduling for old versions

### Phase 6: Hardening
- Obfuscation of attestation code paths
- Anti-debug detection
- Critical region weighting in challenge generation
- Behavioral analysis and anomaly detection
- Web client fallback controls

---

## 10. Open Questions

1. **Reproducible builds**: Can we guarantee deterministic binary output across CI runs for the same source? Required for binary attestation to work.
2. **Flutter AOT compilation**: Does Flutter's AOT compilation produce deterministic binaries? Need to verify per platform.
3. **Binary self-read on iOS**: iOS app sandboxing may restrict reading the app's own executable. Needs testing.
4. **Challenge latency**: Bootstrap round-trip adds latency to connection setup. Acceptable? Cache session tokens aggressively?
5. **Offline/degraded mode**: If bootstrap is unreachable, should VPS accept connections with cached attestation, or hard-fail?
6. **Open source tension**: Publishing source code helps attackers understand attestation logic. Mitigation: attestation module closed-source? Or accept the tradeoff?
7. **Update pressure**: Forcing updates annoys users. How aggressive should version management be?
8. **Multi-binary platforms**: Android has split APKs (App Bundles). Which binary is the reference? Need per-ABI references.
