# App - Core Infrastructure Features

## Cryptography

### Key Exchange Service
- **Location**: `packages/app/lib/core/crypto/crypto_service.dart:L1-396`
- **Description**: X25519 ECDH key exchange with HKDF-derived session keys for forward secrecy

### Session Key Management
- **Location**: `packages/app/lib/core/crypto/crypto_service.dart:L59-218`
- **Description**: Ephemeral session key establishment and storage in secure storage with memory caching

### Identity Key Persistence
- **Location**: `packages/app/lib/core/crypto/crypto_service.dart:L326-354`
- **Description**: Persistent identity key storage in secure storage, regenerated per session for privacy

### Encryption and Decryption
- **Location**: `packages/app/lib/core/crypto/crypto_service.dart:L221-286`
- **Description**: ChaCha20-Poly1305 AEAD encryption with random nonce, ciphertext+nonce prepending

### Public Key Fingerprinting
- **Location**: `packages/app/lib/core/crypto/crypto_service.dart:L69-128`
- **Description**: SHA-256 fingerprint generation and formatting for out-of-band verification (MITM detection)

### Bootstrap Server Verification
- **Location**: `packages/app/lib/core/crypto/bootstrap_verifier.dart:L1-73`
- **Description**: Ed25519 signature verification of bootstrap server responses with timestamp freshness checking

## Network - WebRTC

### WebRTC Peer Connection
- **Location**: `packages/app/lib/core/network/webrtc_service.dart:L35-571`
- **Description**: Full P2P WebRTC connection lifecycle with SDP offer/answer and ICE candidate handling

### Data Channels
- **Location**: `packages/app/lib/core/network/webrtc_service.dart:L429-471`
- **Description**: Ordered message and file data channels with 3 max retransmits, setup and stream handling

### ICE Candidate Queuing
- **Location**: `packages/app/lib/core/network/webrtc_service.dart:L177-229`
- **Description**: Pending ICE candidate queue (max 100) flushed when remote description is set

### Encrypted Message Transport
- **Location**: `packages/app/lib/core/network/webrtc_service.dart:L232-243`
- **Description**: End-to-end encrypted message sending via WebRTC with crypto handshake

### Encrypted File Chunking
- **Location**: `packages/app/lib/core/network/webrtc_service.dart:L245-299`
- **Description**: 16KB chunked file transfer with metadata, encryption per chunk, and completion notification

### Cryptographic Handshake
- **Location**: `packages/app/lib/core/network/webrtc_service.dart:L301-316`
- **Description**: Public key exchange over WebRTC to establish session before encrypted communication

## Network - Signaling

### WebSocket Connection Management
- **Location**: `packages/app/lib/core/network/signaling_client.dart:L184-312`
- **Description**: WSS connection to signaling server with standard and pinned (native) WebSocket options

### Certificate Pinning
- **Location**: `packages/app/lib/core/network/pinned_websocket.dart`
- **Description**: Platform-specific certificate pinning for Android/iOS (via native implementations)

### Heartbeat Protocol
- **Location**: `packages/app/lib/core/network/signaling_client.dart:L759-770`
- **Description**: 30-second ping/pong heartbeat to keep signaling connection alive

### Pairing Code Generation
- **Location**: `packages/app/lib/core/network/connection_manager.dart:L19-73`
- **Description**: Cryptographically secure 6-character pairing code generation using rejection sampling

### Pair Request/Response
- **Location**: `packages/app/lib/core/network/signaling_client.dart:L380-399`
- **Description**: Mutual approval pairing protocol with peer acceptance/rejection before WebRTC

### Call Signaling Messages
- **Location**: `packages/app/lib/core/network/signaling_client.dart:L416-480`
- **Description**: VoIP call signaling (offer/answer/reject/hangup/ICE) for initiating and managing calls

### ICE Candidate Signaling
- **Location**: `packages/app/lib/core/network/signaling_client.dart:L370-378`
- **Description**: ICE candidate relay between peers via signaling server

### Device Link Request/Response
- **Location**: `packages/app/lib/core/network/signaling_client.dart:L401-410`
- **Description**: Web client linking protocol for proxied peer connections through mobile app

### Rendezvous Event Handling
- **Location**: `packages/app/lib/core/network/signaling_client.dart:L671-847`
- **Description**: Processing live matches and dead drops from meeting point queries

## Network - Rendezvous

### Meeting Points Derivation
- **Location**: `packages/app/lib/core/network/meeting_point_service.dart:L1-100`
- **Description**: Deterministic daily meeting points from public key pairs (3-day window) and hourly tokens from shared secrets

### Rendezvous Registration
- **Location**: `packages/app/lib/core/network/connection_manager.dart:L948-1030`
- **Description**: Registration of meeting points with signaling server for trusted peer discovery

### Dead Drop Creation and Decryption
- **Location**: `packages/app/lib/core/network/rendezvous_service.dart:L109-144`
- **Description**: Encrypted connection info left at meeting points for offline peer reconnection

### Live Match Handling
- **Location**: `packages/app/lib/core/network/rendezvous_service.dart:L146-156`
- **Description**: Peer discovery when both are online at same meeting point

### Federated Server Redirects
- **Location**: `packages/app/lib/core/network/connection_manager.dart:L1065-1168`
- **Description**: Following redirects to federated servers for handling meeting points across federation

## Network - Server Discovery

### Bootstrap Server Discovery
- **Location**: `packages/app/lib/core/network/server_discovery_service.dart:L1-238`
- **Description**: Fetching VPS server list from Cloudflare Workers bootstrap with signature verification

### Server Selection
- **Location**: `packages/app/lib/core/network/server_discovery_service.dart:L159-191`
- **Description**: Server selection by region preference and freshness, random choice among top 3

### Periodic Server Refresh
- **Location**: `packages/app/lib/core/network/server_discovery_service.dart:L217-230`
- **Description**: Automatic server list refresh on configurable interval (default 1 minute)

## Network - Relay

### Relay Connection Management
- **Location**: `packages/app/lib/core/network/relay_client.dart:L24-476`
- **Description**: Multi-relay connection management for introduction forwarding

### Source ID Mapping
- **Location**: `packages/app/lib/core/network/relay_client.dart:L262-320`
- **Description**: Mapping of peer IDs to source IDs for relay routing and peer identification

### Introduction Protocol
- **Location**: `packages/app/lib/core/network/relay_client.dart:L182-237`
- **Description**: Introduction request/forward/response for peer introductions through relays

### Load Reporting
- **Location**: `packages/app/lib/core/network/relay_client.dart:L322-375`
- **Description**: Peer load tracking and periodic reporting to signaling server

## Network - Connection Management

### Peer Connection Lifecycle
- **Location**: `packages/app/lib/core/network/connection_manager.dart:L92-1209`
- **Description**: Central coordination of peer discovery, pairing, WebRTC, messaging, and trusted peer migration

### Trusted Peer Migration
- **Location**: `packages/app/lib/core/network/connection_manager.dart:L658-723`
- **Description**: Detection and migration of trusted peers reconnecting with new pairing codes (same public key)

### Signaling State Machine
- **Location**: `packages/app/lib/core/network/connection_manager.dart:L75-90`
- **Description**: Sealed class for type-safe signaling connection state (Connected or Disconnected)

### Linked Device Support
- **Location**: `packages/app/lib/core/network/device_link_service.dart`
- **Description**: WebRTC tunnel proxying for web client messaging through mobile app

## Network - Protocol

### Message Protocol
- **Location**: `packages/app/lib/core/protocol/message_protocol.dart:L1-216`
- **Description**: Binary wire format with version, type, flags, and versioned message types

### Handshake Messages
- **Location**: `packages/app/lib/core/protocol/message_protocol.dart:L55-87`
- **Description**: Public key exchange messages for cryptographic session establishment

### File Chunk Encoding
- **Location**: `packages/app/lib/core/protocol/message_protocol.dart:L89-134`
- **Description**: Protocol encoding for file metadata and chunked data with indices

## Security Hardening

### HKDF with Both Public Keys
- **Location**: `packages/app/lib/core/crypto/crypto_service.dart`
- **Description**: HKDF key derivation includes both parties' public keys as info parameter, preventing key confusion attacks where a peer could manipulate the derived session key

### Session Keys Encrypted at Rest
- **Location**: `packages/app/lib/core/crypto/crypto_service.dart`
- **Description**: Session keys stored in platform secure storage (Keychain/Keystore) rather than plaintext SQLite, protecting keys when device is at rest

### Nonce-Based Replay Protection
- **Location**: `packages/app/lib/core/crypto/crypto_service.dart`
- **Description**: Encrypted messages include nonce tracking; previously seen nonces are rejected to detect and prevent replayed messages

### Socket Permissions + Auth
- **Location**: Headless client `packages/headless-client/zajel/daemon.py`
- **Description**: UNIX daemon socket restricted with filesystem permissions (owner-only access) and commands require authentication tokens

### File Path Traversal Prevention
- **Location**: `packages/app/lib/core/storage/file_receive_service.dart`, headless client `packages/headless-client/zajel/file_transfer.py`
- **Description**: Received file names sanitized to remove path separators, `..` sequences, and absolute path prefixes, preventing directory traversal attacks

### WebSocket Reconnection with Backoff
- **Location**: `packages/app/lib/core/network/signaling_client.dart`
- **Description**: WebSocket reconnection uses exponential backoff with jitter instead of immediate retry, preventing reconnection storms

### Reliable SCTP Delivery
- **Location**: `packages/app/lib/core/network/webrtc_service.dart`
- **Description**: WebRTC data channels configured for reliable ordered delivery (SCTP) where message loss is unacceptable, preventing silent data loss

## Storage

### SQLite Message Storage
- **Location**: `packages/app/lib/core/storage/message_storage.dart:L1-227`
- **Description**: Persistent per-peer message storage with indexes on peerId and timestamp

### Message Pagination
- **Location**: `packages/app/lib/core/storage/message_storage.dart:L100-137`
- **Description**: Limit/offset based message retrieval with conversation preview support

### Message Status Tracking
- **Location**: `packages/app/lib/core/storage/message_storage.dart:L87-98`
- **Description**: Update message status (pending, sending, sent, delivered, read, failed)

### Message Cleanup
- **Location**: `packages/app/lib/core/storage/message_storage.dart:L179-199`
- **Description**: Message deletion by peer, age-based cleanup, and full database wipe

### Message Migration
- **Location**: `packages/app/lib/core/storage/message_storage.dart:L151-165`
- **Description**: Migrate message history when trusted peer reconnects with new pairing code

### Secure Peer Storage
- **Location**: `packages/app/lib/core/storage/trusted_peers_storage_impl.dart:L1-100`
- **Description**: Platform-specific secure storage for trusted peer public keys (Keychain/Keystore)

### Peer Lookup
- **Location**: `packages/app/lib/core/storage/trusted_peers_storage.dart:L15-66`
- **Description**: Query trusted peers by ID, public key, and verification

### Peer Metadata
- **Location**: `packages/app/lib/core/storage/trusted_peers_storage.dart:L68-200`
- **Description**: Storage of display name, alias, last seen, notes, and block status

### File Receive Service
- **Location**: `packages/app/lib/core/storage/file_receive_service.dart`
- **Description**: Handles receiving and storing chunked file transfers from peers

## Media

### Media Access Control
- **Location**: `packages/app/lib/core/media/media_service.dart:L113-262`
- **Description**: Cross-platform media permission handling and getUserMedia constraints

### Audio Processing
- **Location**: `packages/app/lib/core/media/media_service.dart:L136-175`
- **Description**: Noise suppression, echo cancellation, and automatic gain control configuration

### Device Management
- **Location**: `packages/app/lib/core/media/media_service.dart:L439-510`
- **Description**: Enumeration and selection of audio input/output and video input devices

### Media Muting and Toggling
- **Location**: `packages/app/lib/core/media/media_service.dart:L264-305`
- **Description**: Audio mute and video on/off toggling for call controls

### Camera Switching
- **Location**: `packages/app/lib/core/media/media_service.dart:L307-328`
- **Description**: Front/back camera switching support on mobile platforms

### Media Preferences
- **Location**: `packages/app/lib/core/media/media_service.dart:L143-175`
- **Description**: Persistence of device selection and audio processing settings to SharedPreferences

### Background Blur Processing
- **Location**: `packages/app/lib/core/media/background_blur_processor.dart`
- **Description**: Video background blur/replacement processing for privacy

## Notifications

### Message Notifications
- **Location**: `packages/app/lib/core/notifications/notification_service.dart:L84-118`
- **Description**: Local notifications for incoming messages with optional content preview

### Call Notifications
- **Location**: `packages/app/lib/core/notifications/notification_service.dart:L120-156`
- **Description**: High-priority incoming call notifications with video call indication

### Peer Status Notifications
- **Location**: `packages/app/lib/core/notifications/notification_service.dart:L158-190`
- **Description**: Low-priority notifications for peer online/offline status changes

### File Notifications
- **Location**: `packages/app/lib/core/notifications/notification_service.dart:L192-224`
- **Description**: Notifications for received files with file name display

### DND and Settings
- **Location**: `packages/app/lib/core/notifications/notification_service.dart:L1-235`
- **Description**: Per-peer notification settings with do-not-disturb and sound controls

### Call Foreground Service
- **Location**: `packages/app/lib/core/notifications/call_foreground_service.dart`
- **Description**: Android foreground service for keeping calls active in background

## Logging

### File-Based Logging
- **Location**: `packages/app/lib/core/logging/logger_service.dart:L16-366`
- **Description**: Daily rotating log files with 5MB size limit and 7-day retention

### Log Export
- **Location**: `packages/app/lib/core/logging/logger_service.dart:L285-336`
- **Description**: Export logs via share sheet or to directory for debugging

### Real-time Log Streaming
- **Location**: `packages/app/lib/core/logging/logger_service.dart:L44-48`
- **Description**: Stream controller broadcasting log entries for real-time monitoring

### Configurable Log Levels
- **Location**: `packages/app/lib/core/logging/logger_service.dart:L29-145`
- **Description**: Minimum log level filtering (debug, info, warning, error)

## Configuration

### Environment Variables
- **Location**: `packages/app/lib/core/config/environment.dart:L1-100`
- **Description**: Compile-time environment configuration (bootstrap URL, signaling URL, version, build token)

### Build Token
- **Location**: `packages/app/lib/core/config/environment.dart:L62-70`
- **Description**: Signed build token for app attestation verification

### E2E Test Mode
- **Location**: `packages/app/lib/core/config/environment.dart:L72-75`
- **Description**: Flag for E2E testing with auto-pairing behavior

## Constants

### Cryptographic Constants
- **Location**: `packages/app/lib/core/constants.dart:L10-26`
- **Description**: ChaCha20 nonce (12 bytes), Poly1305 MAC (16 bytes), X25519 key (32 bytes), HKDF output (32 bytes)

### File Transfer Constants
- **Location**: `packages/app/lib/core/constants.dart:L32-41`
- **Description**: 16KB chunk size with 10ms inter-chunk delay

### WebRTC Constants
- **Location**: `packages/app/lib/core/constants.dart:L60-85`
- **Description**: Google STUN servers, data channel labels, max retransmits (3), operation timeout (30s)

### Call Constants
- **Location**: `packages/app/lib/core/constants.dart:L92-114`
- **Description**: Ringing timeout (60s), reconnection (10s), ICE gathering (30s), max pending ICE (100)

### Signaling Constants
- **Location**: `packages/app/lib/core/constants.dart:L47-53`
- **Description**: Heartbeat interval (30 seconds)

## Models

### Peer Model
- **Location**: `packages/app/lib/core/models/peer.dart:L1-87`
- **Description**: Peer representation with ID, name, connection state, public key

### Message Model
- **Location**: `packages/app/lib/core/models/message.dart:L1-113`
- **Description**: Local message with type, status, attachment support

### Notification Settings
- **Location**: `packages/app/lib/core/models/notification_settings.dart`
- **Description**: Per-peer and global notification preferences

### Media Device Model
- **Location**: `packages/app/lib/core/models/media_device.dart`
- **Description**: Audio/video device information with kind and label

### Linked Device Model
- **Location**: `packages/app/lib/core/models/linked_device.dart`
- **Description**: Web client device info for multi-device linking

### Meeting Points
- **Location**: `packages/app/lib/core/network/meeting_points.dart:L1-104`
- **Description**: Container for daily and hourly meeting points with typed accessors

## Providers

### Provider Configuration
- **Location**: `packages/app/lib/core/providers/app_providers.dart`
- **Description**: Riverpod provider setup for dependency injection across app
