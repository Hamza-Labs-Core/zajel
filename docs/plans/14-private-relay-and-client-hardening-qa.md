# Private Relay Architecture — Discussion Q&A

**Date:** 2026-04-22
**Context:** Triggered by production log analysis showing WebRTC P2P failures when one peer sits behind a VPN. Discussion expanded from "fix the VPN case" into a full privacy-messenger architecture review.

> This is a discussion artifact, not a committed design. The concrete plans it implies will be written as their own docs once direction is confirmed.

---

## Q1 — "What if I told you that the other pair is online, but is behind a VPN?"

### A1 — Then ICE failure is the primary issue, not a keepalive problem

The logs show no `typ relay` candidates in any offer/ice_candidate; the peer on a VPN almost certainly has symmetric or port-restricted NAT, and without TURN there's no fallback path.

Consumer VPNs (Mullvad, Nord, WireGuard exits, corporate SSL-VPN) nearly always present symmetric NAT to the outside: each `(dst-ip, dst-port)` pair gets a different source port. ICE's srflx candidate is harvested once via STUN against a different destination, so the port the peer learns is *not* the port that will accept traffic from you. Direct P2P is structurally impossible — TURN is mandatory.

**Re-reading the two ICE failures with the VPN fact in mind:**

- **MC9QH5 dying in 45s** (`21:26:43.931 connected → 21:27:28.717 disconnected`) is the signature:
  - ICE finds *a* valid candidate pair, probably a lucky prflx discovery during the initial STUN binding request burst (both sides sent checks at ~the same time, one got through)
  - That pinhole dies the moment the VPN's NAT re-uses the outbound port for any other destination — typically well under a minute
  - No ICE restart, no relay fallback → straight to Failed

- **XCWAAY dying in 6½ min** is the slower version of the same thing:
  - Initial binding happened to work because home router is on a normal (likely endpoint-independent) NAT — srflx `96.242.14.209` cleanly
  - Consent Freshness (RFC 7675) keeps re-probing every ~5s
  - Asymmetric mapping means checks fail in the peer→you direction eventually, quorum lost after the 30s consent window → Disconnected at 21:29:49, Failed at 21:29:59

**Evidence in log:** scan the `offer` payload at `21:23:21.636` and `21:26:43.562` — only `typ host` and `typ srflx` candidates. No `typ relay`. Either no TURN configured for the Linux build (`TURN_URL` not baked in via `--dart-define`) or TURN configured but unreachable / rejected creds so no relay candidate gathered.

**Implication:** #4 (ICE death) collapses into the same work as the shelved IP-exposure question. If the client defaults to `iceTransportPolicy: 'relay'`, the peer never learns your home IP — they only see the TURN server's public IP. TURN infrastructure unlocks both.

---

## Q2 — Requirements for proper solution

> We need the following, this needs deep thinking and research and a good plan:
>
> 1. Clients behind a VPN should work normally
> 2. Client IPs should never be exposed
> 3. Can we solve 2 by having our own VPN servers? meaning that all traffic we do is through our servers, but not the signaling servers, and are heavily encrypted, not just ssl, that no body in the world can see inside, not even the server itself

### A2 — Initial 4-layer plan (superseded by A3 after requirement clarification)

Summary before the clarification:

- **Layer 1: Production TURN** (`turns://` on 443, HMAC ephemeral creds, `iceTransportPolicy: 'relay'`)
- **Layer 2: Split-relay** across two regions (A→TURN_eu→TURN_me→B) so no single server sees both legs
- **Layer 3: Operator-trust hardening** (no-log, RAM-only, reproducible builds, warrant canary, transparency log)
- **Layer 4 (don't build): Onion/mix routing** — too expensive in latency for WebRTC, recommend Tor transport as opt-in instead

Initial framing incorrectly assumed WebRTC's DTLS content-E2E was enough to satisfy requirement #3. The clarification below changes that.

---

## Q3 — Clarified requirements: paranoid-by-default privacy messenger

> What I mean when I say VPN, I mean only Zajel traffic, and when I say not SSL, I mean our own encryption that no RSA backdoor can make it visible, and I want all encrypted on disk, so on client data is encrypted 100%, even in memory its encrypted, even if it means users need a password to see the msgs, and no data in notifications, see recent Signal Apple notification issue, latency? meh, what's important is privacy, ISP can't see, LAN can't see, router can't see, our servers can't see, and it should be a server other than signaling servers so that they can be deployed on their own, with own hardware rules, signaling servers only introduce and traffic full encryption starts after on the direct talk, and this is for text, and VoIP, so that a country like UAE would never know what the traffic is

### A3 — Six-layer architecture and phased plan

> "No RSA backdoor" is a real concern but already structurally solved by the ciphers Zajel uses — we're on X25519 (ECDH), Ed25519 (signatures), ChaCha20-Poly1305 (AEAD), HKDF, and ML-KEM-768 (post-quantum KEM per the register log `"supportedKEMs":["x25519","x25519-mlkem768"]`). No RSA anywhere. The PKI-trust issue (what if a CA is compelled?) is the harder version of that concern, and the answer is: don't use CAs for anything security-critical — pin public keys directly, signed by Ed25519, distributed via signaling that the client has already verified.

#### Mapping requirements to layers

| Layer | Requirement | State today | Work needed |
|---|---|---|---|
| **L1. On-device at rest** | Disk 100% encrypted, even keys | Partial (secure_storage uses platform keychain) | SQLCipher + Argon2id passphrase + full DB encryption |
| **L2. On-device in memory** | Plaintext wiped on lock; keys locked | Not done | libsodium secure memory, mlock, zero-on-timeout |
| **L3. Notifications** | Nothing decrypted in the push | Not done | Encrypted push payload + notification-service-extension defers decrypt |
| **L4. Relay (data/voice)** | Own servers, own encryption, not TLS | Not done | Noise-protocol tunnel over QUIC, separate hardware, split-horizon relay |
| **L5. DPI / country-level block resistance** | Traffic unidentifiable to UAE-level DPI | Not done | Pluggable transports: Reality/Hysteria2-style handshake, traffic shaping |
| **L6. Forward + post-compromise secrecy** | Compromise of one session doesn't leak others | Forward: yes (ephemeral). PCS: no. | Double-ratchet-style keying (without touching GPL Signal Protocol code) |

---

#### L1. On-device storage — full DB encryption with passphrase

**Goal:** if someone takes your phone/laptop while locked, they get a ciphertext blob and nothing else — not messages, not contacts, not keys, not metadata.

**Approach:**

- Migrate all persistence to **SQLCipher** (SQLite + page-level AES-256 or ChaCha20 encryption). Drift ORM on Flutter works with `sqlcipher_flutter_libs`.
- **Master key derivation**: Argon2id (time=3, mem=64MiB, parallelism=1) from user passphrase → 32-byte key. On boot, no keys are in memory. First unlock triggers KDF (~1–2s on mid-range hardware, deliberate).
- **Nested wrapping**: existing X25519/Ed25519 key pairs stored as SecretBox-sealed blobs inside SQLCipher. Two layers of encryption; breaking one doesn't help.
- **Re-key ceremony**: every passphrase change re-wraps, never re-derives the DB key itself (so changing passphrase is cheap).
- **Recovery**: opt-in 24-word recovery phrase (BIP-39 style) wraps the master key with a second path. If user forgets passphrase, chat is genuinely gone. This is a feature, not a bug.
- **No iCloud/Google backup**: SQLCipher file marked `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` on iOS, backup-excluded on Android. Cross-device migration is explicit, QR-based, point-to-point.

**Work estimate:** 2–3 weeks of focused work for Flutter side. Test migration of existing unencrypted DB carefully.

---

#### L2. In-memory hardening

**Goal:** a memory dump (cold-boot, `/proc/<pid>/mem`, gcore, or malicious app sharing a device) reveals nothing useful.

**Approach:**

- All secret bytes allocated via **libsodium `sodium_malloc`**: guard pages either side, canary bytes, pages marked `PROT_NONE` when unused, `mlock()` to prevent swap. Flutter binding: `dart-sodium` or FFI directly.
- **Explicit `memzero` on Dart/Kotlin/Swift objects** holding key material — currently Dart `Uint8List` is GC-allocated, so we need a typed wrapper that owns native-allocated memory with a finalizer that zeroes on collect.
- **Lock timeout**: default 2 minutes of inactivity → app locks, derives a deliberate "wipe" key from a HKDF chain, zeroes all caches/DB handles, closes SQLCipher connection (which itself zeroes its key). UI shows lock screen; passphrase re-entry required.
- **No process persistence of passphrase**: even while unlocked, only the DB key (derived once) is in memory. The passphrase itself is zeroed immediately after Argon2id.
- **Platform hardening:**
  - iOS: `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, avoid increased-memory-limit entitlement so we stay in a constrained, auditable heap.
  - Android: `WindowManager.FLAG_SECURE` on chat screens (blocks screenshots and screen-recording), StrongBox keystore where available.
  - Desktop: harder — no equivalent of StrongBox. Document the threat-model limit clearly ("physical access while unlocked = game over").

**Work estimate:** 2–3 weeks. Most of the work is auditing every place secret bytes flow through.

---

#### L3. Notifications — "you have a message" and nothing more

The Signal incident: Apple's Notification Service Extension runs with access to Signal's keychain group, decrypts push payload, renders preview → preview is cached by the system and, under some conditions, has leaked to device backups / Shortcuts / auto-display on other devices.

**Approach:**

- **Encrypted push payload**: server sends `{sender_hint, encrypted_blob}` where blob is ChaCha20-Poly1305 under a **push key** rotated every N days. Neither APNs nor FCM can decrypt.
- **No content rendering pre-unlock**: notification service extension just shows "🔒 New message" when app is locked. No sender name, no group name, no preview — matching the "even sender not visible" bar is a config toggle.
- **Post-unlock**: once app is active and unlocked, generate *local* notifications (iOS `UNUserNotificationCenter` local path, not via APNs) with content, since the device memory is trusted.
- **No notification content in system logs**: Android `NotificationChannel` importance set to minimize logging. iOS `UNNotificationContent` stripped before `contentHandler()` so the OS only ever sees the placeholder.
- **Decouple delivery from knowledge**: push carries only "wake up and check queue", content arrives over the relay tunnel (L4). Means even if APNs is compromised, no content leaks — APNs literally doesn't see it.

**Work estimate:** 1 week for Flutter + platform-specific notification extensions.

---

#### L4. Separate relay layer — the core of the question

Two disjoint server fleets, two disjoint trust scopes:

```
┌──────────────────────┐              ┌──────────────────────┐
│  SIGNALING SERVERS   │              │   RELAY SERVERS      │
│  (existing, Cranl,   │              │   (new, dedicated,   │
│   Hetzner, CF Worker)│              │   Iceland/CH/PA)     │
│                      │              │                      │
│  Sees: pair codes,   │              │  Sees: encrypted     │
│        rendezvous    │              │        blobs +       │
│        tokens, auth  │              │        client IPs    │
│                      │              │                      │
│  Never sees: content │              │  Never sees: content │
│              relay   │              │              signaling│
│              addrs   │              │              keys    │
└──────────────────────┘              └──────────────────────┘
          │                                       │
          │ (1) Peers introduce via signaling     │
          │     Get ephemeral relay creds         │
          │                                       │
          └───── (2) Drop signaling, open ───────►│
                     relay tunnel directly        │
                     All further traffic here
```

Signaling servers keep their existing hardware profile (CF Workers, VPS for WSS). Relay servers run on **dedicated bare-metal** in privacy-friendly jurisdictions with different operational rules: RAM-only, no persistence, tmpfs logs, kernel hardened (lockdown mode, no ptrace, no kexec), Secure Boot, full disk encryption with TPM-sealed key tied to attestation.

**The tunnel protocol — Noise, not TLS:**

- **Noise Protocol Framework** (noiseprotocol.org), pattern `IK` (client knows relay's static public key, sends its own ephemeral). No certs, no CAs. Curve25519 + ChaCha20-Poly1305 + BLAKE2s. Published relay public keys pinned in the client at build time, rotated via signed updates (Ed25519) distributed over the signaling channel.
- **Transport**: QUIC (RFC 9000). QUIC integrates its own crypto handshake (normally TLS 1.3), but we swap the cryptographic core for Noise. Our handshake packets look like QUIC Initial packets — unremarkable to any DPI on the wire.
- **Forward secrecy**: Noise's ephemeral keys provide it for the tunnel. Application layer (Zajel ChaCha20-Poly1305 per-session) provides it again for the content. Two independent sources of forward secrecy.
- **Why not TLS**: even TLS 1.3, which doesn't use RSA for key exchange, still relies on the X.509 PKI for server identity. An adversary with a cooperative CA can MITM. Noise pinned-key IK pattern has **zero external trust dependency** — the only thing that matters is whether the client has the correct relay static pubkey, which came in with the signed app bundle.

**Three layers of encryption** on the wire between peer A and peer B:

```
 ┌────────────────────────────────────────────────────────────────────┐
 │ UDP / IP                                                           │
 │  └─ QUIC outer frame                                               │
 │      └─ Noise_IK ciphertext (client ↔ relay A)                     │
 │          ├─ Inner forwarding header (relay A → relay B, encrypted) │
 │          └─ Noise_IK ciphertext (client A ↔ client B)              │
 │              └─ Zajel session AEAD (ChaCha20-Poly1305 + MLKEM)     │
 │                  └─ Actual message bytes                           │
 └────────────────────────────────────────────────────────────────────┘
```

- **ISP / LAN / router / UAE DPI** see: QUIC packets to one of many relay IPs, random-looking ciphertext inside. Looks identical to video-conferencing QUIC or HTTP/3.
- **Relay A (entry)** sees: client A's IP, a Noise tunnel it shares with A. Inside that tunnel, another encrypted frame it forwards to relay B. Cannot tell who the peer is, what the content is, or what protocol is inside.
- **Relay B (exit)** sees: client B's IP, inbound forwarded encrypted frames from relay A. Cannot tell who the origin is, what the content is.
- **Client A and client B** see: everything, as expected.

Even if one relay is wholly compromised, the other leg's identity is unknown to it. Compromise both and Zajel's inner E2E encryption still holds.

**Voice/video over this:** drop WebRTC's TURN; carry SRTP packets over the same Noise tunnel. SRTP's own encryption remains the inner layer. Relay carries SRTP-in-Noise-in-QUIC. Latency budget: +30–80ms round-trip depending on relay placement — acceptable for voice if relays are close to common user routes. For onion 3-hop, fall back to text-only.

**Work estimate:** design doc + prototype ~1 month, production hardening ~2–3 months. Requires someone with protocol-work experience, or careful external cryptographer review. Budget external audit ($30–60k) before shipping.

---

#### L5. DPI resistance — "UAE can't tell this is messaging"

This is an arms race and has no permanent solution. Accepted playbook:

- **Protocol mimicry**: QUIC + Noise already looks like HTTP/3 to passive DPI. Make Noise handshake packets sized and timed to match QUIC Initial with a real CDN's parameters. Borrow from **Reality / XTLS** (latest V2Ray work) which mimics actual TLS fingerprints of Google/Cloudflare; do the analogous thing for QUIC.
- **Domain fronting via Cloudflare Workers**: since signaling is already on CF, we can have *all* traffic connect to `*.workers.dev` IPs, with the real routing decided inside the encrypted tunnel. Cloudflare sees Noise traffic going to a worker endpoint; UAE sees traffic going to Cloudflare (unblockable without blocking all of Cloudflare).
- **Bridge discovery**: relay IPs rotate. Published via signaling in-band. Active-probing detection: if a client sees its connection reset repeatedly, rotate to a different relay.
- **Pluggable transports**: architect the tunnel so the outermost framing is swappable. Today QUIC + Noise; tomorrow, if UAE ML-models start flagging our fingerprint, swap to `obfs4` or `meek` without changing the inner protocol.
- **Active probing resistance**: a probe from UAE trying to connect to a relay IP with wrong keys should get exactly the behavior a real HTTPS server gives (TLS error, or silent drop indistinguishable from closed port). Don't send a custom error message.

**Realistically:** we don't build from scratch — integrate **Tor Project's pluggable transports** ecosystem (obfs4, snowflake, meek, webtunnel) and contribute back. Or **Lantern's** flashlight library. Or **Psiphon's** SDK. All three are open-source, battle-tested against China/Iran/Russia.

**Work estimate:** 1–2 months to integrate one PT library and test against real censorship. Ongoing maintenance.

---

#### L6. Forward + post-compromise secrecy — without touching Signal Protocol

CLAUDE.md forbids Signal Protocol's code (AGPL). But the *ideas* — double ratchet, skipped message keys, out-of-order resilience — are published cryptographic constructions with decades of academic work. We can implement from spec (Perrin & Marlinspike, 2016) without touching GPL code.

- **Current state**: Zajel does ephemeral-per-session X25519, which gives forward secrecy for session-keyed messages. Good.
- **Gap**: no post-compromise security. If a peer is compromised at time T, all messages after T under the same long-term key are readable by the attacker until next re-pairing.
- **Fix**: a symmetric ratchet (KDF chain) that updates the message key after every message, *plus* a DH ratchet that refreshes whenever a new ephemeral key is received. **MLS** (IETF Messaging Layer Security, RFC 9420) specifies a group-aware version we could adopt directly — RFC-standardized, permissive license, formally analyzed, post-quantum retrofittable. OpenMLS has Rust/FFI options.

**Work estimate:** 1–2 months for MLS integration + migration testing.

---

### Phased plan

| Phase | Weeks | Deliverable | Blast radius if delayed |
|---|---|---|---|
| **0** | 1 | Production TURN on 443 + `iceTransportPolicy: 'relay'`. *Interim* fix for VPN compat + peer IP hiding, while L4 is being built. | High — current logs show real users behind VPN can't connect |
| **1** | 3–4 | L1 SQLCipher + passphrase + L2 memory hardening | Medium — disk encryption is a common audit blocker |
| **2** | 2 | L3 notifications redesign | Medium — one incident like Signal's is reputation damage |
| **3** | 8–12 | L4 Noise+QUIC relay tunnel, design → prototype → audit → prod | Core feature; "own VPN" promise rides on this |
| **4** | 8 | L4 split-horizon multi-hop, jurisdiction-diverse deployment | Rounds out the metadata-privacy claim |
| **5** | 4–6 | L5 pluggable transports (integrate Tor PTs or Lantern) | Needed for UAE/CN/IR users; delay blocks those markets |
| **6** | 6–8 | L6 MLS forward+PCS ratchet | Nice-to-have until a real compromise happens, then very not-nice-to-have |

**Total:** ~8–10 months with 1–2 engineers, or ~5–6 months with 3–4 and a cryptographer on review.

---

### Hard research questions that need answers before committing

1. **Legal jurisdiction for relay servers.** Which countries won't compel us to log? Iceland, Switzerland, Panama are common answers; Moldova/Romania are cheaper. Need a lawyer to confirm no mandatory-data-retention (MDR) laws apply. Hetzner DE is OK but subject to evolving EU mandates.
2. **Bandwidth + cost model.** Relay-all-traffic is bandwidth-intensive. 100k users × 10MB/day × 2 hops ≈ 4Gbps sustained. At bare-metal pricing (~€0.50/TB) that's ~€5k/month. Calculate target scale and budget.
3. **Who holds the relay signing keys?** A single HSM at one location is a single point of compulsion. Threshold signatures (2-of-3 keys across jurisdictions) adds complexity but removes single point.
4. **Audit + open source commitment.** "Trust us" is not a security claim. Relay server code must be open-source, reproducible-build, with matching binaries deployed. Non-negotiable for the promise to be defensible.
5. **Tor transport integration as a fallback/opt-in.** Rather than building our own onion layer, users who want maximum paranoia can tunnel over Tor. Cheaper, battle-tested, and we don't become the single point of trust.
6. **Voice quality under multi-hop.** Needs empirical measurement. Two relay hops with geographic distance may push voice latency above the 200ms conversational-feel limit. May need to offer "text over relay, voice direct-with-TURN" as a config.

---

### Recommendation

Split into per-topic plan docs when direction is confirmed:

- `docs/plans/15-private-relay-architecture.md` — L4 detailed design (protocol, deployment, threat model)
- `docs/plans/16-client-hardening.md` — L1 + L2 + L3 (on-device)
- `docs/plans/17-censorship-resistance.md` — L5 transports
- `docs/plans/18-ratchet-upgrade.md` — L6 MLS integration

Each doc owns a threat-model subsection, a concrete design, and a test plan. Epics align 1:1 with docs.

**Phase 0 starts immediately** — production TURN is the only thing that actually fixes the bug in the logs today. The rest is the right long-term architecture but doesn't help the user on the VPN tonight.

**Next decision point:** whether to do a one-week research spike on QUIC+Noise composability, Reality/XTLS fingerprinting, and current state of Tor pluggable transports *before* writing plan 15 — recommended, because getting the L4 protocol decisions wrong is the most expensive mistake on this list.
