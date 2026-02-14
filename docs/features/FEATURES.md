# Zajel Feature List

A comprehensive overview of all features organized by package and area.

---

## App

### Chat

- **Chat Screen** -- Encrypted messaging interface for peer-to-peer communication
- **Split-view/Embedded Mode** -- Renders chat without Scaffold/AppBar when embedded in split-view layouts
- **Connection Status Indicator** -- Displays offline warning banner when peer is disconnected with message queuing indication
- **App Bar Header** -- Shows peer avatar, name, connection status, and action buttons for voice/video calls
- **Embedded Header** -- Compact header variant for split-view mode with peer info and action buttons
- **Text Message Sending** -- Sends encrypted text messages with status tracking (pending/sending/sent/failed)
- **File Sending** -- Allows picking and sending files with progress tracking and attachment metadata
- **Message List Rendering** -- Displays chronological message history with date dividers between different days
- **Empty State** -- Shows E2E encryption info (X25519 + ChaCha20-Poly1305) when no messages exist
- **Message Bubble Widget** -- Renders individual message bubble with alignment, styling, and status indicators
- **Message Status Indicators** -- Shows message delivery status (sending/sent/delivered/read/failed) with appropriate icons
- **File Message Rendering** -- Displays file attachments with name, size, and open button for received files
- **File Opening** -- Opens files using system default apps on desktop or share sheet on mobile
- **Message Input Bar** -- TextField with emoji button, file attachment, send button, and keyboard handling
- **Emoji Picker Integration** -- Toggles filtered emoji picker with keyboard fallback
- **Filtered Emoji Picker** -- Custom emoji picker excluding blocked emojis for Islamic values compliance
- **Desktop Key Handling** -- Handles Enter (send) and Shift+Enter (newline) on desktop platforms
- **Auto-scroll to Latest** -- Animates scroll to bottom when new messages arrive
- **Voice Call Button** -- Initiates voice-only call with peer validation
- **Video Call Button** -- Initiates video call with peer validation
- **Start Call Handler** -- Handles call initiation with error handling and navigation to call screen
- **Incoming Call Listener** -- Monitors VoIP state and shows incoming call dialog when call arrives
- **Incoming Call Dialog** -- Modal dialog for accepting/rejecting incoming calls with video option
- **Rename Peer Dialog** -- Modal for changing peer alias with immediate UI update
- **Delete Conversation** -- Confirms and removes peer, clears messages, disconnects connection
- **Peer Information Sheet** -- Modal showing peer name, ID, IP, connection status, last seen timestamp
- **Fingerprint Verification** -- Expandable section for comparing X25519 public key fingerprints for MITM detection
- **Fingerprint Card Widget** -- Displays monospace fingerprint with copy-to-clipboard functionality
- **End-to-End Encryption Info** -- Displays encryption method (X25519 + ChaCha20-Poly1305) in multiple locations
- **Message Stream Listener** -- Monitors message stream and reloads messages when new ones arrive
- **App Lifecycle Handling** -- Focuses message input when app resumes to foreground
- **Date Formatting** -- Formats dates as "Today", "Yesterday", or "DD/MM/YYYY" for messages
- **Date Divider Widget** -- Visual divider showing date between message groups
- **Connection Status Display** -- Maps peer connection states to user-friendly status strings and colors

### Channels

- **Channel Creation** -- Create new channel with Ed25519 signing and X25519 encryption keypairs, generate channel ID, create signed manifest
- **Channel Subscription** -- Subscribe to channel by verifying signed manifest and storing public key + encryption key
- **Channel Link Encoding** -- Encode channel manifest and decryption key into self-contained invite link (zajel://channel/...)
- **Channel Link Decoding** -- Decode invite link to extract manifest and encryption key for subscription
- **Channel Model** -- Represents owned or subscribed channel with role, manifest, signing/encryption keys, and metadata
- **Channel Manifest** -- Signed metadata containing channel name, description, owner/admin keys, encryption key, epoch, and rules
- **Channel Rules** -- Configurable rules for channel behavior (replies, polls, max upstream size, allowed content types)
- **Channel Role Enum** -- Defines owner, admin, and subscriber roles with different permissions
- **Chunk Model** -- Atomic unit of content with plaintext header, signed envelope, and encrypted payload
- **Content Type Enum** -- Enum for text, file, audio, video, document, and poll content types
- **Content Splitting into Chunks** -- Split encrypted payload into fixed 64KB chunks, encrypt with channel key, sign each chunk
- **Chunk Reassembly** -- Reassemble fixed-size chunks by sequence and chunk index with overflow protection
- **Chunk Signature Verification** -- Verify and reassemble chunks with signature validation against authorized keys
- **Channel Crypto Service** -- Cryptographic operations using Ed25519 signing and X25519 + ChaCha20-Poly1305 encryption
- **Signing Key Generation** -- Generate Ed25519 keypair for channel ownership and admin signing
- **Encryption Key Generation** -- Generate X25519 keypair for content encryption
- **Channel ID Derivation** -- Derive channel ID from owner public key using SHA-256 truncated to 128 bits
- **Manifest Signing** -- Sign manifest with owner's Ed25519 private key using canonical JSON format
- **Manifest Verification** -- Verify manifest signature against owner public key with constant-time comparison
- **Payload Encryption** -- Encrypt chunk payload using ChaCha20-Poly1305 with HKDF-derived key
- **Payload Decryption** -- Decrypt chunk payload with MAC verification and authentication check
- **Chunk Signing** -- Sign chunk's encrypted payload with author's Ed25519 private key
- **Subscriber 5-Step Verification** -- Verify chunk authenticity (signature, authorization, manifest, trusted owner, decryptability)
- **Channel Storage Service** -- SQLite-backed storage for channels and chunks with secure key storage
- **Channel Persistence** -- Save/load channels from database with private keys in secure storage
- **Chunk Persistence** -- Store chunks indexed by channel, sequence, and routing hash
- **Latest Sequence Lookup** -- Get latest sequence number for channel to determine next message sequence
- **Sync Service** -- Synchronize chunks between client and relay server via WebSocket messaging
- **Chunk Announcement** -- Announce locally held chunks to relay server for peer discovery and swarm seeding
- **Chunk Request** -- Request chunks from relay by ID or metadata
- **Chunk Push** -- Push chunk data to server when another subscriber needs it (swarm seeding)
- **Periodic Sync** -- Start/stop periodic synchronization with configurable interval (default 5 minutes)
- **Server Message Handling** -- Handle incoming messages (chunk_data, chunk_pull, chunk_available, chunk_not_found)
- **Admin Management Service** -- Manage admin permissions, add/remove admins, rotate encryption keys on member removal
- **Appoint Admin** -- Add admin public key to manifest and re-sign (owner only)
- **Remove Admin** -- Remove admin from manifest and rotate encryption key to revoke access
- **Upstream Message Validation** -- Validate upstream messages against channel rules (replies, polls, size limits)
- **Update Channel Rules** -- Modify channel rules (replies, polls, content types, max upstream size)
- **Encryption Key Rotation** -- Generate new X25519 key and increment epoch (owner only)
- **Upstream Message Model** -- Encrypted message from subscriber to owner with ephemeral signature
- **Upstream Message Types** -- Reply, vote, and reaction message types
- **Reply Thread** -- Groups replies by parent message ID with sorted chronological order
- **Upstream Service** -- Handle subscriber-to-owner messaging with encryption, ephemeral keys, and queuing
- **Send Reply** -- Send reply message to channel owner (subscribers only)
- **Send Vote** -- Send poll vote to channel owner (subscribers only)
- **Send Reaction** -- Send emoji reaction to message (subscribers only)
- **Poll Model** -- Poll definition with question, options, multiple selection flag, and close time
- **Poll Results** -- Aggregated poll results with vote counts per option and finality flag
- **Create Poll** -- Create poll broadcast chunk with question and options (owner only)
- **Live Stream Metadata** -- Stream session metadata (ID, channel, title, state, start/end time, viewer count)
- **Live Stream Frame** -- Single encrypted stream frame with index, signature, author, and timestamp
- **Live Stream Service** -- Service for starting streams, sending frames, recording frames for VOD
- **Start Stream** -- Start new live stream with title (owner only)
- **Send Frame** -- Encrypt and send video/audio frame to active stream via WebSocket
- **RTMP Frame** -- RTMP/FLV frame with tag type (audio/video/script), timestamp, and payload
- **RTMP Ingest Service** -- Protocol adapter converting RTMP/FLV frames to live stream frames
- **Routing Hash Service** -- Generate rotating routing hashes for DHT lookup and censorship resistance
- **Routing Hash Derivation** -- Derive current routing hash using HMAC with epoch period (hourly/daily)
- **Historic Routing Hash** -- Derive routing hash for specific past epoch for catch-up
- **Censorship Detection** -- Track fetch results per routing hash to detect blocking patterns
- **Background Sync Service** -- Periodic background sync of channel chunks using platform background task schedulers
- **Background Task Registration** -- Register periodic tasks with platform (Android WorkManager, iOS BGAppRefresh)
- **Responsive Channel Layout** -- Responsive screen showing channel list sidebar on wide screens, split-view detail on large displays
- **Channel Sidebar** -- Collapsible sidebar showing channel list with selection, create/subscribe buttons
- **Channel List Screen** -- Full-screen channel list for narrow/mobile displays
- **Create Channel Dialog** -- Dialog to create new channel with name and optional description
- **Subscribe Dialog** -- Dialog to paste channel invite link and subscribe to existing channel
- **Channel Detail Screen** -- Display channel messages, compose bar for owners/admins, channel info
- **Channel Banner** -- Display channel description and user role badge
- **Message List** -- ScrollView of messages with timestamp and author information
- **Channel Message Bubble** -- Display single message with author, timestamp, and selectable text
- **Compose Bar** -- Text input with send button for publishing messages (owner/admin only)
- **Share Dialog** -- Show and copy channel invite link (owner only)
- **Channel Info Sheet** -- Display channel metadata (name, description, role, epoch, rules, admins)
- **Publish Message** -- Create chunk payload, encrypt, sign, save locally, announce to relay
- **Content Type Validation** -- Validate decrypted payload's content type against channel rules
- **Message Display Model** -- Displayable message decoded from chunks (sequence, type, text, timestamp, author)
- **Message Provider** -- Riverpod provider fetching, grouping, decrypting, and reassembling chunks
- **Selected Channel ID Provider** -- StateProvider tracking currently selected channel ID in split-view

### Groups

- **Groups List Screen** -- Displays list of all groups with create and view group creation dialog UI
- **Group Detail Screen** -- Shows group chat messages, members, and compose bar with add/view member actions
- **Group Model** -- Core group entity with ID, name, members list, creator info, and metadata
- **GroupMember Model** -- Group member with device ID, display name, public key, and join timestamp
- **GroupMessage Model** -- Message with type, content, metadata, timestamp, status, author tracking, and serialization
- **GroupMessageType Enum** -- Message types: text, file, image, system
- **GroupMessageStatus Enum** -- Delivery status: pending, sent, delivered, failed
- **Vector Clock** -- Causal ordering tracking per-device sequence numbers with merge, comparison, and gap detection
- **GroupService** -- High-level orchestration for group operations (create, join, leave, send/receive, sync)
- **Group Creation** -- Creates new group with UUID, adds creator as first member, generates sender key
- **Member Management** -- Add/remove members, accept invitations, rotate keys for forward secrecy
- **Group Messaging** -- Send and receive encrypted messages with sender key encryption and deduplication
- **Group Sync** -- Vector clock-based sync (get clock, compute missing messages, apply batch)
- **GroupCryptoService** -- Sender key-based encryption using ChaCha20-Poly1305 AEAD with key cache
- **Sender Key Generation** -- Generate random 32-byte symmetric sender key for distribution to group members
- **Group Key Management** -- Store/retrieve/check/remove sender keys with validation and caching
- **Group Encryption & Decryption** -- ChaCha20-Poly1305 encryption/decryption with nonce + ciphertext + MAC
- **GroupStorageService** -- SQLite-backed storage for groups, messages, vector clocks with secure key storage
- **Group CRUD** -- Save/get/update/delete groups with timestamp ordering and cascade deletion
- **Message CRUD** -- Save/get messages with composite key (group_id, author_device_id, sequence_number)
- **Vector Clock Operations** -- Persist and load vector clocks for tracking message sync state
- **Sender Key Storage** -- Secure storage of sender keys using FlutterSecureStorage
- **GroupSyncService** -- Vector clock-based sync orchestration for detecting missing messages
- **Sync Computation** -- Compute missing messages by clock comparison and fetch from storage
- **Message Application** -- Apply single or batch messages with deduplication and vector clock updates
- **Sequence Tracking** -- Get next sequence number and detect gaps in per-device message sequences
- **GroupInvitationService** -- Send/receive group invitations over existing 1:1 P2P channels
- **Invitation Sending** -- Serialize group metadata and sender keys, send prefixed JSON to target peer
- **Invitation Receiving** -- Deserialize invitation, create local group, import sender keys
- **Group Message Relay** -- Receive encrypted group messages from 1:1 peers, route to correct group
- **GroupConnectionService** -- Mesh WebRTC data channel management for full N*(N-1)/2 group connections
- **Group Activation** -- Activate mesh connections to all members, deactivate and cleanup on close
- **Member Connection Management** -- Handle member join/leave with state tracking updates
- **Data Broadcasting** -- Broadcast data to all connected members or send to specific member
- **State Queries** -- Get group connections map, member connection state, connected count, full connectivity
- **WebRtcP2PAdapter** -- Concrete adapter bridging group layer to ConnectionManager/WebRTCService
- **Group Providers** -- Riverpod providers for all group services and data with FutureProvider

### Call / VoIP

- **Main Call Screen** -- Full-screen call interface with remote video, local preview, call state, and controls
- **Remote Video Display** -- Displays remote peer video or avatar placeholder when video unavailable
- **Local Video Preview** -- Corner preview of local camera with mirror mode and rounded corners
- **Call State Status Overlay** -- Shows call status (Calling, Connecting, Connected with duration, Ended)
- **Call Duration Timer** -- Tracks and formats call duration (MM:SS or H:MM:SS format)
- **Call Control Buttons** -- Mute, Video toggle, Camera switch, Device settings, Hangup
- **In-Call Device Settings Sheet** -- Draggable bottom sheet for device/audio processing configuration
- **Incoming Call UI** -- Dialog with caller info and accept/reject options
- **Caller Avatar Display** -- Shows avatar with NetworkImage or initial fallback
- **Call Action Buttons** -- Accept (audio), Accept with Video, Decline buttons
- **Call State Management** -- Enum with states: idle, outgoing, incoming, connecting, connected, ended
- **Call Info Model** -- Tracks call ID, peer ID, video flag, state, start time, remote stream
- **Outgoing Call Initiation** -- Creates peer connection, adds local tracks, sends SDP offer with 60s timeout
- **Incoming Call Handling** -- Receives call offer, validates peer, creates peer connection, sets remote description
- **Call Answer** -- Accepts incoming call with optional video, requests media, creates SDP answer
- **Call Rejection** -- Sends call reject with reason (busy, declined, timeout)
- **Call Hangup** -- Ends active call and notifies peer
- **Media Controls** -- Toggle audio mute, video on/off, switch cameras during active call
- **Peer Connection Management** -- Creates RTCPeerConnection with STUN, handles ICE with 10s reconnection timeout
- **ICE Candidate Handling** -- Queues candidates if remote description not set (max 100), adds when ready
- **Resource Cleanup** -- Cancels timers, closes peer connection, stops media tracks, clears ICE queue
- **Call Signaling Messages** -- Send offer/answer/reject/hangup/ICE via signaling server
- **Android Foreground Notification** -- Android foreground service notification for active calls
- **Timeout Configuration** -- Ringing (60s), reconnection (10s), ICE gathering (30s), max pending ICE (100)

### Connection & Pairing

- **Server Discovery & Connection** -- SWIM gossip protocol server discovery, WebSocket connection, pairing code generation
- **QR Code Sharing** -- Display 6-character pairing code, generate QR code (zajel:// URI format), copy to clipboard
- **QR Code Scanning** -- Mobile camera integration via mobile_scanner, parse zajel:// URI scheme
- **Pairing Code Entry** -- Manual 6-character code input with validation, connect button with loading state
- **Web Browser Linking** -- Create link sessions for web browser pairing with QR codes and 5-minute expiration
- **Linked Devices Management** -- List linked web devices, display status, revoke linked devices
- **Link Request Approval** -- Listen for incoming link requests, show approval dialogs with key fingerprint
- **Connection State Management** -- TabController for multi-tab interface, track state, error handling and retry
- **Code Entry Validation** -- Length (6 chars), format (alphanumeric), empty field detection with error messages

### Contacts

- **Trusted Peers Listing** -- Fetches all trusted peers, filters blocked, sorts alphabetically
- **Contact Search** -- Real-time search input, filter by name or alias, case-insensitive matching
- **Contact List Display** -- Scrollable ListView with empty state for no contacts or no matches
- **Contact Tiles** -- Display name, online status indicator, last seen timestamp, connection status
- **Online Status Detection** -- Match peers by ID or public key, account for peer ID changes after migration
- **Contact Navigation** -- Tap to open chat, long press for details, correct routing after migration
- **Contact Profile Display** -- Avatar with initials, display name and optional alias
- **Alias Management** -- Edit alias text field with save and clear buttons
- **Connection Information** -- Peer ID display (monospace), trusted since timestamp, last seen
- **Block Contact** -- Confirmation dialog, add to blocked list, prevent future connections
- **Remove Contact Permanently** -- Confirmation dialog with warning, delete from storage, requires re-pairing

### Home & Navigation

- **Home Screen Layout** -- Header with user info, scrollable peer list, error state with retry, connect FAB
- **Header Section** -- User avatar, display name, pairing code, connection status with color coding
- **Peer List Display** -- Split peers into Online/Offline groups, show counts, full peer cards
- **Peer Card** -- Avatar with status indicator, peer name with alias, status text, action buttons
- **Connection Actions** -- Connect/Cancel/Chat buttons based on peer state
- **Peer Menu Options** -- Rename, delete, block via popup menu
- **Rename Dialog** -- Text input with current name, save/cancel, update alias with immediate refresh
- **Delete Dialog** -- Confirmation, remove from peers, clear messages, disconnect
- **Block Dialog** -- Confirmation, add to blocked using public key or ID
- **Top Navigation Bar** -- Channels, Groups, Contacts, Connect (QR scanner), Settings buttons
- **Responsive Layout System** -- Breakpoint at 720px for wide/narrow switch
- **Wide Layout (Split-View)** -- Sidebar (320px) + Chat split view with vertical divider
- **Conversation Sidebar** -- Header with user info, peer list with selection, connect FAB, navigation icons
- **Conversation Tiles** -- Peer name, last message preview, timestamp, online indicator, selection highlighting
- **Empty Chat Placeholder** -- Centered message icon with "Select a conversation" prompt

### Settings

- **Settings Screen** -- Sections: Profile, Appearance, Notifications, Audio & Video, Privacy & Security, External Connections, Debugging, About, Help
- **Notification Settings** -- DND controls, sound/preview toggles, notification type toggles, muted peers management
- **Media Settings** -- Audio input/output selection, camera preview, noise suppression, echo cancellation, auto gain, background blur
- **Blocked Peers Screen** -- Display blocked users, unblock functionality, permanent removal

### Onboarding

- **Onboarding Screen** -- 4-step swipeable tutorial: Welcome, Your Identity, How to Connect, You're Ready

### Help

- **Help Screen** -- Main knowledge base with topic listing
- **Help Article Screen** -- Individual article display with rich text rendering
- **Help Content** -- 8 static articles: How Zajel Works, Your Identity, Pairing & Connecting, Encryption Explained, Data Storage, Platform-Specific Notes, Troubleshooting

### Attestation

- **Attestation Initializer** -- Orchestrator for version check, registration, and anti-tamper checks
- **Attestation Service** -- Main orchestrator for build token registration and session token management
- **Version Check Service** -- Version policy checking and semver comparison
- **Anti-Tamper Service** -- Debugger, root/jailbreak, and emulator detection
- **Binary Attestation Service** -- Dynamic binary attestation challenge handling with HMAC-SHA256
- **Server Attestation Service** -- Server identity verification against bootstrap registry
- **Attestation Client** -- HTTP client for bootstrap API (register, challenge, verify, version policy)
- **Session Token Model** -- Short-lived session token with expiration
- **Build Token Model** -- Build token with version, platform, hash, timestamp, and signature
- **Version Policy Model** -- Version management with minimum/recommended/blocked versions
- **Force Update Dialog** -- Full-screen blocking update dialog
- **Update Prompt Dialog** -- Dismissable update suggestion dialog
- **Binary Reader (Desktop)** -- Desktop binary reader using Platform.resolvedExecutable

### Core Crypto

- **Key Exchange Service** -- X25519 ECDH key exchange with HKDF-derived session keys for forward secrecy
- **Session Key Management** -- Ephemeral session key establishment and storage with memory caching
- **Identity Key Persistence** -- Persistent identity key storage in secure storage, regenerated per session
- **Encryption and Decryption** -- ChaCha20-Poly1305 AEAD encryption with random nonce
- **Public Key Fingerprinting** -- SHA-256 fingerprint generation for out-of-band verification (MITM detection)
- **Bootstrap Server Verification** -- Ed25519 signature verification of bootstrap server responses with timestamp freshness

### Core Network

- **WebRTC Peer Connection** -- Full P2P WebRTC connection lifecycle with SDP offer/answer and ICE handling
- **Data Channels** -- Ordered message and file data channels with 3 max retransmits
- **ICE Candidate Queuing** -- Pending ICE candidate queue (max 100) flushed when remote description set
- **Encrypted Message Transport** -- End-to-end encrypted message sending via WebRTC
- **Encrypted File Chunking** -- 16KB chunked file transfer with metadata and per-chunk encryption
- **Cryptographic Handshake** -- Public key exchange over WebRTC to establish session
- **WebSocket Connection Management** -- WSS connection to signaling server with standard and pinned WebSocket options
- **Certificate Pinning** -- Platform-specific certificate pinning for Android/iOS
- **Heartbeat Protocol** -- 30-second ping/pong heartbeat to keep signaling connection alive
- **Pairing Code Generation** -- Cryptographically secure 6-character code using rejection sampling
- **Pair Request/Response** -- Mutual approval pairing protocol before WebRTC
- **Call Signaling Messages** -- VoIP signaling (offer/answer/reject/hangup/ICE) for calls
- **ICE Candidate Signaling** -- ICE candidate relay between peers via signaling server
- **Device Link Request/Response** -- Web client linking protocol for proxied connections
- **Rendezvous Event Handling** -- Processing live matches and dead drops from meeting point queries
- **Meeting Points Derivation** -- Deterministic daily meeting points from public key pairs (3-day window)
- **Rendezvous Registration** -- Registration of meeting points with signaling server for peer discovery
- **Dead Drop Creation and Decryption** -- Encrypted connection info left at meeting points for offline reconnection
- **Live Match Handling** -- Peer discovery when both are online at same meeting point
- **Federated Server Redirects** -- Following redirects to federated servers for cross-federation meeting points
- **Bootstrap Server Discovery** -- Fetching VPS server list from Cloudflare Workers with signature verification
- **Server Selection** -- Server selection by region preference and freshness, random choice among top 3
- **Periodic Server Refresh** -- Automatic server list refresh on configurable interval
- **Relay Connection Management** -- Multi-relay connection management for introduction forwarding
- **Source ID Mapping** -- Mapping of peer IDs to source IDs for relay routing
- **Introduction Protocol** -- Introduction request/forward/response for peer introductions through relays
- **Load Reporting** -- Peer load tracking and periodic reporting to signaling server
- **Peer Connection Lifecycle** -- Central coordination of peer discovery, pairing, WebRTC, messaging, and trusted peer migration
- **Trusted Peer Migration** -- Detection and migration of trusted peers reconnecting with new pairing codes
- **Signaling State Machine** -- Sealed class for type-safe signaling connection state
- **Linked Device Support** -- WebRTC tunnel proxying for web client messaging through mobile app
- **Message Protocol** -- Binary wire format with version, type, flags, and versioned message types
- **Handshake Messages** -- Public key exchange messages for cryptographic session establishment
- **File Chunk Encoding** -- Protocol encoding for file metadata and chunked data with indices

### Core Storage

- **SQLite Message Storage** -- Persistent per-peer message storage with indexes on peerId and timestamp
- **Message Pagination** -- Limit/offset based message retrieval with conversation preview support
- **Message Status Tracking** -- Update message status (pending, sending, sent, delivered, read, failed)
- **Message Cleanup** -- Message deletion by peer, age-based cleanup, and full database wipe
- **Message Migration** -- Migrate message history when trusted peer reconnects with new pairing code
- **Secure Peer Storage** -- Platform-specific secure storage for trusted peer public keys (Keychain/Keystore)
- **Peer Lookup** -- Query trusted peers by ID, public key, and verification
- **Peer Metadata** -- Storage of display name, alias, last seen, notes, and block status
- **File Receive Service** -- Handles receiving and storing chunked file transfers from peers

### Core Media

- **Media Access Control** -- Cross-platform media permission handling and getUserMedia constraints
- **Audio Processing** -- Noise suppression, echo cancellation, and automatic gain control configuration
- **Device Management** -- Enumeration and selection of audio input/output and video input devices
- **Media Muting and Toggling** -- Audio mute and video on/off toggling for call controls
- **Camera Switching** -- Front/back camera switching support on mobile platforms
- **Media Preferences** -- Persistence of device selection and audio processing settings
- **Background Blur Processing** -- Video background blur/replacement processing for privacy

### Core Notifications

- **Message Notifications** -- Local notifications for incoming messages with optional content preview
- **Call Notifications** -- High-priority incoming call notifications with video indication
- **Peer Status Notifications** -- Low-priority notifications for peer online/offline status changes
- **File Notifications** -- Notifications for received files with file name display
- **DND and Settings** -- Per-peer notification settings with do-not-disturb and sound controls
- **Call Foreground Service** -- Android foreground service for keeping calls active in background

### Core Logging

- **File-Based Logging** -- Daily rotating log files with 5MB size limit and 7-day retention
- **Log Export** -- Export logs via share sheet or to directory for debugging
- **Real-time Log Streaming** -- Stream controller broadcasting log entries for real-time monitoring
- **Configurable Log Levels** -- Minimum log level filtering (debug, info, warning, error)

---

## Server

### Core Routing & API

- **Request Dispatcher** -- Main Cloudflare Worker fetch handler routing HTTP requests to Durable Objects
- **CORS Headers** -- Cross-origin resource sharing headers for all responses
- **Health Check Endpoint** -- GET /health returning service status with timestamp
- **API Information Endpoint** -- GET / and GET /api/info listing all available endpoints
- **Signed Bootstrap Response** -- GET /servers with timestamp and Ed25519 signature

### WebSocket Signaling

- **Signaling Room** -- Durable Object managing WebSocket connections for WebRTC signaling
- **Pairing Code Registration** -- Register WebSocket connections with pairing codes
- **Signaling Message Forwarding** -- Routes offer/answer/ice_candidate between paired peers
- **Peer Join/Leave Notifications** -- Broadcasts peer_joined and peer_left messages
- **WebSocket Error Handling** -- Message parsing, errors, and connection lifecycle

### Relay Registry

- **Relay Peer Registration** -- Register peers as available relays with capacity info
- **Load Tracking** -- Update connection count for registered peers
- **Available Relay Selection** -- Get relays with <50% capacity, load-balanced with Fisher-Yates shuffle
- **Peer Unregistration** -- Remove peer from registry on disconnect
- **Registry Statistics** -- Metrics about total peers, capacity, connected count

### Rendezvous System

- **Daily Meeting Points with Dead Drops** -- Register meeting point hashes with encrypted dead drops (48-hour TTL)
- **Hourly Token Live Matching** -- Register hourly tokens for real-time peer matching (3-hour TTL)
- **Dead Drop Retrieval** -- Return encrypted dead drop messages left by other peers
- **Live Match Notification** -- Notify original peers when new peer matches their hourly token
- **Peer Unregistration** -- Remove peer from all daily points and hourly tokens on disconnect
- **Expiration Cleanup** -- Clean up expired entries from daily points and hourly tokens

### Chunk Distribution System

- **Chunk Source Announcement** -- Register peers as sources for chunks with 1-hour TTL
- **Chunk Source Tracking** -- Get list of online sources for a chunk and check availability
- **Chunk Cache Management** -- Cache chunk data on server with 30-minute TTL, max 1000 entries with LRU eviction
- **Cached Chunk Retrieval** -- Retrieve cached chunks with expiration checks and access counting
- **Pending Request Management** -- Track pending requests with multicast optimization
- **Peer Chunk Cleanup** -- Remove all chunk sources for disconnected peers
- **Chunk Index Cleanup** -- Clean up expired sources, cache entries, and stale pending requests

### WebSocket Message Handler

- **Message Type Dispatcher** -- Routes incoming WebSocket messages to appropriate handlers
- **Peer Registration Handler** -- Handle register messages to add peer to relay registry
- **Load Update Handler** -- Handle update_load messages to track connection count
- **Rendezvous Registration Handler** -- Handle register_rendezvous for daily and hourly tokens
- **Get Relays Handler** -- Handle get_relays to return available relay list
- **Ping/Pong Handler** -- Respond to ping messages with pong for keep-alive
- **Heartbeat Handler** -- Handle heartbeat messages to update last-seen timestamp
- **Chunk Announce Handler** -- Handle chunk_announce to register sources and trigger pulls
- **Chunk Request Handler** -- Handle chunk_request to serve from cache, find source, or queue
- **Chunk Push Handler** -- Handle chunk_push to cache data (max 64KB) and multicast to requesters
- **Peer Disconnect Handler** -- Clean up registries on peer disconnect

### Durable Objects

- **Relay Registry Durable Object** -- Initialize registries and schedule cleanup alarms
- **Periodic Cleanup Alarm** -- Run cleanup on rendezvous and chunk index every 5 minutes
- **HTTP Stats Endpoint** -- GET /stats returning all registry statistics
- **WebSocket Upgrade** -- Handle HTTP upgrade request to WebSocket

### Server Bootstrap Registry

- **Server Registration** -- POST /servers to register VPS server with 5-minute TTL
- **Server Listing** -- GET /servers to list active servers with auto-cleanup
- **Server Unregistration** -- DELETE /servers/:serverId to remove a server
- **Server Heartbeat** -- POST /servers/heartbeat to update lastSeen and return peer list

### Device Attestation

- **Device Registration** -- POST /attest/register with signed build token and version validation
- **Reference Binary Upload** -- POST /attest/upload-reference for CI binary metadata (requires CI_UPLOAD_SECRET)
- **Attestation Challenge Generation** -- POST /attest/challenge generating nonce and 3-5 critical regions
- **Challenge Verification** -- POST /attest/verify with HMAC-SHA256 and session token (1-hour TTL)
- **Version Policy Management** -- GET/POST /attest/versions for minimum/recommended/blocked versions

### Cryptography

- **Ed25519 Signing Key Import** -- Import Ed25519 signing key from hex-encoded seed with PKCS8 wrapping
- **Ed25519 Payload Signing** -- Sign UTF-8 payload and return base64 signature
- **Ed25519 Verification Key Import** -- Import Ed25519 public key from base64 with SPKI wrapping
- **Build Token Signature Verification** -- Verify Ed25519 signature on build token payload
- **HMAC-SHA256 Computation** -- Compute HMAC-SHA256 with nonce as key, hex-encoded result
- **Nonce Generation** -- Cryptographically random 32-byte nonce as hex string
- **Session Token Creation** -- Create signed session token with 1-hour expiration
- **Session Token Verification** -- Verify and decode session token with expiration check
- **Semver Version Comparison** -- Compare semantic version strings

### Logging

- **Environment-Aware Logger** -- Logger with environment detection and configurable log levels
- **Pairing Code Redaction** -- Redact pairing codes in production (show only first and last chars)

### Configuration & Deployment

- **Wrangler Configuration** -- Cloudflare Worker config with Durable Object bindings
- **Custom Domain Routes** -- Production domain routing to signal.zajel.hamzalabs.dev
- **Environment Configuration** -- QA environment with separate Durable Objects and domain
- **Durable Object Migrations** -- Versioned migrations (v1-v4: SignalingRoom, RelayRegistryDO, ServerRegistryDO, AttestationRegistryDO)

---

## Website

### Landing Page

- **Hero Section** -- Headline, tagline, and dual call-to-action buttons (Download and Guide)
- **Features Section** -- Grid of 6 feature cards (Encryption, P2P, Local Discovery, Cross-Platform, File Sharing, No Account)
- **Downloads Section** -- Platform download cards with automatic device detection and GitHub release integration
- **App Store Badges** -- Coming soon badges for Google Play, Apple App Store, and Microsoft Store
- **Platform Detection** -- Client-side JavaScript detecting user's OS to highlight recommended download
- **Dynamic Release Integration** -- Fetches latest GitHub release data and maps platform-specific assets

### User Guide

- **Getting Started** -- Installation instructions for all supported platforms
- **Automatic Peer Discovery** -- Documentation of mDNS-based peer discovery mechanism
- **Connecting to Peers** -- Step-by-step connection guide with state indicators
- **Sending Messages** -- Messaging instructions with encryption details
- **File Sharing** -- File transfer process with chunking and encryption explanation
- **Display Name Configuration** -- Guide for changing profile display name
- **User Blocking** -- Instructions for blocking users
- **Troubleshooting** -- Common issues and solutions for discovery, connection, and messaging
- **Security Documentation** -- Technical details on X25519, ChaCha20-Poly1305, P2P architecture
- **FAQ** -- Answers about connectivity, data storage, offline usage, connection loss
- **Table of Contents Navigation** -- Guide page navigation with anchor links

### Navigation & Layout

- **Logo and Navigation Bar** -- Sticky header with Zajel branding and route links
- **Footer Links** -- GitHub, Privacy Policy, User Guide, company link, MIT License copyright
- **Color Theme and Design System** -- CSS custom properties for dark theme with Indigo/Emerald palette
- **Responsive Design** -- Mobile breakpoints for hero text, navigation, and download grid
- **React Router Configuration** -- SPA mode for static Cloudflare Pages deployment
- **Vite Build Configuration** -- Vite with React Router plugin and path alias
- **Cloudflare Pages Deployment** -- Static asset deployment with production and QA environments
