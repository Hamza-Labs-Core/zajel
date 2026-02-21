# Code Index

A developer reference mapping features to their implementation locations. All paths are relative to the repository root.

---

## App -- Core Crypto

| Feature | Location |
|---------|----------|
| Key Exchange Service (X25519 ECDH + HKDF) | `packages/app/lib/core/crypto/crypto_service.dart` |
| Session Key Management | `packages/app/lib/core/crypto/crypto_service.dart:L59-218` |
| Identity Key Persistence | `packages/app/lib/core/crypto/crypto_service.dart:L326-354` |
| ChaCha20-Poly1305 Encryption/Decryption | `packages/app/lib/core/crypto/crypto_service.dart:L221-286` |
| Public Key Fingerprinting (SHA-256) | `packages/app/lib/core/crypto/crypto_service.dart:L69-128` |
| Bootstrap Server Verification (Ed25519) | `packages/app/lib/core/crypto/bootstrap_verifier.dart` |

## App -- Core Network

| Feature | Location |
|---------|----------|
| WebRTC Peer Connection Lifecycle | `packages/app/lib/core/network/webrtc_service.dart:L35-571` |
| Data Channels (messages + files) | `packages/app/lib/core/network/webrtc_service.dart:L429-471` |
| ICE Candidate Queuing (max 100) | `packages/app/lib/core/network/webrtc_service.dart:L177-229` |
| Encrypted File Chunking (16KB) | `packages/app/lib/core/network/webrtc_service.dart:L245-299` |
| WebSocket Connection (+ cert pinning) | `packages/app/lib/core/network/signaling_client.dart:L184-312` |
| Certificate Pinning (native platforms) | `packages/app/lib/core/network/pinned_websocket.dart` |
| Heartbeat Protocol (30s) | `packages/app/lib/core/network/signaling_client.dart:L759-770` |
| Pairing Code Generation (rejection sampling) | `packages/app/lib/core/network/connection_manager.dart:L19-73` |
| Connection Manager (central coordinator) | `packages/app/lib/core/network/connection_manager.dart:L92-1209` |
| Trusted Peer Migration | `packages/app/lib/core/network/connection_manager.dart:L658-723` |
| Meeting Points Derivation | `packages/app/lib/core/network/meeting_point_service.dart` |
| Rendezvous Service (dead drops + live match) | `packages/app/lib/core/network/rendezvous_service.dart` |
| Server Discovery (bootstrap) | `packages/app/lib/core/network/server_discovery_service.dart` |
| Relay Client | `packages/app/lib/core/network/relay_client.dart` |
| VoIP Service | `packages/app/lib/core/network/voip_service.dart` |
| Device Link Service (web client proxy) | `packages/app/lib/core/network/device_link_service.dart` |
| Message Protocol (binary wire format) | `packages/app/lib/core/protocol/message_protocol.dart` |

## App -- Core Storage

| Feature | Location |
|---------|----------|
| SQLite Message Storage | `packages/app/lib/core/storage/message_storage.dart` |
| Secure Peer Storage (Keychain/Keystore) | `packages/app/lib/core/storage/trusted_peers_storage_impl.dart` |
| Peer Lookup Interface | `packages/app/lib/core/storage/trusted_peers_storage.dart` |
| File Receive Service | `packages/app/lib/core/storage/file_receive_service.dart` |

## App -- Core Media

| Feature | Location |
|---------|----------|
| Media Service (permissions + devices) | `packages/app/lib/core/media/media_service.dart` |
| Background Blur Processor | `packages/app/lib/core/media/background_blur_processor.dart` |

## App -- Core Other

| Feature | Location |
|---------|----------|
| Constants (crypto, file, WebRTC, call) | `packages/app/lib/core/constants.dart` |
| Environment Configuration | `packages/app/lib/core/config/environment.dart` |
| Notification Service | `packages/app/lib/core/notifications/notification_service.dart` |
| Call Foreground Service (Android) | `packages/app/lib/core/notifications/call_foreground_service.dart` |
| Logger Service (rotating files) | `packages/app/lib/core/logging/logger_service.dart` |
| Provider Configuration (Riverpod) | `packages/app/lib/core/providers/app_providers.dart` |

---

## App -- Chat Feature

| Feature | Location |
|---------|----------|
| Chat Screen (full implementation) | `packages/app/lib/features/chat/chat_screen.dart` |
| Filtered Emoji Picker | `packages/app/lib/features/chat/widgets/filtered_emoji_picker.dart` |

## App -- Channels Feature

| Feature | Location |
|---------|----------|
| Channel Service (create, subscribe, split, reassemble) | `packages/app/lib/features/channels/services/channel_service.dart` |
| Channel Crypto Service (Ed25519 + X25519) | `packages/app/lib/features/channels/services/channel_crypto_service.dart` |
| Channel Storage Service (SQLite) | `packages/app/lib/features/channels/services/channel_storage_service.dart` |
| Channel Sync Service (WebSocket chunk sync) | `packages/app/lib/features/channels/services/channel_sync_service.dart` |
| Channel Link Service (invite link encode/decode) | `packages/app/lib/features/channels/services/channel_link_service.dart` |
| Admin Management Service | `packages/app/lib/features/channels/services/admin_management_service.dart` |
| Upstream Service (replies, votes, reactions) | `packages/app/lib/features/channels/services/upstream_service.dart` |
| Poll Service | `packages/app/lib/features/channels/services/poll_service.dart` |
| Live Stream Service | `packages/app/lib/features/channels/services/live_stream_service.dart` |
| RTMP Ingest Service | `packages/app/lib/features/channels/services/rtmp_ingest_service.dart` |
| Routing Hash Service | `packages/app/lib/features/channels/services/routing_hash_service.dart` |
| Background Sync Service | `packages/app/lib/features/channels/services/background_sync_service.dart` |
| Channel Model + Manifest + Rules | `packages/app/lib/features/channels/models/channel.dart` |
| Chunk Model + Payload | `packages/app/lib/features/channels/models/chunk.dart` |
| Upstream Message Model | `packages/app/lib/features/channels/models/upstream_message.dart` |
| Live Stream Model | `packages/app/lib/features/channels/models/live_stream.dart` |
| Channel Providers (Riverpod) | `packages/app/lib/features/channels/providers/channel_providers.dart` |
| Channels Main Screen (responsive) | `packages/app/lib/features/channels/channels_main_screen.dart` |
| Channels List Screen | `packages/app/lib/features/channels/channels_list_screen.dart` |
| Channel Detail Screen | `packages/app/lib/features/channels/channel_detail_screen.dart` |

## App -- Groups Feature

| Feature | Location |
|---------|----------|
| Group Service (orchestration) | `packages/app/lib/features/groups/services/group_service.dart` |
| Group Crypto Service (sender keys) | `packages/app/lib/features/groups/services/group_crypto_service.dart` |
| Group Storage Service (SQLite) | `packages/app/lib/features/groups/services/group_storage_service.dart` |
| Group Sync Service (vector clocks) | `packages/app/lib/features/groups/services/group_sync_service.dart` |
| Group Invitation Service (1:1 relay) | `packages/app/lib/features/groups/services/group_invitation_service.dart` |
| Group Connection Service (mesh WebRTC) | `packages/app/lib/features/groups/services/group_connection_service.dart` |
| WebRTC P2P Adapter | `packages/app/lib/features/groups/services/webrtc_p2p_adapter.dart` |
| Group Model + GroupMember | `packages/app/lib/features/groups/models/group.dart` |
| Group Message Model | `packages/app/lib/features/groups/models/group_message.dart` |
| Vector Clock | `packages/app/lib/features/groups/models/vector_clock.dart` |
| Group Providers (Riverpod) | `packages/app/lib/features/groups/providers/group_providers.dart` |
| Groups List Screen | `packages/app/lib/features/groups/groups_list_screen.dart` |
| Group Detail Screen | `packages/app/lib/features/groups/group_detail_screen.dart` |

## App -- Call / VoIP Feature

| Feature | Location |
|---------|----------|
| Call Screen | `packages/app/lib/features/call/call_screen.dart` |
| Incoming Call Dialog | `packages/app/lib/features/call/incoming_call_dialog.dart` |
| VoIP Service (call lifecycle) | `packages/app/lib/core/network/voip_service.dart` |

## App -- Other Features

| Feature | Location |
|---------|----------|
| Connection Screen (pairing, QR, linking) | `packages/app/lib/features/connection/connect_screen.dart` |
| Contacts Screen | `packages/app/lib/features/contacts/contacts_screen.dart` |
| Contact Detail Screen | `packages/app/lib/features/contacts/contact_detail_screen.dart` |
| Home Screen | `packages/app/lib/features/home/home_screen.dart` |
| Main Layout (responsive split-view) | `packages/app/lib/features/home/main_layout.dart` |
| Settings Screen | `packages/app/lib/features/settings/settings_screen.dart` |
| Notification Settings | `packages/app/lib/features/settings/notification_settings_screen.dart` |
| Media Settings | `packages/app/lib/features/settings/media_settings_screen.dart` |
| Blocked Peers Screen | `packages/app/lib/features/settings/blocked_peers_screen.dart` |
| Onboarding Screen | `packages/app/lib/features/onboarding/onboarding_screen.dart` |
| Help Screen + Articles | `packages/app/lib/features/help/help_screen.dart` |
| Attestation Services | `packages/app/lib/features/attestation/services/` |
| Attestation Models | `packages/app/lib/features/attestation/models/` |

---

## Server

| Feature | Location |
|---------|----------|
| Request Dispatcher (Worker entry) | `packages/server/src/index.js` |
| Signaling Room (WebSocket relay) | `packages/server/src/signaling-room.js` |
| Relay Registry (capacity tracking) | `packages/server/src/relay-registry.js` |
| Rendezvous Registry (meeting points) | `packages/server/src/rendezvous-registry.js` |
| Chunk Index (source + cache) | `packages/server/src/chunk-index.js` |
| WebSocket Handler (message routing) | `packages/server/src/websocket-handler.js` |
| Relay Registry DO | `packages/server/src/durable-objects/relay-registry-do.js` |
| Server Registry DO | `packages/server/src/durable-objects/server-registry-do.js` |
| Attestation Registry DO | `packages/server/src/durable-objects/attestation-registry-do.js` |
| Ed25519 Signing | `packages/server/src/crypto/signing.js` |
| Attestation Crypto (HMAC, tokens) | `packages/server/src/crypto/attestation.js` |
| Logger | `packages/server/src/logger.js` |
| Wrangler Config | `packages/server/wrangler.jsonc` |

## Server Tests

| Suite | Location |
|-------|----------|
| WebSocket Handler Tests | `packages/server/src/__tests__/websocket-handler.test.js` |
| Relay Registry Tests | `packages/server/src/__tests__/relay-registry.test.js` |
| Rendezvous Registry Tests | `packages/server/src/__tests__/rendezvous-registry.test.js` |
| Chunk Index Tests | `packages/server/src/__tests__/chunk-index.test.js` |
| Chunk Handler Tests | `packages/server/src/__tests__/websocket-handler-chunks.test.js` |

---

## Headless Client

| Feature | Location |
|---------|----------|
| Client Orchestrator (30+ methods) | `packages/headless-client/zajel/client.py` |
| Signaling Client (WebSocket) | `packages/headless-client/zajel/signaling.py` |
| Crypto Service (X25519 + ChaCha20) | `packages/headless-client/zajel/crypto.py` |
| Channel Support (Ed25519, chunks) | `packages/headless-client/zajel/channels.py` |
| Group Support (sender keys) | `packages/headless-client/zajel/groups.py` |
| File Transfer (chunked) | `packages/headless-client/zajel/file_transfer.py` |
| WebRTC Service (aiortc) | `packages/headless-client/zajel/webrtc.py` |
| Peer Storage (SQLite) | `packages/headless-client/zajel/peer_storage.py` |
| Event System | `packages/headless-client/zajel/hooks.py` |

### Headless Client -- CLI

| Feature | Location |
|---------|----------|
| CLI Daemon (UNIX socket + dispatch) | `packages/headless-client/zajel/cli/daemon.py` |
| CLI Client (argparse + socket) | `packages/headless-client/zajel/cli/client.py` |
| Protocol (JSON-line framing) | `packages/headless-client/zajel/cli/protocol.py` |
| Serializers (dataclass → JSON) | `packages/headless-client/zajel/cli/serializers.py` |
| Entry Point (`python -m zajel.cli`) | `packages/headless-client/zajel/cli/__main__.py` |

### Headless Client -- Tests

| Suite | Location |
|-------|----------|
| CLI Protocol Tests | `packages/headless-client/tests/unit/test_cli_protocol.py` |
| CLI Serializer Tests | `packages/headless-client/tests/unit/test_cli_serializers.py` |
| Crypto Tests | `packages/headless-client/tests/unit/test_crypto.py` |
| Channel Tests | `packages/headless-client/tests/unit/test_channels.py` |
| Group Tests | `packages/headless-client/tests/unit/test_groups.py` |
| Protocol Tests | `packages/headless-client/tests/unit/test_protocol.py` |
| File Transfer Tests | `packages/headless-client/tests/unit/test_file_transfer.py` |
| Signaling Tests | `packages/headless-client/tests/unit/test_signaling.py` |

---

## Website

| Feature | Location |
|---------|----------|
| Home Page (hero, features, downloads) | `packages/website/app/routes/home.tsx` |
| Guide Page (docs, FAQ, security) | `packages/website/app/routes/guide.tsx` |
| Navigation Component | `packages/website/app/components/Nav.tsx` |
| Footer Component | `packages/website/app/components/Footer.tsx` |
| Global Styles (dark theme) | `packages/website/app/styles/global.css` |
| React Router Config | `packages/website/react-router.config.ts` |
| Vite Config | `packages/website/vite.config.ts` |
| Wrangler Config (Pages) | `packages/website/wrangler.jsonc` |
