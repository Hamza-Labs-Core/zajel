# App - Groups Features

## Screens

### Groups List Screen
- **Location**: `packages/app/lib/features/groups/groups_list_screen.dart:L1-135`
- **Description**: Displays list of all groups with create and view group creation dialog UI

### Group Detail Screen
- **Location**: `packages/app/lib/features/groups/group_detail_screen.dart:L1-471`
- **Description**: Shows group chat messages, members, and compose bar for sending messages with add/view member actions

## Models

### Group
- **Location**: `packages/app/lib/features/groups/models/group.dart:L66-164`
- **Description**: Core group entity with ID, name, members list, creator info, and metadata; includes self/other member filtering

### GroupMember
- **Location**: `packages/app/lib/features/groups/models/group.dart:L6-56`
- **Description**: Group member model with device ID, display name, public key, and join timestamp

### GroupMessage
- **Location**: `packages/app/lib/features/groups/models/group_message.dart:L36-190`
- **Description**: Message model with type, content, metadata, timestamp, status, author tracking, and serialization for storage/encryption

### GroupMessageType
- **Location**: `packages/app/lib/features/groups/models/group_message.dart:L7-18`
- **Description**: Enum for message types (text, file, image, system) with string conversion

### GroupMessageStatus
- **Location**: `packages/app/lib/features/groups/models/group_message.dart:L21-34`
- **Description**: Enum for message delivery status (pending, sent, delivered, failed)

### VectorClock
- **Location**: `packages/app/lib/features/groups/models/vector_clock.dart:L10-135`
- **Description**: Vector clock for causal ordering tracking per-device sequence numbers with merge, comparison, and gap detection

## Services

### GroupService
- **Location**: `packages/app/lib/features/groups/services/group_service.dart:L1-383`
- **Description**: High-level orchestration service for group operations (create, join, leave, send/receive messages, sync)

### Group Creation
- **Location**: `packages/app/lib/features/groups/services/group_service.dart:L42-89`
- **Description**: Creates new group with UUID, adds creator as first member, generates sender key, and persists

### Member Management
- **Location**: `packages/app/lib/features/groups/services/group_service.dart:L95-214`
- **Description**: Add/remove members, accept invitations, rotate keys for forward secrecy after member departure

### Group Messaging
- **Location**: `packages/app/lib/features/groups/services/group_service.dart:L220-298`
- **Description**: Send and receive encrypted messages with sender key encryption and deduplication via vector clocks

### Group Sync
- **Location**: `packages/app/lib/features/groups/services/group_service.dart:L304-325`
- **Description**: Vector clock-based sync (get clock, compute missing messages, apply batch)

### GroupCryptoService
- **Location**: `packages/app/lib/features/groups/services/group_crypto_service.dart:L1-219`
- **Description**: Sender key-based encryption using ChaCha20-Poly1305 AEAD with in-memory key cache and secure export/import

### Sender Key Generation
- **Location**: `packages/app/lib/features/groups/services/group_crypto_service.dart:L28-36`
- **Description**: Generate random 32-byte symmetric sender key as base64 for distribution to group members

### Key Management
- **Location**: `packages/app/lib/features/groups/services/group_crypto_service.dart:L45-97`
- **Description**: Store/retrieve/check/remove sender keys with validation and in-memory caching per group and device

### Encryption & Decryption
- **Location**: `packages/app/lib/features/groups/services/group_crypto_service.dart:L102-180`
- **Description**: ChaCha20-Poly1305 encryption/decryption with nonce + ciphertext + MAC assembly and authentication checking

### GroupStorageService
- **Location**: `packages/app/lib/features/groups/services/group_storage_service.dart:L1-358`
- **Description**: SQLite-backed storage for groups, messages, vector clocks with secure storage for sender keys

### Group CRUD
- **Location**: `packages/app/lib/features/groups/services/group_storage_service.dart:L102-154`
- **Description**: Save/get/update/delete groups with timestamp ordering and cascade deletion of messages and clocks

### Message CRUD
- **Location**: `packages/app/lib/features/groups/services/group_storage_service.dart:L160-229`
- **Description**: Save/get messages with composite key (group_id, author_device_id, sequence_number) and latest messages query

### Vector Clock Operations
- **Location**: `packages/app/lib/features/groups/services/group_storage_service.dart:L235-270`
- **Description**: Persist and load vector clocks for tracking message sync state per device per group

### Sender Key Storage
- **Location**: `packages/app/lib/features/groups/services/group_storage_service.dart:L276-329`
- **Description**: Secure storage of sender keys using FlutterSecureStorage with group/device namespacing

### GroupSyncService
- **Location**: `packages/app/lib/features/groups/services/group_sync_service.dart:L1-172`
- **Description**: Vector clock-based sync orchestration for detecting missing messages and applying batch updates

### Sync Computation
- **Location**: `packages/app/lib/features/groups/services/group_sync_service.dart:L56-90`
- **Description**: Compute missing messages by clock comparison and fetch actual messages from storage

### Message Application
- **Location**: `packages/app/lib/features/groups/services/group_sync_service.dart:L100-134`
- **Description**: Apply single or batch messages with deduplication and vector clock updates

### Sequence Tracking
- **Location**: `packages/app/lib/features/groups/services/group_sync_service.dart:L140-172`
- **Description**: Get next sequence number and detect gaps in per-device message sequences

### GroupInvitationService
- **Location**: `packages/app/lib/features/groups/services/group_invitation_service.dart:L1-217`
- **Description**: Send/receive group invitations and group messages over existing 1:1 P2P channels with callbacks

### Invitation Sending
- **Location**: `packages/app/lib/features/groups/services/group_invitation_service.dart:L67-99`
- **Description**: Serialize group metadata and all sender keys, send prefixed JSON invitation to target peer

### Invitation Receiving
- **Location**: `packages/app/lib/features/groups/services/group_invitation_service.dart:L101-166`
- **Description**: Deserialize invitation, create local group, import all sender keys, trigger onGroupJoined callback

### Group Message Relay
- **Location**: `packages/app/lib/features/groups/services/group_invitation_service.dart:L168-216`
- **Description**: Receive base64-encoded encrypted group messages from 1:1 peers, try decrypting with each group, route to correct group

### GroupConnectionService
- **Location**: `packages/app/lib/features/groups/services/group_connection_service.dart:L89-462`
- **Description**: Mesh WebRTC data channel management for full N*(N-1)/2 group connections with broadcast and state tracking

### Group Activation
- **Location**: `packages/app/lib/features/groups/services/group_connection_service.dart:L166-225`
- **Description**: Activate mesh connections to all members, deactivate and cleanup on group close

### Member Connection Management
- **Location**: `packages/app/lib/features/groups/services/group_connection_service.dart:L234-281`
- **Description**: Handle member join (connect) and leave (disconnect) with state tracking updates

### Data Broadcasting
- **Location**: `packages/app/lib/features/groups/services/group_connection_service.dart:L287-318`
- **Description**: Broadcast data to all connected members or send to specific member with error handling

### State Queries
- **Location**: `packages/app/lib/features/groups/services/group_connection_service.dart:L324-357`
- **Description**: Get group connections map, member connection state, connected member count, full connectivity check

### WebRtcP2PAdapter
- **Location**: `packages/app/lib/features/groups/services/webrtc_p2p_adapter.dart:L1-122`
- **Description**: Concrete P2PConnectionAdapter implementation bridging group layer to ConnectionManager/WebRTCService with base64 encoding

## Security Hardening

### Group Invitation Verification
- **Location**: `packages/app/lib/features/groups/services/group_invitation_service.dart`
- **Description**: Incoming group invitations are verified for valid structure and known sender before acceptance; malformed or unsolicited invitations are rejected

### Sequence Validation + Duplicate Detection
- **Location**: `packages/app/lib/features/groups/services/group_sync_service.dart`
- **Description**: Group message sequence numbers are validated per-device; duplicates detected via vector clock comparison and rejected before storage

### Sender Key Zeroization
- **Location**: `packages/app/lib/features/groups/services/group_crypto_service.dart`
- **Description**: Sender keys are securely zeroized from the in-memory cache and secure storage when a member leaves or is removed from a group

### Bounded Message Storage
- **Location**: `packages/app/lib/features/groups/services/group_storage_service.dart`
- **Description**: Maximum 5000 messages stored per group; oldest messages are evicted first when the limit is reached

### JSON Schema Validation
- **Location**: `packages/app/lib/features/groups/services/group_invitation_service.dart`, `packages/app/lib/features/groups/services/group_service.dart`
- **Description**: Group metadata, invitation payloads, and message envelopes validated against expected JSON schemas before deserialization

## Providers

### Group Providers
- **Location**: `packages/app/lib/features/groups/providers/group_providers.dart:L1-131`
- **Description**: Riverpod providers for all group services and data with FutureProvider for async group/message loading

### Service Providers
- **Location**: `packages/app/lib/features/groups/providers/group_providers.dart:L14-105`
- **Description**: DI providers for crypto/storage/sync/invitation/connection services with lifecycle management and callbacks

### Data Providers
- **Location**: `packages/app/lib/features/groups/providers/group_providers.dart:L107-130`
- **Description**: FutureProviders for all groups list, single group by ID, and latest 50 messages per group
