# Plan 05: Channels & Groups

## Overview

Two new communication modes for Zajel, each with different trust and privacy models:

- **Groups**: Small, tight-knit physical groups. Full mesh P2P. Everyone knows each other.
- **Channels**: One-to-many broadcast. Subscription-based. No member sees any other member.

Both maintain E2E encryption and zero-knowledge server architecture.

---

## 1. Groups (Trusted P2P)

### Purpose
Private communication for people who know each other in real life. Small teams, families, friend circles.

### Topology: Full Mesh WebRTC
Every member connects directly to every other member via WebRTC data channels (same as current 1:1 messaging).

```
  A --- B
  |\ /|
  | X  |
  |/ \ |
  C --- D

  Every peer connected to every peer.
  IPs visible to each other (by design — they trust each other).
```

- **Practical limit**: ~10-15 members (N*(N-1)/2 connections)
- **No server relay**: traffic flows directly between devices
- **IP exposure**: members see each other's IPs — acceptable because they already know each other

### Encryption: Sender Keys
- Each member generates a symmetric "sender key"
- Distributes it to all members via existing pairwise E2E channels (X25519)
- Sending: encrypt once with sender's key → all members decrypt
- **O(1) encrypt, O(1) decrypt** per message

### Key Management
- **Member joins**: existing member sends them all current sender keys via pairwise E2E
- **Member leaves**: everyone rotates their sender key and redistributes
- Forward secrecy on removal requires key rotation

### Message Sync: Vector Clocks
Each peer tracks what it has and what others have:

```
Message ID = {author_device_id}:{sequence_number}

Alice's vector clock:  {alice: 5, bob: 3, carol: 7}
Bob's vector clock:    {alice: 3, bob: 3, carol: 7}

When they connect:
  Bob: "I have alice:3, bob:3, carol:7"
  Alice: "You're missing alice:4 and alice:5, here they are"
```

Handles offline peers catching up, out-of-order messages, and network partitions.

### Storage
- All messages stored on every member's device
- No server storage
- History available as long as any group member has it

---

## 2. Channels (Anonymous Broadcast)

### Purpose
One-to-many content distribution. Subscribers follow a channel owner. No subscriber knows any other subscriber. Owner's identity (IP, real-world info) is protected.

### Core Principle: VPS as Blind Relay
All channel traffic flows through the federated VPS servers. No WebRTC. No direct peer connections. The VPS is always in the middle.

```
Owner ←─WSS─→ VPS ←─WSS─→ Subscriber A
                   ←─WSS─→ Subscriber B
                   ←─WSS─→ Subscriber C

No peer ever talks to another peer.
```

### Privacy Guarantees

| Party | Knows | Does NOT know |
|-------|-------|---------------|
| Owner | VPS server IP | Any subscriber's IP or identity |
| Subscriber | VPS server IP | Owner's IP, other subscribers' IPs or identities |
| VPS server | Client IPs (unavoidable) | Chunk content (encrypted), channel metadata |

### Channel Identity
A channel IS a public key. Nothing more.

```
Channel = Ed25519 keypair
  - Public key: the channel's identity, shared with subscribers
  - Private key: NEVER leaves the owner's device

Subscribe = store the channel's public key locally
Verify = check signatures against that stored key
```

No accounts, no usernames, no server-side records. The private key IS ownership.

### Discovery (Out-of-Band)
Subscribers obtain the channel's public key through:
- QR code scanned in person
- Shared link: `zajel://channel/Ed25519:<base64-pubkey>`
- Recommendation from another trusted channel
- Posted on social media, website, etc.

---

## 3. Chunk Protocol

All content (text, files, audio, video, documents, polls) uses the same chunk model.

### Chunk Structure

```
Chunk (what flows through VPS):
┌──────────────────────────────────────────────────┐
│ PLAINTEXT HEADER (VPS can see):                  │
│   chunk_id:       "ch_a7f3e_003"                 │
│   routing_hash:   "rh_8b2d1..."                  │
│   sequence:       47                             │
│   chunk_index:    3 of 12                        │
│   size:           65536                          │
│                                                  │
│ SIGNED ENVELOPE (VPS cannot forge):              │
│   signature:      Ed25519(author_key, payload)   │
│   author_pubkey:  <signer's public key>          │
│                                                  │
│ ENCRYPTED PAYLOAD (VPS cannot read):             │
│   Encrypt(channel_key, content)                  │
└──────────────────────────────────────────────────┘
```

### Encrypted Payload (only members can read)

```
{
  type:     "text" | "file" | "audio" | "video" | "document" | "poll",
  payload:  <actual content bytes>,
  metadata: { filename, duration, mimetype, dimensions, ... },
  reply_to: <message_id> (if reply),
  author:   <admin_id> (if multi-admin channel),
  timestamp: <signed timestamp>
}
```

### Content Types
- **Text**: single chunk
- **Audio message**: 1-3 chunks (Opus/OGG)
- **Image**: 1-10 chunks depending on size
- **Video**: many chunks (split at fixed size, e.g., 64KB)
- **Document**: split into chunks like any file
- **Poll**: single chunk (poll definition), votes flow upstream

VPS treats all chunk types identically — encrypted bytes it cannot read.

---

## 4. VPS Relay Architecture

### Role of VPS Servers
The existing federated VPS infrastructure handles channels with minimal additions:

1. **Chunk Index** (SQLite): which peers have which chunks — tiny metadata only
2. **Temp Disk Cache**: encrypted blobs cached on VPS disk with TTL auto-cleanup
3. **Streaming Relay**: pull from source peer, write to disk, stream to requesting peers
4. **No permanent storage**: all cached data deleted after TTL expires

### DHT Routing
Channel routing uses the existing consistent hashing DHT:

```
routing_hash = HMAC(channel_secret, "epoch:<current_period>")
  → maps to DHT ring position
  → 3 VPS nodes responsible (replication factor 3)
```

Routing hash rotates per epoch (see Section 8: Censorship Resistance).

### Chunk Index (SQLite)

```sql
CREATE TABLE chunk_index (
  chunk_id      TEXT NOT NULL,
  routing_hash  TEXT NOT NULL,
  peer_id       TEXT NOT NULL,
  is_cache      BOOLEAN DEFAULT FALSE,  -- TRUE = VPS disk cache
  cached_at     INTEGER,                 -- timestamp for TTL cleanup
  PRIMARY KEY (chunk_id, peer_id)
);

CREATE INDEX idx_routing ON chunk_index(routing_hash);
CREATE INDEX idx_cache_ttl ON chunk_index(cached_at) WHERE is_cache = TRUE;
```

### Data Flow

```
1. Owner publishes new content:
   Owner device → encrypts + signs → splits into chunks
   Owner → WSS → VPS: "I have chunks [ch_001, ch_002, ch_003]"
   VPS: updates chunk_index, sets owner as source

2. Subscriber requests content:
   Subscriber → WSS → VPS: "I need chunk ch_001"
   VPS checks:
     a) Disk cache (within TTL)? → stream from disk
     b) No cache? → check index → find online peer who has it
     c) Pull from source peer via WSS → write to disk → stream to subscriber
     d) No online source? → queue request, notify when source comes online

3. Subscriber becomes a source:
   After downloading chunks, subscriber registers with index:
   Subscriber → VPS: "I now have chunks [ch_001, ch_002, ch_003]"
   VPS: adds subscriber as source in chunk_index

4. TTL cleanup (cron/periodic):
   DELETE FROM chunk_index WHERE is_cache = TRUE AND cached_at < NOW() - TTL;
   Delete corresponding files from disk.
```

### Multicast Optimization
When multiple subscribers request the same chunk simultaneously:

```
VPS pulls chunk from source once → writes to disk
  → streams to subscriber A
  → streams to subscriber B    (from same disk cache)
  → streams to subscriber C    (from same disk cache)

Source peer's bandwidth: 1x upload
VPS disk reads: parallel, fast
```

### Swarm Resilience
As subscribers download and register as sources, the swarm grows:

```
Minute 0:  Owner is only source. 1 seeder.
Minute 1:  100 subscribers downloaded. 101 seeders.
Minute 5:  10,000 subscribers. Owner goes offline. Doesn't matter.
Minute 60: VPS cache TTL expires. Chunks still available from subscriber devices.
```

The owner's device only needs to be online for the initial upload. After that, the swarm sustains itself.

---

## 5. Upstream Channel (Replies, Votes, Interactions)

Channels are not purely one-way. Subscribers can send data upstream to the owner, but never to each other.

### Flow

```
BROADCAST (owner → subscribers):
  Owner → VPS → all subscribers        (normal chunk distribution)

UPSTREAM (subscriber → owner):
  Subscriber → VPS → Owner             (private, routed to owner only)

  - Owner never sees subscriber's IP
  - Subscriber never sees owner's IP
  - No subscriber sees any other subscriber
```

### Replies
- Subscriber encrypts reply with owner's public key → sends to VPS → routed to owner
- Owner decides: feature it, respond, ignore
- Owner's response is a normal broadcast chunk

### Polls & Votes
- Owner broadcasts poll definition (normal chunk)
- Subscribers send votes upstream → VPS → owner
- Owner tallies and broadcasts results as a new chunk
- Only the owner sees individual votes
- If owner is offline, votes queue on VPS (small encrypted blobs) until owner reconnects

### Rate Limiting
- VPS enforces per-peer rate limits on upstream messages
- Prevents spam without reading content
- Owner can also publish rules in the channel manifest (e.g., "replies disabled")

---

## 6. Live Streaming

Live audio/video cannot use chunk-and-cache. It requires real-time streaming.

### Live Mode: VPS as SFU

```
Owner streams live:
  Owner → WSS → VPS → fan-out to all connected subscribers

  VPS receives encrypted stream frames
  Immediately forwards to all subscriber WebSockets
  Optionally writes frames to disk (for post-live VOD)
  No store-and-forward delay — pure streaming relay
```

### Post-Live Recording
When the live stream ends, if the owner chooses to save it:

```
Option A: VPS recorded frames to disk during stream
  → Split into normal chunks → enter the chunk system
  → Available as VOD through standard chunk pull

Option B: Owner's device recorded locally
  → Owner publishes as a normal video (chunked upload)

Optimization: Subscribers who watched live already have the data locally.
  → They register those chunks with the index
  → VOD is instantly well-seeded without re-upload
```

### External Streaming Tools
- Owner can use external tools (OBS, etc.) via RTMP ingest to the VPS
- VPS re-encodes to encrypted stream frames and distributes
- Enables professional broadcasting setups

---

## 7. Permissions & Admin Model

### Roles

```
┌────────────┬──────────────────────────────────────────────────┐
│ Owner      │ Holds master Ed25519 private key. Can:           │
│            │  - Publish content                               │
│            │  - Appoint/remove admins                         │
│            │  - Rotate channel encryption key                 │
│            │  - Receive upstream (replies, votes)              │
│            │  - Publish deletion markers                      │
│            │  - Update channel manifest                       │
├────────────┼──────────────────────────────────────────────────┤
│ Admin      │ Holds delegated Ed25519 signing key. Can:        │
│            │  - Publish content (signed with their key)       │
│            │  - Receive upstream (if owner delegates)          │
│            │  - Cannot appoint other admins                   │
│            │  - Cannot rotate channel keys                    │
│            │  - Cannot modify the manifest                    │
├────────────┼──────────────────────────────────────────────────┤
│ Subscriber │ Holds channel decryption key only. Can:          │
│            │  - Read all broadcast content                    │
│            │  - Send upstream (replies, votes)                 │
│            │  - Seed chunks to other subscribers (blind)       │
│            │  - Cannot publish to channel                     │
│            │  - Cannot see other subscribers                  │
└────────────┴──────────────────────────────────────────────────┘
```

### Channel Manifest
The manifest is a signed chunk, broadcast like any content:

```json
{
  "channel_id": "<owner Ed25519 public key fingerprint>",
  "name": "<encrypted channel name>",
  "description": "<encrypted description>",
  "owner_key": "<owner Ed25519 public key>",
  "admin_keys": [
    { "key": "<admin1 Ed25519 pubkey>", "label": "encrypted_label" },
    { "key": "<admin2 Ed25519 pubkey>", "label": "encrypted_label" }
  ],
  "current_encrypt_key": "<X25519 public key for content encryption>",
  "key_epoch": 7,
  "rules": {
    "replies_enabled": true,
    "polls_enabled": true,
    "max_upstream_size": 4096
  },
  "signature": "<Ed25519 signature by owner_key over all above fields>"
}
```

### Subscriber Verification (Every Chunk, Every Time)

```
1. Check signature on chunk against author_pubkey        → authentic?
2. Check author_pubkey is in channel manifest             → authorized?
3. Check manifest is signed by owner_key                  → manifest legit?
4. Check owner_key matches locally stored key from subscribe time → trusted?
5. Decrypt payload with channel encryption key            → readable?

ANY step fails → reject chunk, do not display.
```

### Admin Lifecycle
- **Appoint**: owner adds admin's pubkey to manifest, signs new manifest, broadcasts
- **Remove**: owner removes admin's pubkey from manifest, signs new manifest, broadcasts
- Removed admin's past content remains valid (was correctly signed at the time)
- Removed admin cannot publish new content (clients reject — key not in current manifest)

### Member Removal & Key Rotation
- Owner publishes new manifest with rotated X25519 encryption key (new `key_epoch`)
- New key distributed to remaining subscribers via encrypted channel
- Removed member still has old chunks (cannot prevent — they're on their device)
- Removed member cannot decrypt any new content (doesn't have new key)
- Key rotation is cryptographic — no server enforcement needed

### Channel Ownership
- The owner's Ed25519 private key IS ownership
- No "transfer ownership" operation — key possession is absolute
- No "forgot password" recovery — no attack surface
- Owner's responsibility: back up the private key (encrypted export)
- If the private key is lost, the channel is dead — no recovery possible

---

## 8. Censorship Resistance

### Threat: VPS Blocks a Channel
The VPS sees `routing_hash` in plaintext headers (needed for DHT routing). A malicious VPS operator could refuse to route chunks for a specific hash.

### Mitigations

#### 1. Federation (Primary Defense)
- Anyone can run a VPS node and join the SWIM cluster
- If one VPS blocks a channel, client reconnects to another node
- No single operator controls the network

#### 2. Rotating Routing Hashes
The routing hash changes every epoch, derived from the channel secret:

```
routing_hash = HMAC(channel_secret, "epoch:2026-02-09T15")
```

- Changes every hour/day (configurable)
- Subscribers derive the same hash (they have the channel key)
- VPS sees a different opaque hash each epoch
- Cannot maintain a stable blocklist

#### 3. Indistinguishable Traffic
- Same chunk protocol used for P2P messages, channels, file transfers
- VPS cannot distinguish "block this channel" from "block this private conversation"
- All traffic looks like opaque encrypted chunks

#### 4. Self-Hosting
- Anyone can run a VPS node for their own channel
- Owner runs their own relay — no dependency on third-party operators
- Still federates with the wider network

---

## 9. Security Properties

### What the VPS Cannot Do

| Attack | Why It Fails |
|--------|-------------|
| Read any content | All payloads encrypted with channel key |
| Forge a message from owner/admin | Cannot sign — no private keys |
| Modify a chunk in transit | Signature verification fails at client |
| Add fake admins to a channel | Cannot sign manifest — only owner can |
| Identify which chunks form a message | Chunk-to-message mapping is encrypted |
| Correlate subscribers across channels | Rotating routing hashes, opaque peer IDs |

### What a Malicious Subscriber Cannot Do

| Attack | Why It Fails |
|--------|-------------|
| Impersonate admin/owner | Their key isn't in the manifest |
| Publish a fake manifest | Not signed by the owner's key |
| See other subscribers' IPs | All traffic through VPS relay |
| Identify other subscribers | VPS is the only intermediary |
| Modify content they relay | Signature verification fails |

### What a Malicious Admin Cannot Do

| Attack | Why It Fails |
|--------|-------------|
| Replace the owner | Owner key pinned on every subscriber's device |
| Add other admins | Cannot sign a new manifest |
| Rotate channel encryption keys | Only owner signs manifests |
| Continue posting after removal | Key removed from manifest, clients reject |

---

## 10. Mobile Background Sync

Peers need to serve chunks even when the app is backgrounded, since subscribers ARE the storage layer.

### Android
- **Foreground service** with persistent notification ("Zajel syncing")
- **WorkManager** for periodic chunk registration sync
- **FCM high-priority push** → wakes app → app responds to chunk requests

### iOS
- **Silent push notification** → wakes app for ~30 seconds → serve requested chunks
- **BGProcessingTask** → periodic sync of chunk index
- iOS will never allow persistent background connections — push-to-wake is the only option

### Fallback
If a peer doesn't respond within timeout:
- VPS tries next peer in the chunk index
- VPS disk cache covers the gap for popular/recent content
- Request queued until any source comes online

### Permissions Required
- **Background execution** (Android foreground service / iOS background modes)
- **Microphone** (audio messages, live audio streaming)
- **Camera** (video messages, live video streaming)
- **Storage** (chunk cache on device)
- **Network** (always needed)

---

## 11. Infrastructure & Cost

### VPS Servers (Existing Federation)
No new infrastructure type needed. The existing federated VPS servers gain:
- A new SQLite table for chunk index
- Temp disk storage with TTL cleanup
- New WebSocket message types for chunk push/pull/register
- Streaming relay logic

### Cost Model (Bare Metal VPS, e.g., Hetzner)

```
Per server: ~$50/month (2TB NVMe + 20TB bandwidth)

Channel with 1M subscribers, 50 messages/day @ 100KB each:
  Bandwidth: 50 × 100KB × 1M = 5TB/day = 150TB/month
  Servers needed: ~8 (for bandwidth)
  Cost: ~$400/month

Compared to R2:
  500M reads/day × $0.36/M = $5,400/month (13x more expensive)
```

Bare metal VPS wins at scale. Bandwidth + disk is cheap. Per-operation pricing is not.

### Scaling Strategy
- Add VPS nodes to the federation as load grows
- DHT automatically rebalances routing across new nodes
- SWIM gossip discovers new nodes
- Geographic distribution for latency (EU, US, Asia relay nodes)

---

## 12. Implementation Phases

### Phase 1: Channel Foundation
- Channel keypair generation (Ed25519 + X25519)
- Channel manifest creation and signing
- Chunk splitting, encryption, and signing
- Chunk index in VPS SQLite
- Basic chunk push/pull over existing WebSocket
- Temp disk cache with TTL cleanup on VPS
- Subscriber verification logic in Flutter client

### Phase 2: Swarm & Sync
- Subscribers register as chunk sources
- VPS relay logic (pull from peer → cache → serve)
- Multicast optimization (one pull, many serves)
- Chunk availability tracking (online/offline peers)
- Background sync (Android foreground service, iOS push-to-wake)

### Phase 3: Interactions
- Upstream channel (replies, votes routed to owner)
- Poll creation and vote aggregation
- Reply threading (reply_to references)
- Rate limiting on upstream messages

### Phase 4: Admin & Permissions
- Delegated admin signing keys
- Manifest updates (add/remove admin)
- Key rotation on member removal
- Permission rules in manifest

### Phase 5: Live Streaming
- Real-time stream relay through VPS (SFU mode)
- Post-live VOD conversion (frames → chunks)
- Subscribers who watched live auto-seed VOD chunks
- External streaming tool support (RTMP ingest)

### Phase 6: Groups
- Full mesh WebRTC for small groups (reuse existing P2P)
- Sender key encryption for group messages
- Vector clock sync protocol
- Group member management (join/leave/key rotation)

### Phase 7: Censorship Resistance
- Rotating routing hashes (epoch-based HMAC)
- Client-side detection of blocked channels
- Automatic fallback to alternative VPS nodes
- Self-hosting documentation and tooling

---

## 13. Open Questions

1. **Chunk size**: Fixed 64KB? Adaptive based on content type?
2. **TTL duration**: How long should VPS disk cache persist? 15 min? 1 hour? Configurable per channel?
3. **Max channel size**: Should there be a practical limit or let federation handle it?
4. **Chunk deduplication**: If owner re-sends same content, detect and skip?
5. **Message ordering**: Sequence numbers per channel sufficient, or need Lamport timestamps?
6. **Key backup**: Offer encrypted key export? To where? User's choice?
7. **Channel discovery**: Beyond out-of-band sharing, any in-network discovery mechanism?
8. **Monetization**: Can channel owners charge for subscriptions? Crypto payments?
9. **Content moderation**: How do admins handle reported content in upstream?
10. **Live stream latency**: Target latency for real-time relay? Sub-second? 2-3 seconds?
