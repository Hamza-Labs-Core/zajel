# IP Address Exposure Analysis — Zajel

**Date:** 2026-02-11
**Scope:** Full codebase audit of network paths where IP addresses are visible

**Short answer: Yes, multiple parties can learn IP addresses of communicating peers.**

---

## 1. The Person You're Talking To — Sees Your IP

WebRTC is P2P by design — once ICE negotiation completes, both peers exchange UDP packets directly.

**What your peer sees:**
- Your **public IP** (from STUN server-reflexive candidates)
- Your **private/LAN IP** (from host candidates)
- Your NAT type and network topology

**Why:** `webrtc_service.dart` — the `onIceCandidate` handler forwards every candidate to the peer without any filtering. No mDNS masking, no host-candidate stripping, no relay-only option for users.

**Exception:** If both peers go through TURN, the peer only sees the TURN relay IP. But `forceRelay` is only enabled in E2E test mode (`app_providers.dart`), never in production.

---

## 2. The Signaling Server Operator — Sees Everyone's IPs

The VPS signaling server is the most dangerous vantage point:

| Data | Visible? | How |
|------|----------|-----|
| Client IP | **Yes** | `req.socket.remoteAddress` at `index.ts` |
| Pairing codes | **Yes** | Sent in plaintext JSON over WSS |
| Public keys | **Yes** | Sent during registration |
| **All ICE candidates** | **Yes** | Forwarded as-is through `handleSignalingForward` in `handler.ts` |
| Who talks to whom | **Yes** | Server maps `pair_request` → `pair_matched` for every connection |
| Meeting point hashes | **Yes** | Rendezvous registry correlates which peer IDs share tokens |

The ICE candidate forwarding is the critical leak. Each candidate string contains the literal IP address (e.g., `candidate:1234 1 udp 2122260223 192.168.1.100 54321 typ host`). The signaling server sees every candidate for every peer — it can build a complete map of IP ↔ identity ↔ communication partners.

**Mitigating factor:** The VPS logger (`logger.ts`) redacts IPs in production (`192.168.1.1` → `192.*.*.*`), but:
- This only affects *log output*, not what the server processes in memory
- A malicious operator can disable redaction (`REDACT_LOGS=false`)
- ICE candidate payloads are not redacted at all — they're forwarded as opaque JSON

---

## 3. Google (STUN Server) — Sees Your Public IP

Default config uses `stun:stun.l.google.com:19302`.

Google sees your public IP + port for every STUN binding request. STUN is unencrypted. They can't see *who* you're talking to, but they know you're using WebRTC.

---

## 4. TURN Server Operator — Sees Both Peers' IPs

When TURN is used (fallback only in production), the TURN operator sees both endpoints' IPs and all traffic metadata (volume, duration, timing). Content is encrypted (DTLS + ChaCha20), so they can't read messages.

---

## 5. Cloudflare (Bootstrap) — Sees Your IP, Not Your Peer's

The bootstrap CF Worker at `signal.zajel.hamzalabs.dev` serves `GET /servers`. Cloudflare sees your IP + timestamp but doesn't know who you'll talk to. This is standard CDN metadata.

---

## 6. ISP / Network Observer — Can Infer

- **DNS queries** to `signal.zajel.hamzalabs.dev` reveal Zajel usage (no DoH)
- **TCP flow to signaling server** is visible (WSS, but TLS doesn't hide the destination IP)
- **Direct UDP flows between peers** are visible — an ISP seeing UDP traffic from IP A to IP B at the same time both connect to the signaling server can correlate them

---

## What IS Protected

**Message content** is safe everywhere. X25519 key exchange + ChaCha20-Poly1305 AEAD means:
- Signaling server sees ciphertext only
- TURN server sees ciphertext only
- Network observers see ciphertext only
- Only the two peers can decrypt

---

## Summary Threat Matrix

| Adversary | Knows your IP? | Knows peer's IP? | Knows you're talking? | Reads messages? |
|-----------|:-:|:-:|:-:|:-:|
| Your peer | **Yes** | (it's them) | **Yes** | **Yes** (intended) |
| Signaling server | **Yes** | **Yes** | **Yes** | No |
| STUN (Google) | **Yes** | No | No | No |
| TURN relay | **Yes** | **Yes** | **Yes** | No |
| Cloudflare (bootstrap) | **Yes** | No | No | No |
| ISP / network observer | **Yes** | **Likely** (UDP flow) | **Likely** | No |
| Random internet attacker | No | No | No | No |

---

## Gaps to Address

### 1. No Relay-Only Mode for Users
`forceRelay` exists but is E2E-test-only. Exposing it as a user-facing "Privacy mode" setting would let users route all traffic through TURN, hiding their IP from the peer.

### 2. No ICE Candidate Filtering
Host candidates leak private IPs. At minimum, stripping `typ host` candidates before sending would prevent LAN IP exposure.

### 3. Signaling Server Sees Everything
ICE candidates flow through the server in plaintext JSON. Even with E2E-encrypted messages, the signaling layer leaks all network metadata. A Tor-like onion routing layer or client-side candidate encryption would address this, but that's a major architectural change.

### 4. No DNS Privacy
Adding DoH or using IP-based connections instead of hostnames would prevent ISP DNS snooping.

---

## Conclusion

The architecture protects **content** very well. It does not protect **metadata** (who talks to whom, when, from where).
