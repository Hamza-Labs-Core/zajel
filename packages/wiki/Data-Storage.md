# Data Storage

Zajel uses three storage layers on the client device: SQLite for structured data, FlutterSecureStorage for cryptographic keys, and SharedPreferences for user settings.

---

## Storage Architecture

| Layer | Technology | What it stores | Encryption |
|-------|-----------|----------------|-----------|
| SQLite | `sqflite` | Messages, channels, chunks, groups, vector clocks | Not encrypted at rest |
| Secure Storage | `flutter_secure_storage` | Private keys, session keys, sender keys | Platform keychain/keystore |
| Preferences | `SharedPreferences` | Settings, display name, device selections | Not encrypted |
| File System | Platform file system | Received files, log files | Not encrypted |

---

## SQLite Tables

### Messages Table (1:1 Chat)

Stores per-peer message history.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID message identifier |
| peerId | TEXT | Peer this message belongs to |
| type | TEXT | "text" or "file" |
| content | TEXT | Message text or file metadata |
| status | TEXT | pending, sending, sent, delivered, read, failed |
| isFromMe | INTEGER | 1 if sent by local user, 0 if received |
| timestamp | INTEGER | Unix timestamp (milliseconds) |
| attachmentName | TEXT | File name (nullable) |
| attachmentSize | INTEGER | File size in bytes (nullable) |
| attachmentPath | TEXT | Local file path (nullable) |

**Indexes**: `peerId`, `timestamp`

### Channels Table

Stores channel metadata and role information.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Channel ID (128-bit hex) |
| role | TEXT | owner, admin, subscriber |
| manifestJson | TEXT | Serialized channel manifest (JSON) |
| createdAt | INTEGER | Creation timestamp |
| updatedAt | INTEGER | Last update timestamp |

### Chunks Table

Stores channel content chunks indexed for efficient retrieval.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Chunk identifier |
| channelId | TEXT FK | Parent channel |
| sequence | INTEGER | Message sequence number |
| chunkIndex | INTEGER | Index within multi-chunk message |
| totalChunks | INTEGER | Total chunks for this message |
| routingHash | TEXT | Current routing hash for DHT |
| authorPubkey | TEXT | Author's Ed25519 public key |
| signature | TEXT | Ed25519 signature (base64) |
| encryptedPayload | BLOB | Encrypted chunk data |

**Indexes**: `channelId`, `(channelId, sequence)`, `routingHash`

### Groups Table

Stores group metadata.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID group identifier |
| name | TEXT | Group display name |
| membersJson | TEXT | Serialized members list (JSON) |
| creatorDeviceId | TEXT | Creator's device ID |
| createdAt | INTEGER | Creation timestamp |
| updatedAt | INTEGER | Last update timestamp |

### Group Messages Table

Stores group chat messages with composite key for deduplication.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID message identifier |
| groupId | TEXT FK | Parent group |
| authorDeviceId | TEXT | Sender's device ID |
| sequenceNumber | INTEGER | Per-device sequence number |
| type | TEXT | text, file, image, system |
| content | TEXT | Message content |
| metadata | TEXT | Additional metadata (JSON) |
| status | TEXT | pending, sent, delivered, failed |
| timestamp | INTEGER | Send timestamp |

**Unique constraint**: `(groupId, authorDeviceId, sequenceNumber)`

### Vector Clocks Table

Stores causal ordering state per group.

| Column | Type | Description |
|--------|------|-------------|
| groupId | TEXT PK | Parent group |
| clockJson | TEXT | Serialized vector clock `{deviceId: sequence}` |
| updatedAt | INTEGER | Last update timestamp |

---

## Secure Storage

Cryptographic keys are stored in platform-specific secure storage (iOS Keychain, Android EncryptedSharedPreferences, macOS Keychain, Linux libsecret, Windows Credential Locker).

### Key Namespace Conventions

| Key Pattern | Description |
|-------------|-------------|
| `zajel_key_private` | X25519 identity private key (base64) |
| `zajel_session_{peerId}` | Session key for a specific peer (base64) |
| `trusted_peer_{peerId}` | Trusted peer public key (base64) |
| `channel_signing_{channelId}` | Channel Ed25519 signing private key |
| `channel_encryption_{channelId}` | Channel X25519 encryption private key |
| `group_{groupId}_device_{deviceId}` | Group sender key for a member |

### Security Properties

- On Android, `EncryptedSharedPreferences` is used (requires API 23+)
- On iOS/macOS, the system Keychain is used with app-specific access groups
- Keys are never written to unencrypted storage or logs
- Keys are cleared on explicit logout/reset

---

## SharedPreferences

Non-sensitive user settings are stored in SharedPreferences:

| Key | Type | Description |
|-----|------|-------------|
| Display name | String | User's chosen display name |
| Audio input device | String | Selected microphone device ID |
| Audio output device | String | Selected speaker device ID |
| Video input device | String | Selected camera device ID |
| Noise suppression | bool | Audio noise suppression enabled |
| Echo cancellation | bool | Audio echo cancellation enabled |
| Auto gain control | bool | Automatic gain control enabled |
| Background blur | bool | Video background blur enabled |
| DND enabled | bool | Do-not-disturb mode |
| Notification sound | bool | Notification sound enabled |
| Notification preview | bool | Show message preview in notifications |
| Onboarding complete | bool | Whether onboarding has been shown |

---

## Data Lifecycle

### Message Retention

- Messages persist indefinitely by default
- Users can manually delete individual conversations (removes all messages for that peer)
- Age-based cleanup is available but not enabled by default

### Channel Content

- Chunks persist locally as long as the channel subscription exists
- Unsubscribing removes all local chunks for that channel
- Background sync keeps channels up to date

### Group Data

- Group messages persist until the group is deleted
- Deleting a group cascades: removes messages, vector clocks, and sender keys
- Sender keys are rotated on member departure (old keys remain for decrypting old messages)

### Cleanup Operations

| Operation | What it removes |
|-----------|----------------|
| Delete conversation | All messages for a specific peer |
| Remove contact | Peer metadata + messages + session key |
| Unsubscribe channel | Channel record + all chunks |
| Delete group | Group + messages + vector clocks + sender keys |
| Full database wipe | All SQLite data (secure storage keys remain) |
| Clear all sessions | All session keys from secure storage |

---

## Trusted Peer Storage

Trusted peers (paired contacts) have dedicated secure storage:

| Data | Storage | Description |
|------|---------|-------------|
| Public key | Secure storage | X25519 public key for identity verification |
| Display name | Secure storage | Peer's self-reported name |
| Alias | Secure storage | User-assigned nickname |
| Last seen | Secure storage | Timestamp of last connection |
| Notes | Secure storage | Optional user notes |
| Blocked | Secure storage | Block status flag |

### Peer Lookup

Peers can be looked up by:
- Peer ID (pairing code-derived identifier)
- Public key (for migration detection when peer ID changes)

---

## Migration Strategy

### Trusted Peer Migration

When a trusted peer reconnects with a new pairing code (e.g., after app reinstall):

1. The new connection reveals a known public key
2. Message history is migrated from the old peer ID to the new one
3. The old peer record is removed
4. The new peer inherits the conversation history

### Database Schema

Database tables are created on first launch. Schema changes are handled by:
1. Checking table existence before creation
2. Adding new columns with `ALTER TABLE` when needed
3. All schema changes are additive (no destructive migrations)

---

## Log Files

The logging service writes daily rotating log files:

| Property | Value |
|----------|-------|
| Format | Text with timestamp, level, source, message |
| Rotation | Daily (new file each day) |
| Size limit | 5MB per file |
| Retention | 7 days |
| Export | Via share sheet or directory export |
| Real-time | Stream controller for live monitoring |
| Levels | debug, info, warning, error |

---

## Security Hardening

### Session Key Encryption at Rest

Session keys stored in the peer storage database (SQLite) are now encrypted before being written:

1. A **device-local master key** is generated on first launch and stored in platform secure storage (iOS Keychain, Android Keystore, etc.)
2. Each session key is encrypted with **ChaCha20-Poly1305** using the master key before being written to the `zajel_session_{peerId}` field in SQLite
3. On read, the session key is decrypted in memory and used for message encryption/decryption
4. The master key never leaves secure storage and is never written to SQLite or logs

This provides defense-in-depth: even if the SQLite database file is exfiltrated (e.g., via a backup or filesystem access), the session keys are not directly usable without the platform-specific master key.

| Component | Storage | Encryption |
|-----------|---------|------------|
| Master key | Platform secure storage | Platform keychain/keystore |
| Session keys | SQLite (encrypted) | ChaCha20-Poly1305 with master key |
| Identity private key | Platform secure storage | Platform keychain/keystore |
| Sender keys | Platform secure storage | Platform keychain/keystore |

### Bounded Storage with Eviction

Storage for chunks and messages is bounded to prevent unbounded disk growth:

#### Channel Chunks

| Property | Value |
|----------|-------|
| Maximum chunks per channel | 1,000 |
| Eviction policy | Oldest-sequence-first |
| Trigger | On insert when count exceeds limit |

When a new chunk is stored and the per-channel count exceeds 1,000, the chunks with the lowest sequence numbers are deleted. This keeps the most recent content available while bounding storage.

#### Group Messages

| Property | Value |
|----------|-------|
| Maximum messages per group | 5,000 |
| Eviction policy | Oldest-timestamp-first |
| Trigger | On insert when count exceeds limit |

When a new group message is stored and the per-group count exceeds 5,000, the oldest messages (by timestamp) are deleted. The eviction threshold is set high enough to retain sufficient history for vector clock synchronization and gap-fill operations.

#### Eviction Implementation

Eviction is performed within the same database transaction as the insert to prevent race conditions:

```sql
-- Example: chunk eviction within a transaction
BEGIN;
INSERT INTO chunks (...) VALUES (...);
DELETE FROM chunks
  WHERE channelId = ?
  AND id NOT IN (
    SELECT id FROM chunks
    WHERE channelId = ?
    ORDER BY sequence DESC
    LIMIT 1000
  );
COMMIT;
```

### Stale Server Batch Cleanup

The server registry cleanup process (removing servers that have not sent a heartbeat within the TTL window) now uses **batch deletion** instead of sequential per-server deletion:

1. All expired server IDs are collected in a single query
2. Expired entries are deleted in a single batch operation
3. This reduces the number of storage operations from O(N) to O(1) for N expired servers

Previously, each expired server was deleted with a separate `await storage.delete(id)` call, which was both slow and prone to partial failures. The batch approach is atomic and significantly faster for large numbers of stale entries.
