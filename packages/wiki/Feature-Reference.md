# Feature Reference

A comprehensive list of all features in the Zajel project, organized by package and area.

---

## App -- Chat

- **Chat Screen** -- Encrypted messaging interface for peer-to-peer communication
- **Split-view/Embedded Mode** -- Renders chat without Scaffold/AppBar when embedded in split-view layouts
- **Connection Status Indicator** -- Displays offline warning banner when peer is disconnected with message queuing indication
- **Text Message Sending** -- Sends encrypted text messages with status tracking (pending/sending/sent/failed)
- **File Sending** -- Allows picking and sending files with progress tracking and attachment metadata
- **Message List Rendering** -- Displays chronological message history with date dividers between different days
- **Message Status Indicators** -- Shows message delivery status (sending/sent/delivered/read/failed) with appropriate icons
- **File Message Rendering** -- Displays file attachments with name, size, and open button for received files
- **File Opening** -- Opens files using system default apps on desktop or share sheet on mobile
- **Message Input Bar** -- TextField with emoji button, file attachment, send button, and keyboard handling
- **Filtered Emoji Picker** -- Custom emoji picker excluding blocked emojis for Islamic values compliance
- **Desktop Key Handling** -- Handles Enter (send) and Shift+Enter (newline) on desktop platforms
- **Voice/Video Call Buttons** -- Initiates voice-only or video call with peer validation
- **Incoming Call Dialog** -- Modal dialog for accepting/rejecting incoming calls with video option
- **Rename Peer Dialog** -- Modal for changing peer alias with immediate UI update
- **Delete Conversation** -- Confirms and removes peer, clears messages, disconnects connection
- **Peer Information Sheet** -- Modal showing peer name, ID, IP, connection status, last seen timestamp
- **Fingerprint Verification** -- Expandable section for comparing X25519 public key fingerprints for MITM detection
- **End-to-End Encryption Info** -- Displays encryption method (X25519 + ChaCha20-Poly1305)

---

## App -- Channels

- **Channel Creation** -- Create new channel with Ed25519 signing and X25519 encryption keypairs, generate channel ID, create signed manifest
- **Channel Subscription** -- Subscribe to channel by verifying signed manifest and storing public key + encryption key
- **Channel Link Encoding/Decoding** -- Encode/decode channel manifest and decryption key into self-contained invite link (zajel://channel/...)
- **Channel Manifest** -- Signed metadata containing channel name, description, owner/admin keys, encryption key, epoch, and rules
- **Channel Rules** -- Configurable rules for channel behavior (replies, polls, max upstream size, allowed content types)
- **Chunk Model** -- Atomic unit of content with plaintext header, signed envelope, and encrypted payload
- **Content Splitting into Chunks** -- Split encrypted payload into fixed 64KB chunks, encrypt with channel key, sign each chunk
- **Chunk Reassembly** -- Reassemble chunks by sequence and chunk index with overflow protection
- **Subscriber 5-Step Verification** -- Verify chunk authenticity (signature, authorization, manifest, trusted owner, decryptability)
- **Channel Sync Service** -- Synchronize chunks between client and relay server via WebSocket messaging
- **Swarm Seeding** -- Subscribers announce and push chunks for peer-to-peer content distribution
- **Admin Management** -- Appoint/remove admins, rotate encryption keys on member removal
- **Upstream Messaging** -- Reply, vote, and reaction messages from subscriber to owner
- **Polling** -- Create polls with question/options, collect votes, tally results
- **Live Streaming** -- Live video/audio streaming with encrypted frames
- **RTMP Ingest** -- Protocol adapter converting RTMP/FLV frames to live stream frames
- **Routing Hash Service** -- Rotating HMAC-derived hashes for DHT lookup and censorship resistance
- **Background Sync** -- Periodic background sync using Android WorkManager / iOS BGAppRefresh
- **Responsive Layout** -- Channel list sidebar on wide screens, split-view detail on large displays

---

## App -- Groups

- **Group Creation** -- Creates new group with UUID, adds creator as first member, generates sender key
- **Member Management** -- Add/remove members, accept invitations, rotate keys for forward secrecy
- **Group Messaging** -- Send and receive encrypted messages with sender key encryption and deduplication
- **Vector Clock** -- Causal ordering tracking per-device sequence numbers with merge, comparison, and gap detection
- **Group Sync** -- Vector clock-based sync (get clock, compute missing messages, apply batch)
- **Sender Key Encryption** -- ChaCha20-Poly1305 AEAD with in-memory key cache and secure export/import
- **Group Invitation** -- Send/receive group invitations over existing 1:1 P2P channels
- **Group Message Relay** -- Route encrypted group messages over 1:1 connections
- **Group Connection Service** -- Mesh WebRTC data channel management for full N*(N-1)/2 connections

---

## App -- Call / VoIP

- **Call Screen** -- Full-screen call interface with remote video, local preview, call state, and controls
- **Call State Management** -- States: idle, outgoing, incoming, connecting, connected, ended
- **Outgoing Call** -- Creates peer connection, adds local tracks, sends SDP offer with 60s timeout
- **Incoming Call** -- Receives call offer, shows dialog, creates peer connection
- **Call Answer/Reject/Hangup** -- Accept with optional video, reject with reason, end active call
- **Media Controls** -- Toggle audio mute, video on/off, switch cameras during active call
- **ICE Candidate Handling** -- Queue candidates if remote description not set (max 100), add when ready
- **Audio Processing** -- Noise suppression, echo cancellation, automatic gain control
- **Background Blur** -- Video background blur/replacement processing for privacy
- **Android Foreground Service** -- Foreground notification for active calls

---

## App -- Connection & Pairing

- **Server Discovery** -- SWIM gossip protocol server discovery, WebSocket connection
- **Pairing Code Generation** -- Cryptographically secure 6-character code using rejection sampling
- **QR Code Sharing/Scanning** -- Display and scan pairing codes (zajel:// URI format)
- **Pairing Code Entry** -- Manual code input with validation
- **Web Browser Linking** -- Create link sessions for web browser pairing with QR codes (5-minute expiration)
- **Linked Devices Management** -- List linked web devices, revoke linked devices
- **Rendezvous System** -- Meeting points (daily SHA-256 hashes) and hourly tokens (HMAC-SHA256) for trusted peer discovery
- **Dead Drops** -- Encrypted connection info left at meeting points for offline reconnection (48-hour TTL)
- **Live Matching** -- Real-time peer discovery when both online at same meeting point
- **Trusted Peer Migration** -- Detect and migrate trusted peers reconnecting with new pairing codes

---

## App -- Contacts & Home

- **Trusted Peers Listing** -- Fetches all trusted peers, filters blocked, sorts alphabetically
- **Contact Search** -- Real-time filter by name or alias
- **Online Status Detection** -- Match peers by ID or public key, detect migration
- **Contact Management** -- Alias editing, block/unblock, permanent removal
- **Home Screen** -- Peer list split into online/offline groups, connection status, action buttons
- **Responsive Layout** -- 720px breakpoint: sidebar (320px) + chat split-view on wide screens

---

## App -- Settings & Onboarding

- **Settings Screen** -- Profile, Appearance, Notifications, Audio/Video, Privacy/Security, Debugging, About, Help
- **Notification Settings** -- DND controls, sound/preview toggles, per-peer muting
- **Media Settings** -- Audio input/output selection, camera preview, audio processing, background blur
- **Blocked Peers Screen** -- View and manage blocked users
- **Onboarding** -- 4-step tutorial: Welcome, Your Identity, How to Connect, You're Ready
- **Help System** -- 8 articles covering encryption, pairing, storage, troubleshooting

---

## App -- Attestation

- **Attestation Initializer** -- Orchestrator for version check, registration, and anti-tamper checks
- **Version Check** -- Semver comparison against minimum/recommended/blocked versions
- **Anti-Tamper** -- Debugger, root/jailbreak, and emulator detection
- **Binary Attestation** -- HMAC-SHA256 challenge-response against reference binary regions
- **Server Attestation** -- Ed25519 signature verification of bootstrap server responses
- **Session Tokens** -- 1-hour tokens issued after successful attestation

---

## App -- Core Infrastructure

- **Crypto Service** -- X25519 ECDH + HKDF session keys + ChaCha20-Poly1305 encryption
- **Public Key Fingerprinting** -- SHA-256 fingerprint for out-of-band MITM detection
- **Bootstrap Verifier** -- Ed25519 signature + timestamp freshness on bootstrap responses
- **WebRTC Service** -- Full P2P lifecycle: SDP, ICE, data channels (message + file)
- **Signaling Client** -- WSS connection with certificate pinning and heartbeat
- **Connection Manager** -- Central coordinator for pairing, WebRTC, crypto, messaging, migration
- **Message Protocol** -- Binary wire format with version, type, flags, handshake, and file chunk encoding
- **SQLite Storage** -- Per-peer message storage with pagination, status tracking, cleanup, migration
- **Secure Peer Storage** -- Platform Keychain/Keystore for trusted peer public keys
- **Media Service** -- Cross-platform media permissions, device enumeration, audio processing
- **Notification Service** -- Local notifications for messages, calls, peer status, files
- **Logger Service** -- Daily rotating log files (5MB, 7-day retention) with real-time streaming

---

## Server

- **Request Dispatcher** -- Routes HTTP/WebSocket to Durable Objects
- **Signaling Room** -- WebSocket SDP/ICE relay with pairing code routing
- **Relay Registry** -- Peer capacity tracking with load-balanced selection
- **Rendezvous System** -- Daily meeting points (48h TTL), hourly tokens (3h TTL), dead drops, live matching
- **Chunk Index** -- Source tracking (1h TTL), server cache (30min, 1000 max LRU), multicast optimization
- **Server Bootstrap** -- VPS registration/listing with Ed25519-signed responses
- **Attestation Registry** -- Device registration, binary challenges, version policy, session tokens
- **Ed25519 Crypto** -- Key import, signing, verification, session tokens, semver comparison

---

## Website

- **Landing Page** -- Hero section, feature grid, platform downloads with GitHub release integration
- **User Guide** -- Getting started, peer discovery, messaging, security docs, FAQ, troubleshooting
- **Platform Detection** -- Client-side OS detection for recommended download
- **Navigation and Footer** -- Sticky header, footer with links to GitHub, privacy, user guide
- **Responsive Design** -- Mobile breakpoints for navigation, hero, download grid
