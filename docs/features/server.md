# Server (Signaling Server) Features

## Core Routing & API Endpoints

### Request Dispatcher
- **Location**: `packages/server/src/index.js:L24-145`
- **Description**: Main Cloudflare Worker fetch handler that routes HTTP requests to appropriate Durable Objects and endpoints

### CORS Headers
- **Location**: `packages/server/src/index.js:L28-33`
- **Description**: Provides cross-origin resource sharing headers for all responses

### Health Check Endpoint
- **Location**: `packages/server/src/index.js:L41-55`
- **Description**: GET /health endpoint that returns service status with timestamp

### API Information Endpoint
- **Location**: `packages/server/src/index.js:L58-85`
- **Description**: GET / and GET /api/info endpoints listing all available API endpoints and service details

### Signed Bootstrap Response
- **Location**: `packages/server/src/index.js:L88-115`
- **Description**: GET /servers endpoint that adds timestamp and Ed25519 signature to server registry responses

## WebSocket Signaling

### Signaling Room
- **Location**: `packages/server/src/signaling-room.js:L1-202`
- **Description**: Durable Object managing WebSocket connections for WebRTC signaling between paired clients

### WebSocket Pairing Code Registration
- **Location**: `packages/server/src/signaling-room.js:L83-120`
- **Description**: Handles 'register' message type to register WebSocket connections with pairing codes

### WebSocket Signaling Message Forwarding
- **Location**: `packages/server/src/signaling-room.js:L122-158`
- **Description**: Routes 'offer', 'answer', 'ice_candidate' WebRTC signaling messages between paired peers

### Peer Join/Leave Notifications
- **Location**: `packages/server/src/signaling-room.js:L160-190`
- **Description**: Broadcasts 'peer_joined' and 'peer_left' messages to all connected peers

### WebSocket Error Handling
- **Location**: `packages/server/src/signaling-room.js:L35-58`
- **Description**: Handles WebSocket message parsing, errors, and connection lifecycle events

## Relay Registry (P2P Relay Peer Tracking)

### Relay Peer Registration
- **Location**: `packages/server/src/relay-registry.js:L22-34`
- **Description**: Register peers as available relays with capacity information and optional public key

### Load Tracking
- **Location**: `packages/server/src/relay-registry.js:L50-56`
- **Description**: Update connection count (load) for a registered peer to track capacity usage

### Available Relay Selection
- **Location**: `packages/server/src/relay-registry.js:L65-88`
- **Description**: Get list of available relays with <50% capacity, load-balanced with Fisher-Yates shuffle

### Peer Unregistration
- **Location**: `packages/server/src/relay-registry.js:L94-96`
- **Description**: Remove a peer from the relay registry on disconnect

### Registry Statistics
- **Location**: `packages/server/src/relay-registry.js:L110-131`
- **Description**: Get metrics about total peers, capacity, connected count, and available relays

## Rendezvous System (Peer Discovery)

### Daily Meeting Points with Dead Drops
- **Location**: `packages/server/src/rendezvous-registry.js:L37-74`
- **Description**: Register daily meeting point hashes with encrypted dead drop messages for offline peer discovery (48-hour TTL)

### Hourly Token Live Matching
- **Location**: `packages/server/src/rendezvous-registry.js:L84-127`
- **Description**: Register hourly tokens for real-time peer matching with match notifications (3-hour TTL)

### Dead Drop Retrieval
- **Location**: `packages/server/src/rendezvous-registry.js:L37-73`
- **Description**: Return encrypted dead drop messages left by other peers at the same daily meeting point

### Live Match Notification
- **Location**: `packages/server/src/rendezvous-registry.js:L107-109`
- **Description**: Notify original peers via callback when a new peer matches their hourly token

### Peer Unregistration
- **Location**: `packages/server/src/rendezvous-registry.js:L171-191`
- **Description**: Remove a peer from all daily points and hourly tokens on disconnect

### Expiration Cleanup
- **Location**: `packages/server/src/rendezvous-registry.js:L143-165`
- **Description**: Clean up expired entries from daily points (>48 hours) and hourly tokens (>3 hours)

### Registry Statistics
- **Location**: `packages/server/src/rendezvous-registry.js:L197-216`
- **Description**: Get metrics about daily points, hourly tokens, and total entries

## Chunk Distribution System

### Chunk Source Announcement
- **Location**: `packages/server/src/chunk-index.js:L65-96`
- **Description**: Register peers as sources for one or more chunks with routing hash and expiration tracking (1-hour TTL)

### Chunk Source Tracking
- **Location**: `packages/server/src/chunk-index.js:L104-122`
- **Description**: Get list of online sources for a chunk and check chunk availability

### Chunk Cache Management
- **Location**: `packages/server/src/chunk-index.js:L135-169`
- **Description**: Cache chunk data on server with 30-minute TTL, register server as source, max 1000 entries with LRU eviction

### Cached Chunk Retrieval
- **Location**: `packages/server/src/chunk-index.js:L177-204`
- **Description**: Retrieve cached chunks with expiration checks, track access counts, return null if expired/missing

### Pending Request Management
- **Location**: `packages/server/src/chunk-index.js:L219-262`
- **Description**: Track pending requests for chunks (multicast optimization: pull once from source, serve many subscribers)

### Peer Chunk Cleanup
- **Location**: `packages/server/src/chunk-index.js:L273-292`
- **Description**: Remove all chunk sources and pending requests for a disconnected peer

### Chunk Index Cleanup
- **Location**: `packages/server/src/chunk-index.js:L301-327`
- **Description**: Clean up expired chunk sources (>1 hour), expired cache entries (>30 minutes), stale pending requests (>5 minutes)

### Chunk Index Statistics
- **Location**: `packages/server/src/chunk-index.js:L338-355`
- **Description**: Get metrics about tracked chunks, total sources, cached chunks, pending requests

## WebSocket Message Handler

### Message Type Dispatcher
- **Location**: `packages/server/src/websocket-handler.js:L52-104`
- **Description**: Routes incoming WebSocket messages to appropriate handlers by message type

### Peer Registration Handler
- **Location**: `packages/server/src/websocket-handler.js:L111-136`
- **Description**: Handle 'register' messages to add peer to relay registry and return available relays

### Load Update Handler
- **Location**: `packages/server/src/websocket-handler.js:L143-153`
- **Description**: Handle 'update_load' messages to track peer connection count

### Rendezvous Registration Handler
- **Location**: `packages/server/src/websocket-handler.js:L160-187`
- **Description**: Handle 'register_rendezvous' to register daily points with dead drops and hourly tokens with live matching

### Get Relays Handler
- **Location**: `packages/server/src/websocket-handler.js:L194-203`
- **Description**: Handle 'get_relays' to return available relay list at any time

### Ping/Pong Handler
- **Location**: `packages/server/src/websocket-handler.js:L93-95`
- **Description**: Respond to 'ping' messages with 'pong' for connection keep-alive

### Heartbeat Handler
- **Location**: `packages/server/src/websocket-handler.js:L210-223`
- **Description**: Handle 'heartbeat' messages to update peer's last-seen timestamp

### Chunk Announce Handler
- **Location**: `packages/server/src/websocket-handler.js:L235-272`
- **Description**: Handle 'chunk_announce' to register chunk sources and trigger pulls if pending requests exist

### Chunk Request Handler
- **Location**: `packages/server/src/websocket-handler.js:L280-338`
- **Description**: Handle 'chunk_request' to serve from cache, find online source, or queue pending request

### Chunk Push Handler
- **Location**: `packages/server/src/websocket-handler.js:L347-388`
- **Description**: Handle 'chunk_push' to cache chunk data (max 64KB) and multicast to all pending requesters

### Peer Disconnect Handler
- **Location**: `packages/server/src/websocket-handler.js:L395-411`
- **Description**: Clean up registries on peer disconnect (relay, rendezvous, chunks, WebSocket mapping)

## Relay Registry Durable Object

### Durable Object Initialization
- **Location**: `packages/server/src/durable-objects/relay-registry-do.js:L13-44`
- **Description**: Initialize RelayRegistry, RendezvousRegistry, ChunkIndex, WebSocketHandler, and schedule cleanup alarms

### Periodic Cleanup Alarm
- **Location**: `packages/server/src/durable-objects/relay-registry-do.js:L50-57`
- **Description**: Run cleanup on rendezvous and chunk index every 5 minutes

### HTTP Stats Endpoint
- **Location**: `packages/server/src/durable-objects/relay-registry-do.js:L66-75`
- **Description**: GET /stats endpoint returning relay registry, rendezvous, chunk, and connection statistics

### WebSocket Upgrade
- **Location**: `packages/server/src/durable-objects/relay-registry-do.js:L62-93`
- **Description**: Handle HTTP upgrade request to WebSocket

## Server Bootstrap Registry

### Server Registration
- **Location**: `packages/server/src/durable-objects/server-registry-do.js:L62-88`
- **Description**: POST /servers to register VPS server with endpoint, public key, and region (5-minute TTL)

### Server Listing
- **Location**: `packages/server/src/durable-objects/server-registry-do.js:L90-111`
- **Description**: GET /servers to list active registered servers, auto-cleanup stale entries

### Server Unregistration
- **Location**: `packages/server/src/durable-objects/server-registry-do.js:L113-120`
- **Description**: DELETE /servers/:serverId to unregister a server

### Server Heartbeat
- **Location**: `packages/server/src/durable-objects/server-registry-do.js:L122-160`
- **Description**: POST /servers/heartbeat to update server's lastSeen timestamp and return peer list

## Device Attestation

### Device Registration
- **Location**: `packages/server/src/durable-objects/attestation-registry-do.js:L107-231`
- **Description**: POST /attest/register to register device with signed build token, validate version policy

### Reference Binary Upload
- **Location**: `packages/server/src/durable-objects/attestation-registry-do.js:L239-304`
- **Description**: POST /attest/upload-reference for CI to upload reference binary metadata with critical regions (requires CI_UPLOAD_SECRET)

### Attestation Challenge Generation
- **Location**: `packages/server/src/durable-objects/attestation-registry-do.js:L311-381`
- **Description**: POST /attest/challenge to generate nonce and select random 3-5 critical regions for device to prove

### Challenge Verification
- **Location**: `packages/server/src/durable-objects/attestation-registry-do.js:L388-522`
- **Description**: POST /attest/verify to verify HMAC-SHA256 responses and issue session token (1-hour TTL), replay prevention with one-time nonces

### Version Policy Management
- **Location**: `packages/server/src/durable-objects/attestation-registry-do.js:L528-578`
- **Description**: GET/POST /attest/versions to retrieve and update minimum, recommended, blocked versions (admin-only)

## Cryptography

### Ed25519 Signing Key Import
- **Location**: `packages/server/src/crypto/signing.js:L27-46`
- **Description**: Import Ed25519 signing key from 32-byte hex-encoded seed with PKCS8 wrapping

### Ed25519 Payload Signing
- **Location**: `packages/server/src/crypto/signing.js:L54-58`
- **Description**: Sign UTF-8 string payload with Ed25519 and return base64 signature

### Ed25519 Verification Key Import
- **Location**: `packages/server/src/crypto/attestation.js:L15-31`
- **Description**: Import Ed25519 public key from base64-encoded 32-byte raw key with SPKI wrapping

### Build Token Signature Verification
- **Location**: `packages/server/src/crypto/attestation.js:L86-90`
- **Description**: Verify Ed25519 signature on build token payload

### HMAC-SHA256 Computation
- **Location**: `packages/server/src/crypto/attestation.js:L122-133`
- **Description**: Compute HMAC-SHA256 over binary data with nonce as key, return hex-encoded result

### Nonce Generation
- **Location**: `packages/server/src/crypto/attestation.js:L109-113`
- **Description**: Generate cryptographically random 32-byte nonce and return as hex string

### Session Token Creation
- **Location**: `packages/server/src/crypto/attestation.js:L141-146`
- **Description**: Create signed session token in format: base64(payload).base64(signature), 1-hour expiration

### Session Token Verification
- **Location**: `packages/server/src/crypto/attestation.js:L154-174`
- **Description**: Verify and decode session token, check expiration

### Semver Version Comparison
- **Location**: `packages/server/src/crypto/attestation.js:L182-193`
- **Description**: Compare semantic version strings, return -1/0/1 for less/equal/greater

## Logging

### Environment-Aware Logger
- **Location**: `packages/server/src/logger.js:L39-135`
- **Description**: Logger with environment detection (production vs development), configurable log levels

### Pairing Code Redaction
- **Location**: `packages/server/src/logger.js:L19-22`
- **Description**: Redact pairing codes in production showing only first and last characters

## Configuration

### Wrangler Configuration
- **Location**: `packages/server/wrangler.jsonc:L1-76`
- **Description**: Cloudflare Worker config with Durable Object bindings (ServerRegistryDO, AttestationRegistryDO) and environment setup

### Custom Domain Routes
- **Location**: `packages/server/wrangler.jsonc:L45-47`
- **Description**: Production domain routing to signal.zajel.hamzalabs.dev

### Environment Configuration
- **Location**: `packages/server/wrangler.jsonc:L56-75`
- **Description**: QA environment configuration with separate Durable Objects and domain

### Durable Object Migrations
- **Location**: `packages/server/wrangler.jsonc:L24-42`
- **Description**: Versioned migrations (v1: SignalingRoom, v2: RelayRegistryDO, v3: ServerRegistryDO, v4: AttestationRegistryDO)

## Testing

### WebSocket Handler Tests
- **Location**: `packages/server/src/__tests__/websocket-handler.test.js:L1-438`
- **Description**: Test peer registration, load updates, rendezvous, relay queries, heartbeats, disconnect handling

### Relay Registry Tests
- **Location**: `packages/server/src/__tests__/relay-registry.test.js:L1-236`
- **Description**: Test peer registration, capacity tracking, available relay selection, shuffling, statistics

### Rendezvous Registry Tests
- **Location**: `packages/server/src/__tests__/rendezvous-registry.test.js:L1-454`
- **Description**: Test daily points, dead drops, hourly tokens, live matching, expiration, cleanup

### Chunk Index Tests
- **Location**: `packages/server/src/__tests__/chunk-index.test.js:L1-332`
- **Description**: Test chunk announcement, source tracking, cache management, pending requests, cleanup

### WebSocket Chunk Handler Tests
- **Location**: `packages/server/src/__tests__/websocket-handler-chunks.test.js:L1-612`
- **Description**: Test chunk_announce, chunk_request, chunk_push, multicast optimization, swarm seeding
