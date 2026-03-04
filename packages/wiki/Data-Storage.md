# Data Storage

Zajel uses three storage layers on the client device: SQLite for structured data, FlutterSecureStorage for cryptographic keys, and SharedPreferences for user settings. Server-side, a D1 database stores aggregated diagnostic metrics shared between the diagnostics and admin workers.

---

## Storage Architecture

### Client-Side Storage

| Layer | Technology | What it stores | Encryption |
|-------|-----------|----------------|-----------|
| SQLite | `sqflite` (mobile), `sqflite_common_ffi` (desktop) | Messages, channels, chunks, groups, vector clocks | Not encrypted at rest |
| Secure Storage | `flutter_secure_storage` | Private keys, session keys, sender keys | Platform keychain/keystore |
| Preferences | `SharedPreferences` | Settings, display name, device selections | Not encrypted |
| File System | Platform file system | Received files, log files | Not encrypted |

### Server-Side Storage (Diagnostics)

| Layer | Technology | What it stores |
|-------|-----------|----------------|
| D1 (SQLite) | Cloudflare D1 | Aggregated error, performance, network, server metrics, heartbeats |
| R2 | Cloudflare R2 | Raw diagnostic report JSON files |
| KV | Cloudflare KV | Per-session rate limiting state, dashboard counters |

---

## SQLite Tables

### Messages Table (1:1 Chat)

Stores per-peer message history.

| Column | Type | Description |
|--------|------|-------------|
| localId | TEXT PK | UUID message identifier |
| peerId | TEXT | Peer this message belongs to |
| type | TEXT | "text" or "file" |
| content | TEXT | Message text or file metadata |
| status | TEXT | pending, sending, sent, delivered, read, failed |
| isOutgoing | INTEGER | 1 if sent by local user, 0 if received |
| timestamp | TEXT | ISO 8601 timestamp string |
| attachmentName | TEXT | File name (nullable) |
| attachmentSize | INTEGER | File size in bytes (nullable) |
| attachmentPath | TEXT | Local file path (nullable) |

**Indexes**: `peerId`, `(peerId, timestamp)`

### Channels Table

Stores channel metadata and role information.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Channel ID (128-bit hex) |
| role | TEXT | owner, admin, subscriber |
| manifest | TEXT | Serialized channel manifest (JSON) |
| encryption_key_public | TEXT | Channel encryption public key |
| created_at | TEXT | Creation timestamp |

### Chunks Table

Stores channel content chunks indexed for efficient retrieval.

| Column | Type | Description |
|--------|------|-------------|
| chunk_id | TEXT | Chunk identifier |
| channel_id | TEXT | Parent channel |
| routing_hash | TEXT | Current routing hash for DHT |
| sequence | INTEGER | Message sequence number |
| chunk_index | INTEGER | Index within multi-chunk message |
| total_chunks | INTEGER | Total chunks for this message |
| size | INTEGER | Chunk payload size in bytes |
| signature | TEXT | Ed25519 signature (base64) |
| author_pubkey | TEXT | Author's Ed25519 public key |
| encrypted_payload | BLOB | Encrypted chunk data |

**Primary key**: `(chunk_id, channel_id)`

**Indexes**: `channel_id`, `(channel_id, sequence)`, `(routing_hash, channel_id)`

**Pagination queries**:
- `getChunksForLatestSequences(channelId, {int limit = 50, int? beforeSequence})` — Two-phase query: (1) get the `limit` most recent distinct sequence numbers (optionally before `beforeSequence`), (2) fetch all chunks for those sequences. Used by `ChannelMessagesNotifier` for sequence-based pagination.

### Groups Table

Stores group metadata.

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID group identifier |
| name | TEXT | Group display name |
| self_device_id | TEXT | Local device's ID within this group |
| members | TEXT | Serialized members list (JSON) |
| created_at | TEXT | Creation timestamp |
| created_by | TEXT | Creator's device ID |

### Group Messages Table

Stores group chat messages with composite key for deduplication.

| Column | Type | Description |
|--------|------|-------------|
| group_id | TEXT | Parent group |
| author_device_id | TEXT | Sender's device ID |
| sequence_number | INTEGER | Per-device sequence number |
| type | TEXT | text, file, image, system |
| content | TEXT | Message content |
| metadata | TEXT | Additional metadata (JSON, default '{}') |
| timestamp | TEXT | Send timestamp (ISO 8601) |
| status | TEXT | pending, sent, delivered, failed (default 'delivered') |
| is_outgoing | INTEGER | 1 if sent by local user, 0 if received (default 0) |

**Primary key**: `(group_id, author_device_id, sequence_number)`

**Pagination queries**:
- `getLatestMessages(groupId, {int limit = 50, int offset = 0})` — Returns the `limit` most recent messages ordered by timestamp DESC, skipping `offset` rows. Used by `GroupMessagesNotifier` for offset-based pagination.

### Vector Clocks Table

Stores causal ordering state per group. Each device's sequence number is stored as an individual row rather than a single JSON blob, enabling efficient per-device queries and atomic updates via batch operations.

| Column | Type | Description |
|--------|------|-------------|
| group_id | TEXT | Parent group |
| device_id | TEXT | Device identifier |
| sequence_number | INTEGER | Last known sequence number for this device (default 0) |

**Primary key**: `(group_id, device_id)`

---

## D1 Diagnostics Database (Server-Side)

The diagnostics D1 database (`zajel-diagnostics`) is shared between the diagnostics worker (writes) and the admin worker (reads). It contains six tables for aggregated metrics and security events.

### Error Aggregates Table

Stores hourly-bucketed error counts grouped by signature, version, and platform.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment row ID |
| time_bucket | TEXT | Hour bucket as ISO datetime (e.g., `2026-03-03T14:00:00Z`) |
| error_signature | TEXT | Unique error signature for deduplication |
| category | TEXT | Error category: crash, network, crypto, storage, ui, protocol, other |
| app_version | TEXT | App version (semver) |
| platform | TEXT | Platform: android, ios, windows, macos, linux, web |
| count | INTEGER | Occurrence count within this bucket |
| first_seen | INTEGER | Unix timestamp of first occurrence |
| last_seen | INTEGER | Unix timestamp of last occurrence |
| sample_message | TEXT | Most recent error message sample |
| sample_stack_trace | TEXT | Most recent stack trace sample (nullable) |

**Unique constraint**: `(time_bucket, error_signature, app_version, platform)`

### Performance Aggregates Table

Stores hourly-bucketed performance percentiles (p50/p95/p99) per metric, platform, and version.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment row ID |
| time_bucket | TEXT | Hour bucket as ISO datetime |
| platform | TEXT | Platform identifier |
| app_version | TEXT | App version (semver) |
| metric_name | TEXT | Metric name: startupTimeMs, frameRateAvg, frameRateP95, memoryUsageMb, memoryPeakMb |
| p50 | REAL | 50th percentile value |
| p95 | REAL | 95th percentile value |
| p99 | REAL | 99th percentile value |
| sample_count | INTEGER | Number of samples aggregated |

**Unique constraint**: `(time_bucket, platform, app_version, metric_name)`

### Network Aggregates Table

Stores hourly-bucketed network success/failure counts for signaling and WebRTC connections.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment row ID |
| time_bucket | TEXT | Hour bucket as ISO datetime |
| platform | TEXT | Platform identifier |
| app_version | TEXT | App version (semver) |
| signaling_success_count | INTEGER | Successful signaling connections |
| signaling_failure_count | INTEGER | Failed signaling connections |
| webrtc_success_count | INTEGER | Successful WebRTC connections |
| webrtc_failure_count | INTEGER | Failed WebRTC connections |
| relay_usage_count | INTEGER | Connections using relay |
| direct_p2p_count | INTEGER | Connections using direct P2P |
| avg_latency_ms | REAL | Weighted average latency (nullable) |
| sample_count | INTEGER | Number of reports aggregated |

**Unique constraint**: `(time_bucket, platform, app_version)`

### Server Metrics Table

Stores time-series metrics from VPS server pushes. Each push creates one row.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment row ID |
| server_id | TEXT | VPS server identifier |
| region | TEXT | Server region (nullable) |
| timestamp | INTEGER | Unix timestamp in milliseconds |
| connections_total | INTEGER | Total active connections |
| connections_relay | INTEGER | Active relay connections |
| connections_signaling | INTEGER | Active signaling connections |
| entropy_active_codes | INTEGER | Active pairing codes (nullable) |
| entropy_collision_risk | TEXT | Collision risk level (nullable) |
| federation_alive_members | INTEGER | Alive federation members (nullable) |
| federation_total_members | INTEGER | Total federation members (nullable) |
| message_rate_per_second | REAL | Messages per second (nullable) |
| message_rate_per_minute | REAL | Messages per minute (nullable) |
| cpu_percent | REAL | CPU usage percentage (nullable) |
| memory_mb | REAL | Memory usage in MB (nullable) |
| uptime_seconds | INTEGER | Server uptime (nullable) |
| gossip_rtt_p50_ms | REAL | SWIM gossip RTT p50 in ms (nullable) |
| gossip_rtt_p95_ms | REAL | SWIM gossip RTT p95 in ms (nullable) |
| gossip_rtt_p99_ms | REAL | SWIM gossip RTT p99 in ms (nullable) |
| gossip_ping_count | INTEGER | Total gossip pings (default 0) |

**Index**: `(server_id, timestamp DESC)` for efficient latest-per-server queries

Rows older than 7 days are cleaned up automatically on each server metrics push.

### Client Heartbeats Table

Stores the latest heartbeat per anonymous client session.

| Column | Type | Description |
|--------|------|-------------|
| session_hash | TEXT PK | SHA-256 session identifier (64 hex chars) |
| platform | TEXT | Platform identifier |
| app_version | TEXT | App version (semver) |
| connection_type | TEXT | Connection type (nullable) |
| region | TEXT | Cloudflare colo or CF-IPCountry (nullable) |
| last_seen | INTEGER | Unix timestamp of last heartbeat |
| session_start | INTEGER | Unix timestamp of first heartbeat |

### Security Events Table

Stores security-related events including rate limit violations, connection spikes, bad client detections, and brute force pairing attempts. Written by the diagnostics worker and read by the admin worker's Epic 7 security monitoring endpoints.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment row ID |
| event_type | TEXT NOT NULL | Event category: `rate_limit_violation`, `connection_spike`, `bad_client`, `brute_force_attempt` |
| timestamp | INTEGER NOT NULL | Unix timestamp in milliseconds |
| server_id | TEXT | VPS server identifier (nullable) |
| region | TEXT | Server or client region (nullable) |
| source_ip | TEXT | Hashed or anonymized IP address (nullable) |
| endpoint | TEXT | Target endpoint path, e.g., `/diagnostics/report`, `/pair` (nullable) |
| details | TEXT | JSON blob with event-specific data (nullable) |
| severity | TEXT NOT NULL | Severity level: `low`, `medium`, `high`, `critical` (default `medium`) |
| count | INTEGER NOT NULL | Occurrence count for this event (default 1) |

**Indexes**:
- `(event_type, timestamp DESC)` for filtering by event type with recency ordering
- `(timestamp DESC)` for global time-range queries
- `(event_type, timestamp, source_ip)` for per-client aggregation within a time range

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

### Session Key Storage

Session keys are stored directly in **FlutterSecureStorage** (platform keychain/keystore), not in SQLite. Each session key is written as a base64-encoded string under the key `zajel_session_{peerId}`.

On read, the `CryptoService` first checks an in-memory cache (`_sessionKeys` map). If the key is not in memory, it attempts to load from secure storage. This avoids repeated platform channel calls while ensuring keys survive app restarts.

| Component | Storage | Encryption |
|-----------|---------|------------|
| Identity private key | Platform secure storage (`zajel_key_private`) | Platform keychain/keystore |
| Session keys | Platform secure storage (`zajel_session_{peerId}`) | Platform keychain/keystore |
| Sender keys | Platform secure storage (`zajel_group_{groupId}_sender_{deviceId}`) | Platform keychain/keystore |
| Channel signing keys | Platform secure storage (`zajel_channel_{channelId}_signing_private`) | Platform keychain/keystore |
| Channel encryption keys | Platform secure storage (`zajel_channel_{channelId}_encryption_private`) | Platform keychain/keystore |

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
  WHERE channel_id = ?
  AND chunk_id NOT IN (
    SELECT chunk_id FROM chunks
    WHERE channel_id = ?
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
