# Plan 10: Stable Identity System

## Problem

The stable ID system (commit `c4ba8d1`) derives peer identity as `SHA256(publicKey)[0:16]`. This couples identity to key material — if FlutterSecureStorage corrupts and keys regenerate, the user loses their identity, all conversations, trusted peer records, meeting points, and group memberships.

Groups also use the ephemeral pairing code as `deviceId` for member identity, which is already broken — reconnecting with a new pairing code makes you a stranger in your own group.

## Goal

- Stable ID is the persistent identity anchor (like a phone number)
- Public key is a rotatable attribute underneath the stable ID
- Key rotation is transparent: same identity, new encryption key
- Stable ID doubles as the connection address (replace pairing codes as the user-facing mechanism)
- Seed phrase backup enables catastrophic recovery
- Encrypted local backup preserves messages across device loss

---

## Current Identity Architecture

### Five Identity Layers (Today)

| Layer | What | Scope | Storage | Server sees | Peer sees |
|-------|------|-------|---------|-------------|-----------|
| Pairing code | 6-char random | Per session | Memory | Yes | Yes (via server) |
| Stable ID | SHA256(pubKey)[0:16] | Derived | None (computed) | No | No |
| Public key | X25519 key | Persistent | FlutterSecureStorage | Yes (at register) | Yes (handshake) |
| Username | User-chosen string | Persistent | SharedPreferences | No | Yes (handshake) |
| Source ID | UUID per relay | Per relay session | Memory | No | Yes (relay only) |

### What Uses Each Identity

**Stable ID** (derived from publicKey) — storage anchor:
- `_peers` map in ConnectionManager
- TrustedPeersStorage records (`TrustedPeer.id`)
- MessageStorage SQLite (`peerId` column)
- `chatMessagesProvider` family key
- FileReceiveService transfers
- CryptoService `_sessionKeys` / `_peerPublicKeys` maps
- Meeting point derivation (via public keys)

**Public key** — crypto + blocking:
- ECDH session establishment
- Handshake verification
- `blockedPeersProvider` (blocks by publicKey)
- `isTrustedByPublicKey()` auto-accept
- Meeting point derivation (daily points)
- Channel ownership and admin authorization (Ed25519, separate key type)

**Pairing code (deviceId)** — group identity (BROKEN):
- `GroupMember.deviceId` — ephemeral pairing code as group member ID
- Sender key maps: `{deviceId: senderKey}`
- `Group.selfDeviceId` / `Group.createdBy`
- Group message `authorDeviceId`

---

## New Architecture

### Stable ID

- 16 hex chars (64 bits), randomly generated ONCE on first launch
- Stored in **SharedPreferences** (NOT FlutterSecureStorage — survives key corruption)
- Also backed up as 6-word seed phrase (BIP39-style, 64 bits)
- Migration: existing installs derive from current publicKey for backward compat
- Tag = first 4 chars of stableId (deterministic, key-independent)
- Base58 encoding for compact sharing: 11 chars

### Shareable Identity Formats

| Format | Example | Length | Use case |
|--------|---------|--------|----------|
| Username#TAG | `Alice#A1B2` | ~10 chars | Display in UI |
| Hex stableId | `A1B2C3D4E5F6G7H8` | 16 chars | Copy/paste |
| Base58 stableId | `3yMqoN7d2Ek` | 11 chars | Dictate over voice |
| Deep link | `zajel://c/A1B2C3D4E5F6G7H8` | 28 chars | QR code / click |
| Web link | `https://zajel.app/c/A1B2C3D4E5F6G7H8` | 38 chars | Share via messenger |
| With verification | `https://zajel.app/c/...?v=8f3a1b...` | ~70 chars | First-time TOFU |

### Connection Model (Replaces Pairing Codes)

**First connection**:
1. Alice shares stableId (QR / link / typing / verbal)
2. Bob's app derives meeting point: `SHA256(sorted(aliceStableId, bobStableId) + "zajel:pair:" + date)`
3. Both register at that meeting point on signaling server
4. Server matches them → exchanges ephemeral pairing codes internally
5. WebRTC connects using pairing codes (server never sees stableIds)
6. Handshake over E2E channel: `{publicKey, stableId, username}`
7. Both verify stableId matches → session established → saved as trusted peer

**Reconnection** (any future day):
- Both apps derive daily meeting points from stableIds (same mechanism)
- Server matches → WebRTC → handshake → connected
- No user action needed

**Key rotation**:
- Same stableId → same meeting points → same reconnection
- Handshake reveals new publicKey → peer auto-updates stored key
- Chat history preserved (keyed by stableId)

**Asynchronous**: Alice shares QR today, Bob scans tomorrow. They meet at the meeting point whenever both are online. No need to be simultaneously connected.

### Privacy Model

| Information | Who sees it |
|-------------|------------|
| stableId | Only connected peers (E2E encrypted WebRTC channel) |
| publicKey | Peers (handshake) + signaling server (registration) |
| username | Only connected peers (E2E handshake) |
| pairing code | Signaling server + paired peer (ephemeral, internal) |
| meeting point tokens | Signaling server (opaque SHA256 hashes only) |

The server **never** sees stableIds. It only sees opaque meeting point tokens. It can't tell which two users are connecting — just that two tokens matched.

---

## How Each Mechanism is Affected

### 1. P2P Connection (Signaling → WebRTC → Handshake)

**Before**: Server matches pairing codes → WebRTC → handshake sends publicKey → derive stableId from publicKey

**After**: Meeting point tokens replace manual pairing codes → server matches → WebRTC → handshake sends `{publicKey, stableId, username}` → stableId used directly as identity

Backward compat: old clients omit stableId in handshake → receiver falls back to `SHA256(publicKey)[0:16]`.

### 2. Reconnection (Meeting Points + Dead Drops)

**Before**: Daily points = `SHA256(sorted(myPubKey, peerPubKey) + "zajel:daily:" + date)` — breaks on key rotation

**After**: Daily points = `SHA256(sorted(utf8(myStableId), utf8(peerStableId)) + "zajel:daily:" + date)` — survives key rotation

Dead drops: encrypted with peer's current publicKey, contain `{publicKey, stableId, relayId, sourceId}`. Receiver verifies stableId matches known peer.

Migration: register at BOTH old-style (pubkey) and new-style (stableId) meeting points during transition.

### 3. Key Rotation Detection

When known stableId presents with different publicKey:
1. Log warning: `"Peer {stableId} rotated key"`
2. Update TrustedPeer.publicKey in storage
3. Re-establish ECDH session with new key
4. Chat history preserved (keyed by stableId)

TOFU model: first key associated with stableId is trusted. Future enhancement: Signal-style "safety number changed" UI warning.

### 4. Groups

**Before**: `GroupMember.deviceId` = ephemeral pairing code (already broken on reconnect)

**After**: `GroupMember.deviceId` = stableId (persistent across sessions and key rotations)
- Sender keys indexed by stableId
- Group invitations include stableId per member
- `Group.selfDeviceId` / `Group.createdBy` = stableId
- Message attribution by stableId

### 5. Channels

**No change needed**. Channels use Ed25519 public keys (separate key type from X25519 encryption keys). Channel identity is pure crypto — owner/admin ARE their Ed25519 signing keys. Not affected by X25519 key rotation.

### 6. Blocking

**Before**: Blocks by publicKey — bypassed if peer rotates key

**After**: Block by stableId (primary) — survives key rotation. Keep publicKey as secondary for old-client compat.

### 7. Username + Display

**Before**: TAG = `SHA256(publicKey)[0:4]` — changes on key rotation

**After**: TAG = `stableId[0:4]` — permanent. Identity: `Username#TAG` (e.g., `Alice#A1B2`).

---

## Seed Phrase Backup

The stableId is 64 bits — encodes as ~6 BIP39 words.

**Flow**:
1. First launch: generate stableId → derive seed phrase → show to user: "Write these words down"
2. Stored in SharedPreferences (primary) + app documents dir (redundant)
3. Recovery: user enters 6 words → stableId recovered → stored in SharedPreferences
4. New key pair generated → associated with recovered stableId
5. Reconnect to peers via stableId-based meeting points
6. Peers see key rotation, auto-update

**What seed phrase recovers**: identity (stableId), contacts (via meeting points), future messages

**What seed phrase does NOT recover**: local message history (stored in SQLite on device)

---

## Encrypted Message Backup

For recovering local message history after device loss.

**Approach**: Encrypted local backup (file-based)

1. **Backup creation**: Periodically (or on-demand) export MessageStorage SQLite + TrustedPeersStorage to a single encrypted file
2. **Encryption**: Derive backup key from seed phrase via HKDF: `HKDF(SHA256(seedWords), info="zajel:backup", salt=random)`
3. **Storage**: Written to app documents directory. User can copy to cloud storage, USB, etc.
4. **Restore**: Enter seed phrase → derive backup key → decrypt backup file → import messages + contacts

**Backup contents**:
- All messages (SQLite dump)
- Trusted peers (stableId, publicKey, username, alias, metadata)
- Group memberships + sender keys
- User preferences (username, settings)

**NOT backed up** (regenerated automatically):
- Session keys (re-established on reconnect)
- Pairing codes (ephemeral)
- Source IDs (per-relay)

---

## Security Analysis

| Threat | Mitigation |
|--------|-----------|
| Server tracks stableId | stableId NEVER sent to server — only in E2E channel |
| Relay sees stableId | Relay routes encrypted payloads — can't read stableId |
| Impersonation via stableId | Attacker needs private key for ECDH — stableId alone is useless |
| Key rotation MITM | TOFU model. Future: safety number warning UI |
| Block bypass via key rotation | Blocking by stableId — survives rotation |
| Old client interop | Fallback: `SHA256(publicKey)[0:16]` when no stableId in handshake |
| Seed phrase theft | Only recovers identity, not session keys. Attacker still needs to be at meeting points |
| Backup file theft | Encrypted with HKDF-derived key from seed phrase. 64-bit seed = brute-forceable with extreme effort; acceptable for local backup |
| Meeting point correlation | Server sees opaque tokens only. Can't derive stableIds from tokens (SHA256 preimage resistance) |

---

## Implementation Phases

### Phase 1: Stable ID Generation & Storage

**Files**:
- `packages/app/lib/core/crypto/crypto_service.dart`
- `packages/app/lib/core/constants.dart`
- `packages/app/lib/core/providers/app_providers.dart`

1. Add stableId generation, SharedPreferences persistence, migration from publicKey
2. Add `tagFromStableId()`, deprecate `tagFromPublicKey()` for identity use
3. Update `cryptoServiceProvider` to pass SharedPreferences
4. Update `userIdentityProvider` to use stableId-based tag

### Phase 2: Seed Phrase

**Files**:
- `packages/app/lib/core/crypto/seed_phrase.dart` (new)
- `packages/app/lib/features/settings/settings_screen.dart`

1. BIP39-style encoding/decoding of 64-bit stableId to ~6 words
2. Show seed phrase on first launch (or in Settings)
3. Recovery flow: enter words → restore stableId

### Phase 3: Extend Handshake Protocol

**Files**:
- `packages/app/lib/core/network/webrtc_service.dart`
- `packages/web-client/src/lib/webrtc.ts`
- `packages/web-client/src/lib/protocol.ts`
- `packages/headless-client/zajel/client.py`

1. Add `stableId` to handshake message across all three clients
2. Update `onHandshakeComplete` callback to pass stableId
3. Backward compat: missing stableId → fall back to derived ID

### Phase 4: ConnectionManager Uses Handshake stableId

**Files**:
- `packages/app/lib/core/network/connection_manager.dart`

1. Remove stableId derivation from `SignalingPairMatched`
2. Move identity resolution to `onHandshakeComplete` (use handshake stableId)
3. Key rotation detection: known stableId + new publicKey → update
4. Change auto-accept from `isTrustedByPublicKey` to `isTrusted(stableId)`

### Phase 5: StableId-Based Connection (Replace Pairing UX)

**Files**:
- `packages/app/lib/core/network/connection_manager.dart`
- `packages/app/lib/core/network/signaling_client.dart`
- `packages/app/lib/features/home/home_screen.dart`

1. "Add contact" flow: enter stableId (or scan QR / click link)
2. Derive meeting point from both stableIds
3. Register at meeting point → wait for match
4. Keep manual pairing code as fallback

### Phase 6: Meeting Points Use Stable IDs

**Files**:
- `packages/app/lib/core/network/meeting_point_service.dart`
- `packages/app/lib/core/network/peer_reconnection_service.dart`
- `packages/headless-client/zajel/crypto.py`

1. Add `deriveDailyPointsFromIds(myStableId, peerStableId)`
2. Update reconnection service to use stableId-based points
3. Migration: register at both old and new style points
4. Update Python headless client to match

### Phase 7: Groups Use Stable IDs

**Files**:
- `packages/app/lib/features/groups/models/group.dart`
- `packages/app/lib/features/groups/services/group_service.dart`
- `packages/app/lib/features/groups/services/group_crypto_service.dart`
- `packages/app/lib/features/groups/services/group_invitation_service.dart`

1. `GroupMember.deviceId` → populate with stableId
2. Sender keys indexed by stableId
3. Group invitations use stableId per member
4. Message attribution by stableId

### Phase 8: Update Blocking & Identity Display

**Files**:
- `packages/app/lib/core/providers/app_providers.dart`
- `packages/app/lib/core/utils/identity_utils.dart`

1. Blocking by stableId (primary) + publicKey (secondary/migration)
2. Tag from stableId in all display contexts
3. Remove deprecated `tagFromPublicKey` calls

### Phase 9: Encrypted Message Backup

**Files**:
- `packages/app/lib/core/storage/backup_service.dart` (new)
- `packages/app/lib/features/settings/settings_screen.dart`

1. Export: SQLite messages + trusted peers + groups → encrypted file
2. Encryption: HKDF from seed phrase
3. Import: decrypt → restore database
4. UI: backup/restore in Settings

### Phase 10: Tests

1. Stable ID generation, persistence, migration
2. Seed phrase encode/decode round-trip
3. Handshake with/without stableId (backward compat)
4. Key rotation detection
5. StableId-based meeting points
6. Encrypted backup round-trip
7. Web client + headless client interop

---

## Verification

1. `flutter test` — all existing + new tests pass
2. `npm run test:run --workspace=@zajel/web-client` — web tests pass
3. `flutter analyze` — no issues
4. Manual: clear FlutterSecureStorage → restart → stableId survives, new key, same identity
5. Manual: old client (no stableId in handshake) → backward compat works
6. Manual: share QR code → scan on second device → connected via stableId meeting point
7. Manual: enter seed phrase on new device → identity recovered → peers reconnect
8. Manual: backup → wipe → restore from backup → messages recovered
