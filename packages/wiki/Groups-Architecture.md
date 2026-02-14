# Groups Architecture

Groups provide multi-party encrypted chat using sender key encryption and vector clock-based causal ordering. Group communication is relayed over existing 1:1 peer-to-peer connections.

---

## Group Mesh Topology

```mermaid
graph TD
    subgraph "Group: Team Chat"
        A[Alice<br/>Creator]
        B[Bob]
        C[Carol]
        D[Dave]
    end

    A -- "1:1 E2E channel" --> B
    A -- "1:1 E2E channel" --> C
    A -- "1:1 E2E channel" --> D
    B -- "1:1 E2E channel" --> C
    B -- "1:1 E2E channel" --> D
    C -- "1:1 E2E channel" --> D

    style A fill:#4f46e5,color:#fff
    style B fill:#059669,color:#fff
    style C fill:#059669,color:#fff
    style D fill:#059669,color:#fff
```

Groups form a full mesh of N*(N-1)/2 pairwise connections. Each edge is an existing 1:1 encrypted WebRTC data channel. Group messages are broadcast to all connected members over these channels.

---

## Sender Key Encryption

Groups use a sender key scheme for efficient encryption:

```mermaid
sequenceDiagram
    participant Alice as Alice (Creator)
    participant Bob as Bob
    participant Carol as Carol

    Note over Alice: Create group<br/>Generate sender key (32 bytes)

    Alice->>Bob: Invitation (over 1:1 E2E channel)<br/>Group metadata + Alice's sender key
    Alice->>Carol: Invitation (over 1:1 E2E channel)<br/>Group metadata + Alice's sender key

    Note over Bob: Generate own sender key
    Bob->>Alice: Bob's sender key (over 1:1 E2E)
    Bob->>Carol: Bob's sender key (over 1:1 E2E)

    Note over Carol: Generate own sender key
    Carol->>Alice: Carol's sender key (over 1:1 E2E)
    Carol->>Bob: Carol's sender key (over 1:1 E2E)

    Note over Alice,Carol: All members hold all sender keys

    Alice->>Bob: Encrypt(msg, Alice's sender key)
    Alice->>Carol: Encrypt(msg, Alice's sender key)
    Note over Bob: Decrypt with Alice's sender key
    Note over Carol: Decrypt with Alice's sender key
```

### Why Sender Keys?

- **O(1) encrypt**: The sender encrypts once with their own key
- **O(1) decrypt**: Each recipient decrypts with the sender's key (already cached)
- **No N-way encryption**: Unlike pairwise encryption which requires O(N) encryptions per message

### Key Properties

| Property | Value |
|----------|-------|
| Key size | 32 bytes (256-bit) |
| Algorithm | ChaCha20-Poly1305 AEAD |
| Nonce | 12 bytes, random per message |
| Output format | nonce (12) + ciphertext + MAC (16) |
| Key storage | FlutterSecureStorage with group/device namespacing |
| In-memory cache | `{groupId: {deviceId: SecretKey}}` |

---

## Group Message Flow

```mermaid
sequenceDiagram
    participant Alice as Alice
    participant GS as GroupService
    participant GCS as GroupCryptoService
    participant GSS as GroupStorageService
    participant P2P as 1:1 P2P Channels
    participant Bob as Bob
    participant Carol as Carol

    Alice->>GS: sendMessage("Hello team")
    GS->>GSS: getNextSequence(groupId, aliceDeviceId)
    GSS-->>GS: sequence: 5
    GS->>GCS: encrypt(payload, groupId, aliceDeviceId)
    GCS-->>GS: encrypted bytes
    GS->>GSS: saveMessage(groupMessage)
    GS->>P2P: broadcast(encrypted, groupId)
    P2P->>Bob: base64(encrypted) via 1:1 channel
    P2P->>Carol: base64(encrypted) via 1:1 channel

    Note over Bob: Receive via 1:1 channel
    Bob->>GCS: decrypt(encrypted, groupId, aliceDeviceId)
    GCS-->>Bob: plaintext
    Bob->>GSS: saveMessage(groupMessage)
    Bob->>GSS: updateVectorClock(groupId)
```

---

## Vector Clock-Based Causal Ordering

Each group maintains a vector clock tracking per-device sequence numbers. This enables:

- **Causal ordering**: Messages are displayed in the order they were sent
- **Gap detection**: Missing messages are identified for sync
- **Deduplication**: Duplicate messages (from retransmission) are detected and ignored

### Vector Clock Structure

```
VectorClock: {
  "alice_device_id": 5,
  "bob_device_id": 3,
  "carol_device_id": 7
}
```

### Operations

| Operation | Description |
|-----------|-------------|
| `increment(deviceId)` | Increment the counter for a device when it sends a message |
| `merge(otherClock)` | Take the element-wise maximum of two clocks |
| `compare(otherClock)` | Returns: before, after, concurrent, or equal |
| `gaps(otherClock)` | List devices with missing sequence ranges |

### Sync Algorithm

1. Exchange vector clocks between peers
2. Compute missing messages by comparing clocks
3. Fetch missing messages from storage
4. Apply messages in causal order with deduplication

---

## Group Invitation Flow

```mermaid
sequenceDiagram
    participant Alice as Alice (Creator)
    participant P2P as 1:1 E2E Channel
    participant Bob as Bob (Invitee)

    Alice->>P2P: Send invitation message<br/>Prefix: "GROUP_INVITE:"<br/>Payload: JSON {<br/>  groupId, name, members,<br/>  senderKeys: {deviceId: key, ...}<br/>}

    P2P->>Bob: Receive invitation

    Note over Bob: Parse invitation<br/>Create local group<br/>Import all sender keys

    Bob->>Bob: Generate own sender key
    Bob->>P2P: Send sender key to all<br/>existing members
    P2P->>Alice: Bob's sender key

    Note over Alice: Import Bob's sender key<br/>Update group members
```

### Invitation Payload

The invitation contains:
- Group ID (UUID)
- Group name
- Members list (device IDs, display names, public keys)
- All current sender keys `{deviceId: base64Key}`
- Creator info

---

## Key Rotation on Member Departure

When a member leaves (or is removed):

1. The departed member's sender key is removed from all remaining members
2. Each remaining member generates a new sender key
3. New sender keys are distributed to all remaining members via 1:1 channels
4. The old sender keys are invalidated

This ensures:
- The departed member cannot decrypt future messages
- Forward secrecy is maintained for new conversations

---

## Group Connection Service

The `GroupConnectionService` manages the WebRTC mesh:

### Activation
When a user opens a group, the service:
1. Looks up all group members
2. Establishes WebRTC data channels to each member (via existing 1:1 connections)
3. Tracks connection state per member

### Broadcasting
When sending a group message:
1. The encrypted message is base64-encoded
2. Sent to all connected members via their 1:1 data channels
3. Members who are offline will sync later via vector clock comparison

### State Tracking

| Query | Description |
|-------|-------------|
| `getConnectionState(memberId)` | Connection state for a specific member |
| `getConnectedCount(groupId)` | Number of currently connected members |
| `isFullyConnected(groupId)` | Whether all members are connected |
| `getGroupConnections(groupId)` | Map of all member connection states |

---

## Data Model

### Group

| Field | Type | Description |
|-------|------|-------------|
| id | String (UUID) | Unique group identifier |
| name | String | Display name |
| members | List\<GroupMember\> | All group members |
| creatorDeviceId | String | Device ID of the creator |
| createdAt | DateTime | Creation timestamp |
| updatedAt | DateTime | Last modification timestamp |

### GroupMessage

| Field | Type | Description |
|-------|------|-------------|
| id | String (UUID) | Unique message identifier |
| groupId | String | Parent group ID |
| authorDeviceId | String | Sender's device ID |
| sequenceNumber | int | Per-device sequence number |
| type | Enum | text, file, image, system |
| content | String | Message text or file path |
| status | Enum | pending, sent, delivered, failed |
| timestamp | DateTime | Send timestamp |

### Storage

Messages are stored in SQLite with a composite key of `(group_id, author_device_id, sequence_number)` for deduplication. Vector clocks are persisted per group. Sender keys are stored in FlutterSecureStorage with `group_{groupId}_device_{deviceId}` namespacing.
