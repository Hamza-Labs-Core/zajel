# App - Channels Features

## Channel Creation & Subscription

### Channel Creation
- **Location**: `packages/app/lib/features/channels/services/channel_service.dart:L40-88`
- **Description**: Create new channel with Ed25519 signing and X25519 encryption keypairs, generate channel ID, create signed manifest

### Channel Subscription
- **Location**: `packages/app/lib/features/channels/services/channel_service.dart:L102-124`
- **Description**: Subscribe to channel by verifying signed manifest and storing public key + encryption key

### Channel Link Encoding
- **Location**: `packages/app/lib/features/channels/services/channel_link_service.dart:L19-35`
- **Description**: Encode channel manifest and decryption key into self-contained invite link (zajel://channel/...)

### Channel Link Decoding
- **Location**: `packages/app/lib/features/channels/services/channel_link_service.dart:L40-67`
- **Description**: Decode invite link to extract manifest and encryption key for subscription

## Channel Data Models

### Channel Model
- **Location**: `packages/app/lib/features/channels/models/channel.dart:L241-356`
- **Description**: Represents owned or subscribed channel with role, manifest, signing/encryption keys, and metadata

### Channel Manifest
- **Location**: `packages/app/lib/features/channels/models/channel.dart:L99-234`
- **Description**: Signed metadata containing channel name, description, owner/admin keys, encryption key, epoch, and rules

### Channel Rules
- **Location**: `packages/app/lib/features/channels/models/channel.dart:L39-92`
- **Description**: Configurable rules for channel behavior (replies enabled, polls enabled, max upstream size, allowed content types)

### Admin Key
- **Location**: `packages/app/lib/features/channels/models/channel.dart:L15-36`
- **Description**: Admin entry with Ed25519 public key and plaintext label

### Channel Role Enum
- **Location**: `packages/app/lib/features/channels/models/channel.dart:L5-13`
- **Description**: Enum defining owner, admin, and subscriber roles with different permissions

## Content Publishing & Distribution

### Chunk Model
- **Location**: `packages/app/lib/features/channels/models/chunk.dart:L105-226`
- **Description**: Atomic unit of content with plaintext header (routing hash, sequence), signed envelope, and encrypted payload

### Chunk Payload Model
- **Location**: `packages/app/lib/features/channels/models/chunk.dart:L26-99`
- **Description**: Content type (text, file, audio, video, document, poll), raw bytes, metadata, reply reference, author, timestamp

### Content Type Enum
- **Location**: `packages/app/lib/features/channels/models/chunk.dart:L7-21`
- **Description**: Enum for text, file, audio, video, document, and poll content types

### Content Splitting into Chunks
- **Location**: `packages/app/lib/features/channels/services/channel_service.dart:L138-202`
- **Description**: Split encrypted payload into fixed 64KB chunks, encrypt with channel key, sign each chunk with author key

### Chunk Reassembly
- **Location**: `packages/app/lib/features/channels/services/channel_service.dart:L227-302`
- **Description**: Reassemble fixed-size chunks by sequence and chunk index with overflow protection and size validation

### Chunk Signature Verification
- **Location**: `packages/app/lib/features/channels/services/channel_service.dart:L316-336`
- **Description**: Verify and reassemble chunks with signature validation against authorized keys (owner + admins)

## Cryptography & Security

### Crypto Service
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L13-376`
- **Description**: Cryptographic operations for channels using Ed25519 signing and X25519 + ChaCha20-Poly1305 encryption

### Signing Key Generation
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L30-40`
- **Description**: Generate Ed25519 keypair for channel ownership and admin signing

### Encryption Key Generation
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L45-55`
- **Description**: Generate X25519 keypair for content encryption (channel members)

### Channel ID Derivation
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L62-75`
- **Description**: Derive channel ID from owner public key using SHA-256 truncated to 128 bits

### Manifest Signing
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L99-120`
- **Description**: Sign manifest with owner's Ed25519 private key using canonical JSON format

### Manifest Verification
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L127-158`
- **Description**: Verify manifest signature against owner public key with constant-time comparison

### Payload Encryption
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L190-216`
- **Description**: Encrypt chunk payload using ChaCha20-Poly1305 with HKDF-derived key

### Payload Decryption
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L221-253`
- **Description**: Decrypt chunk payload with MAC verification and authentication check

### Chunk Signing
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L262-276`
- **Description**: Sign chunk's encrypted payload with author's Ed25519 private key

### Chunk Signature Verification
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L282-304`
- **Description**: Verify chunk signature against author public key

### Subscriber 5-Step Verification
- **Location**: `packages/app/lib/features/channels/services/channel_crypto_service.dart:L321-365`
- **Description**: Verify chunk authenticity (signature, authorization, manifest validity, trusted owner, decryptability)

## Storage & Persistence

### Storage Service
- **Location**: `packages/app/lib/features/channels/services/channel_storage_service.dart:L20-362`
- **Description**: SQLite-backed storage for channels and chunks with secure key storage

### Channel Persistence
- **Location**: `packages/app/lib/features/channels/services/channel_storage_service.dart:L98-209`
- **Description**: Save/load channels from database with private keys in secure storage

### Chunk Persistence
- **Location**: `packages/app/lib/features/channels/services/channel_storage_service.dart:L214-327`
- **Description**: Store chunks indexed by channel, sequence, and routing hash; retrieve by ID or message

### Database Initialization
- **Location**: `packages/app/lib/features/channels/services/channel_storage_service.dart:L38-91`
- **Description**: Create SQLite tables for channels and chunks with indices for query performance

### Latest Sequence Lookup
- **Location**: `packages/app/lib/features/channels/services/channel_storage_service.dart:L314-326`
- **Description**: Get latest sequence number for channel to determine next message sequence

## Synchronization

### Sync Service
- **Location**: `packages/app/lib/features/channels/services/channel_sync_service.dart:L29-393`
- **Description**: Synchronize chunks between client and relay server via WebSocket messaging

### Chunk Announcement
- **Location**: `packages/app/lib/features/channels/services/channel_sync_service.dart:L130-190`
- **Description**: Announce locally held chunks to relay server for peer discovery and swarm seeding

### Chunk Request
- **Location**: `packages/app/lib/features/channels/services/channel_sync_service.dart:L196-237`
- **Description**: Request chunks from relay by ID or metadata (routing hash, sequence, index)

### Chunk Push
- **Location**: `packages/app/lib/features/channels/services/channel_sync_service.dart:L243-258`
- **Description**: Push chunk data to server when another subscriber needs it (swarm seeding)

### Periodic Sync
- **Location**: `packages/app/lib/features/channels/services/channel_sync_service.dart:L85-108`
- **Description**: Start/stop periodic synchronization with configurable interval (default 5 minutes)

### Server Message Handling
- **Location**: `packages/app/lib/features/channels/services/channel_sync_service.dart:L277-393`
- **Description**: Handle incoming messages (chunk_data, chunk_pull, chunk_available, chunk_not_found)

## Admin Management

### Admin Management Service
- **Location**: `packages/app/lib/features/channels/services/admin_management_service.dart:L11-120`
- **Description**: Manage admin permissions, add/remove admins, rotate encryption keys on member removal

### Appoint Admin
- **Location**: `packages/app/lib/features/channels/services/admin_management_service.dart:L35-69`
- **Description**: Add admin public key to manifest and re-sign (owner only)

### Remove Admin
- **Location**: `packages/app/lib/features/channels/services/admin_management_service.dart:L80-119`
- **Description**: Remove admin from manifest and rotate encryption key to revoke access

### Admin Authorization Validation
- **Location**: `packages/app/lib/features/channels/services/admin_management_service.dart:L129-138`
- **Description**: Check if public key is authorized admin or publisher in manifest

### Upstream Message Validation
- **Location**: `packages/app/lib/features/channels/services/admin_management_service.dart:L148-168`
- **Description**: Validate upstream messages against channel rules (replies, polls, size limits)

### Update Channel Rules
- **Location**: `packages/app/lib/features/channels/services/admin_management_service.dart:L173-192`
- **Description**: Modify channel rules (replies, polls, content types, max upstream size)

### Encryption Key Rotation
- **Location**: `packages/app/lib/features/channels/services/channel_service.dart:L421-447`
- **Description**: Generate new X25519 key and increment epoch (owner only)

### Add Admin
- **Location**: `packages/app/lib/features/channels/services/channel_service.dart:L364-389`
- **Description**: Add admin to manifest and re-sign (owner only)

### Remove Admin
- **Location**: `packages/app/lib/features/channels/services/channel_service.dart:L392-415`
- **Description**: Remove admin from manifest and re-sign (owner only)

## Upstream Messaging

### Upstream Message Model
- **Location**: `packages/app/lib/features/channels/models/upstream_message.dart:L25-95`
- **Description**: Encrypted message from subscriber to owner with ephemeral signature and sender key

### Upstream Payload Model
- **Location**: `packages/app/lib/features/channels/models/upstream_message.dart:L98-166`
- **Description**: Decrypted upstream message (reply, vote, reaction) visible only to owner

### Upstream Message Types
- **Location**: `packages/app/lib/features/channels/models/upstream_message.dart:L10-19`
- **Description**: Enum for reply, vote, and reaction message types

### Reply Thread
- **Location**: `packages/app/lib/features/channels/models/upstream_message.dart:L169-194`
- **Description**: Groups replies by parent message ID with sorted chronological order

### Upstream Service
- **Location**: `packages/app/lib/features/channels/services/upstream_service.dart:L25-136`
- **Description**: Handle subscriber to owner messaging with encryption, ephemeral keys, and queuing

### Send Reply
- **Location**: `packages/app/lib/features/channels/services/upstream_service.dart:L70-87`
- **Description**: Send reply message to channel owner (subscribers only)

### Send Vote
- **Location**: `packages/app/lib/features/channels/services/upstream_service.dart:L94-112`
- **Description**: Send poll vote to channel owner (subscribers only)

### Send Reaction
- **Location**: `packages/app/lib/features/channels/services/upstream_service.dart:L119-136`
- **Description**: Send emoji reaction to message to channel owner (subscribers only)

## Polling

### Poll Model
- **Location**: `packages/app/lib/features/channels/services/poll_service.dart:L34-89`
- **Description**: Poll definition with question, options, multiple selection flag, and close time

### Poll Option
- **Location**: `packages/app/lib/features/channels/services/poll_service.dart:L14-31`
- **Description**: Poll option with index and label

### Poll Results
- **Location**: `packages/app/lib/features/channels/services/poll_service.dart:L92-138`
- **Description**: Aggregated poll results with vote counts per option and finality flag

### Poll Service
- **Location**: `packages/app/lib/features/channels/services/poll_service.dart:L147-162`
- **Description**: Service for creating polls, collecting votes, and tallying results

### Create Poll
- **Location**: `packages/app/lib/features/channels/services/poll_service.dart:L171-200`
- **Description**: Create poll broadcast chunk with question and options (owner only)

## Live Streaming

### Live Stream Metadata
- **Location**: `packages/app/lib/features/channels/models/live_stream.dart:L19-117`
- **Description**: Stream session metadata (ID, channel, title, state, start/end time, viewer count, frame count)

### Live Stream Frame
- **Location**: `packages/app/lib/features/channels/models/live_stream.dart:L124-181`
- **Description**: Single encrypted stream frame with index, signature, author, and timestamp

### Live Stream State
- **Location**: `packages/app/lib/features/channels/models/live_stream.dart:L7-16`
- **Description**: Enum for stream states (starting, live, ended)

### Live Stream Service
- **Location**: `packages/app/lib/features/channels/services/live_stream_service.dart:L33-200`
- **Description**: Service for starting streams, sending frames, recording frames for VOD

### Start Stream
- **Location**: `packages/app/lib/features/channels/services/live_stream_service.dart:L89-129`
- **Description**: Start new live stream with title (owner only, notifies VPS)

### Send Frame
- **Location**: `packages/app/lib/features/channels/services/live_stream_service.dart:L137-200`
- **Description**: Encrypt and send video/audio frame to active stream via WebSocket

## RTMP Ingest

### RTMP Frame
- **Location**: `packages/app/lib/features/channels/services/rtmp_ingest_service.dart:L30-109`
- **Description**: RTMP/FLV frame with tag type (audio/video/script), timestamp, and payload

### RTMP Tag Type
- **Location**: `packages/app/lib/features/channels/services/rtmp_ingest_service.dart:L8-28`
- **Description**: Enum for FLV tag types (audio 8, video 9, script data 18)

### RTMP Ingest Service
- **Location**: `packages/app/lib/features/channels/services/rtmp_ingest_service.dart:L138-150`
- **Description**: Protocol adapter converting RTMP/FLV frames to live stream frames

## Routing & Censorship Resistance

### Routing Hash Service
- **Location**: `packages/app/lib/features/channels/services/routing_hash_service.dart:L112-200`
- **Description**: Generate rotating routing hashes for DHT lookup and censorship resistance

### Routing Hash Derivation
- **Location**: `packages/app/lib/features/channels/services/routing_hash_service.dart:L136-145`
- **Description**: Derive current routing hash using HMAC with epoch period (hourly/daily)

### Historic Routing Hash
- **Location**: `packages/app/lib/features/channels/services/routing_hash_service.dart:L151-158`
- **Description**: Derive routing hash for specific past epoch for catch-up

### Epoch Number Calculation
- **Location**: `packages/app/lib/features/channels/services/routing_hash_service.dart:L161-181`
- **Description**: Get current or range of epoch numbers for time period

### Censorship Detection
- **Location**: `packages/app/lib/features/channels/services/routing_hash_service.dart:L188-200`
- **Description**: Track fetch results per routing hash to detect blocking patterns

### Routing Hash Epoch Duration
- **Location**: `packages/app/lib/features/channels/services/routing_hash_service.dart:L12-18`
- **Description**: Enum for hourly or daily hash rotation

## Background Synchronization

### Background Sync Service
- **Location**: `packages/app/lib/features/channels/services/background_sync_service.dart:L72-200`
- **Description**: Periodic background sync of channel chunks using platform background task schedulers

### Sync Result
- **Location**: `packages/app/lib/features/channels/services/background_sync_service.dart:L16-43`
- **Description**: Result metrics from sync run (channels checked, chunks downloaded, errors, duration)

### Background Task Registration
- **Location**: `packages/app/lib/features/channels/services/background_sync_service.dart:L143-172`
- **Description**: Register periodic tasks with platform (Android WorkManager, iOS BGAppRefresh)

### Periodic Sync
- **Location**: `packages/app/lib/features/channels/services/background_sync_service.dart:L72-122`
- **Description**: Configure and manage periodic synchronization intervals

## User Interface

### Main Screen (Responsive Layout)
- **Location**: `packages/app/lib/features/channels/channels_main_screen.dart:L19-37`
- **Description**: Responsive screen showing channel list sidebar on wide screens, split-view detail on large displays

### Wide Layout with Sidebar
- **Location**: `packages/app/lib/features/channels/channels_main_screen.dart:L39-67`
- **Description**: Split-view with channel sidebar and detail panel side-by-side for desktop

### Channel Sidebar
- **Location**: `packages/app/lib/features/channels/channels_main_screen.dart:L101-208`
- **Description**: Collapsible sidebar showing channel list with selection, create/subscribe buttons

### Channels List Screen
- **Location**: `packages/app/lib/features/channels/channels_list_screen.dart:L13-231`
- **Description**: Full-screen channel list for narrow/mobile displays with create and subscribe options

### Create Channel Dialog
- **Location**: `packages/app/lib/features/channels/channels_list_screen.dart:L17-73`
- **Description**: Dialog to create new channel with name and optional description input

### Subscribe Dialog
- **Location**: `packages/app/lib/features/channels/channels_list_screen.dart:L76-140`
- **Description**: Dialog to paste channel invite link and subscribe to existing channel

### Channel Detail Screen
- **Location**: `packages/app/lib/features/channels/channel_detail_screen.dart:L18-643`
- **Description**: Display channel messages, show compose bar for owners/admins, display channel info

### Embedded Channel Header
- **Location**: `packages/app/lib/features/channels/channel_detail_screen.dart:L135-194`
- **Description**: Minimal header for embedded mode (split-view) showing channel name and role

### Channel Banner
- **Location**: `packages/app/lib/features/channels/channel_detail_screen.dart:L196-228`
- **Description**: Display channel description and user role badge

### Message List
- **Location**: `packages/app/lib/features/channels/channel_detail_screen.dart:L259-270`
- **Description**: ScrollView of messages with timestamp and author information

### Message Bubble
- **Location**: `packages/app/lib/features/channels/channel_detail_screen.dart:L272-317`
- **Description**: Display single message with author, timestamp, and selectable text content

### Compose Bar
- **Location**: `packages/app/lib/features/channels/channel_detail_screen.dart:L319-371`
- **Description**: Text input field with send button for publishing messages (owner/admin only)

### Share Dialog
- **Location**: `packages/app/lib/features/channels/channel_detail_screen.dart:L461-529`
- **Description**: Show and copy channel invite link (owner only)

### Channel Info Sheet
- **Location**: `packages/app/lib/features/channels/channel_detail_screen.dart:L531-603`
- **Description**: Display channel metadata (name, description, role, key epoch, rules, admins)

## Publishing & Content

### Publish Message
- **Location**: `packages/app/lib/features/channels/channel_detail_screen.dart:L373-459`
- **Description**: Create chunk payload, encrypt, sign, save locally, announce to relay, refresh display

### Content Type Validation
- **Location**: `packages/app/lib/features/channels/services/channel_service.dart:L349-355`
- **Description**: Validate decrypted payload's content type against channel rules

## Message Display

### Message Display Model
- **Location**: `packages/app/lib/features/channels/providers/channel_providers.dart:L218-232`
- **Description**: Displayable message decoded from chunks (sequence, type, text, timestamp, author)

### Message Provider
- **Location**: `packages/app/lib/features/channels/providers/channel_providers.dart:L239-293`
- **Description**: Riverpod provider fetching all chunks for channel, grouping by sequence, decrypting and reassembling

## Providers & State Management

### Channel Providers
- **Location**: `packages/app/lib/features/channels/providers/channel_providers.dart:L1-294`
- **Description**: Riverpod providers for channels, services, and data access

### Selected Channel ID Provider
- **Location**: `packages/app/lib/features/channels/providers/channel_providers.dart:L215`
- **Description**: StateProvider tracking currently selected channel ID in split-view
