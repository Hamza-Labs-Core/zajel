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
| Key Ratcheting (HKDF-based forward secrecy) | `packages/app/lib/core/crypto/key_ratchet.dart` |

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
| Pairing Code Utilities (char set, validation) | `packages/app/lib/core/network/pairing_code_utils.dart` |
| Connection Manager (central coordinator) | `packages/app/lib/core/network/connection_manager.dart:L92-1209` |
| Trusted Peer Migration | `packages/app/lib/core/network/connection_manager.dart:L658-723` |
| Meeting Points Derivation | `packages/app/lib/core/network/meeting_point_service.dart` |
| Meeting Points Model (daily points + hourly tokens) | `packages/app/lib/core/network/meeting_points.dart` |
| Dead Drop Model (encrypted offline messages) | `packages/app/lib/core/network/dead_drop.dart` |
| Rendezvous Service (dead drops + live match) | `packages/app/lib/core/network/rendezvous_service.dart` |
| Server Discovery (bootstrap) | `packages/app/lib/core/network/server_discovery_service.dart` |
| Relay Client | `packages/app/lib/core/network/relay_client.dart` |
| Relay Models (RelayInfo) | `packages/app/lib/core/network/relay_models.dart` |
| Relay Exceptions | `packages/app/lib/core/network/relay_exceptions.dart` |
| Connection Info Model | `packages/app/lib/core/network/connection_info.dart` |
| Peer Reconnection Service (relay + rendezvous) | `packages/app/lib/core/network/peer_reconnection_service.dart` |
| Key Rotation Detector (TOFU model) | `packages/app/lib/core/network/key_rotation_detector.dart` |
| Subscription Manager (stream lifecycle mixin) | `packages/app/lib/core/network/subscription_manager.dart` |
| VoIP Service | `packages/app/lib/core/network/voip_service.dart` |
| Device Link Service (web client proxy) | `packages/app/lib/core/network/device_link_service.dart` |
| Message Protocol (binary wire format) | `packages/app/lib/core/protocol/message_protocol.dart` |

## App -- Core Models

| Feature | Location |
|---------|----------|
| Models Barrel Export | `packages/app/lib/core/models/models.dart` |
| Peer Model (identity, connection state) | `packages/app/lib/core/models/peer.dart` |
| Message Model (encrypted, status-tracked) | `packages/app/lib/core/models/message.dart` |
| Linked Device Model (web proxy sessions) | `packages/app/lib/core/models/linked_device.dart` |
| Media Device Model (audio/video devices) | `packages/app/lib/core/models/media_device.dart` |
| Notification Settings Model | `packages/app/lib/core/models/notification_settings.dart` |

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

## App -- Core Providers

| Feature | Location |
|---------|----------|
| App Providers (top-level Riverpod config) | `packages/app/lib/core/providers/app_providers.dart` |
| Crypto Providers (CryptoService, BootstrapVerifier) | `packages/app/lib/core/providers/crypto_providers.dart` |
| Network Providers (SignalingClient, ConnectionManager, WebRTC) | `packages/app/lib/core/providers/network_providers.dart` |
| Chat Providers (message streams, storage) | `packages/app/lib/core/providers/chat_providers.dart` |
| Peer Providers (peer list, online status) | `packages/app/lib/core/providers/peer_providers.dart` |
| File Providers (file receive, transfer streams) | `packages/app/lib/core/providers/file_providers.dart` |
| Media Providers (logger, blur, media service) | `packages/app/lib/core/providers/media_providers.dart` |
| Notification Providers (settings, DND) | `packages/app/lib/core/providers/notification_providers.dart` |
| Preferences Providers (SharedPreferences, theme) | `packages/app/lib/core/providers/preferences_providers.dart` |
| Settings Providers (auto-delete, privacy) | `packages/app/lib/core/providers/settings_providers.dart` |

## App -- Core Services

| Feature | Location |
|---------|----------|
| App Initialization Service (startup orchestration) | `packages/app/lib/core/services/app_initialization_service.dart` |
| Auto-Delete Service (timed message cleanup) | `packages/app/lib/core/services/auto_delete_service.dart` |
| File Transfer Listener (chunk reception coordinator) | `packages/app/lib/core/services/file_transfer_listener.dart` |
| Link Request Handler (web client link dialogs) | `packages/app/lib/core/services/link_request_handler.dart` |
| Notification Listener Service (message/file notifications) | `packages/app/lib/core/services/notification_listener_service.dart` |
| Pair Request Handler (pair approval dialogs) | `packages/app/lib/core/services/pair_request_handler.dart` |
| VoIP Call Handler (call state, incoming dialog) | `packages/app/lib/core/services/voip_call_handler.dart` |

## App -- Core Other

| Feature | Location |
|---------|----------|
| Constants (crypto, file, WebRTC, call) | `packages/app/lib/core/constants.dart` |
| Environment Configuration | `packages/app/lib/core/config/environment.dart` |
| Notification Service | `packages/app/lib/core/notifications/notification_service.dart` |
| Call Foreground Service (Android) | `packages/app/lib/core/notifications/call_foreground_service.dart` |
| Logger Service (rotating files) | `packages/app/lib/core/logging/logger_service.dart` |
| Identity Utils (display name resolution) | `packages/app/lib/core/utils/identity_utils.dart` |

---

## App -- Shared Widgets

| Feature | Location |
|---------|----------|
| Reusable Message List (reversed, paginated, auto-scroll, date dividers) | `packages/app/lib/shared/widgets/message_list_view.dart` |
| Compose Bar | `packages/app/lib/shared/widgets/compose_bar.dart` |

---

## App -- Desktop Auto-Updater Feature

### Dart -- Models

| Feature | Location |
|---------|----------|
| Update status enum + state record | `packages/app/lib/features/updater/models/update_state.dart` |
| Manifest model (Dart side of IPC) | `packages/app/lib/features/updater/models/update_manifest.dart` |
| Update result model (written by Go) | `packages/app/lib/features/updater/models/update_result.dart` |
| GitHub release + asset models | `packages/app/lib/features/updater/models/github_release.dart` |
| Update check result (sealed) | `packages/app/lib/features/updater/models/update_check_result.dart` |
| Backward-compatible artifact re-export | `packages/app/lib/features/updater/models/update_artifact.dart` |

### Dart -- Services

| Feature | Location |
|---------|----------|
| GitHub Releases API client (ETag caching, rate limit) | `packages/app/lib/features/updater/services/github_release_service.dart` |
| Chunked HTTPS download, resumption, SHA-256 verify, extraction | `packages/app/lib/features/updater/services/update_download_service.dart` |
| Update lifecycle state machine | `packages/app/lib/features/updater/services/update_orchestrator.dart` |
| Package format detector (MSIX/MAS/Snap/Flatpak/AppImage/loose) | `packages/app/lib/features/updater/services/update_package_detector.dart` |
| Manifest writer + Go binary launcher + rollback launcher | `packages/app/lib/features/updater/services/updater_launcher.dart` |
| Crash counter + rollback trigger | `packages/app/lib/features/updater/services/update_rollback_service.dart` |
| Idle timer + grace period | `packages/app/lib/features/updater/services/idle_detector.dart` |
| Auto-install coordinator (idle + call + transfer checks) | `packages/app/lib/features/updater/services/auto_update_service.dart` |

### Dart -- Providers

| Feature | Location |
|---------|----------|
| Core update Riverpod providers | `packages/app/lib/features/updater/providers/update_providers.dart` |
| Auto-install + background-download preferences | `packages/app/lib/features/updater/providers/auto_update_providers.dart` |

### Dart -- Widgets

| Feature | Location |
|---------|----------|
| Settings > Updates section | `packages/app/lib/features/updater/widgets/update_settings_section.dart` |
| Update-ready banner + dot badge | `packages/app/lib/features/updater/widgets/update_ready_banner.dart` |
| Download/verify/install progress widget | `packages/app/lib/features/updater/widgets/update_progress_indicator.dart` |
| Auto-install toggle widget | `packages/app/lib/features/updater/widgets/auto_update_settings.dart` |

### Go Updater Binary

| Feature | Location |
|---------|----------|
| Entry point, update sequence, rollback sequence | `packages/app/updater/main.go` |
| Manifest struct, ParseManifest, path validation | `packages/app/updater/manifest.go` |
| WaitForExit, LaunchApp, detachProcess | `packages/app/updater/process.go` |
| CreateBackup, ReplaceFiles, Rollback, lock file, symlink escape detection | `packages/app/updater/fileops.go` |
| UpdateResult struct, WriteResult | `packages/app/updater/result.go` |
| Windows: WaitForSingleObject, retry copy, TerminateProcess | `packages/app/updater/platform_windows.go` |
| macOS: kill(0), SIGTERM, quarantine clearing | `packages/app/updater/platform_darwin.go` |
| Linux: /proc/<pid>/comm, chmod +x shared objects | `packages/app/updater/platform_linux.go` |
| File operation unit tests | `packages/app/updater/fileops_test.go` |
| Manifest parse and validate tests | `packages/app/updater/manifest_test.go` |
| Process wait logic tests | `packages/app/updater/process_test.go` |
| Integration-level update/rollback sequence tests | `packages/app/updater/main_test.go` |

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
| Channel Providers (Riverpod, ChannelMessagesNotifier with pagination) | `packages/app/lib/features/channels/providers/channel_providers.dart` |
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
| Group Providers (Riverpod, GroupMessagesNotifier with pagination) | `packages/app/lib/features/groups/providers/group_providers.dart` |
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

## Server -- CF Workers (Bootstrap)

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

### CF Workers Tests

| Suite | Location |
|-------|----------|
| WebSocket Handler Tests | `packages/server/src/__tests__/websocket-handler.test.js` |
| Relay Registry Tests | `packages/server/src/__tests__/relay-registry.test.js` |
| Rendezvous Registry Tests | `packages/server/src/__tests__/rendezvous-registry.test.js` |
| Chunk Index Tests | `packages/server/src/__tests__/chunk-index.test.js` |
| Chunk Handler Tests | `packages/server/src/__tests__/websocket-handler-chunks.test.js` |

---

## Server -- VPS (Federated Signaling)

The VPS server is the primary signaling and relay server. It implements SWIM gossip federation, DHT-based consistent hashing, and a modular handler architecture.

### VPS -- Entry Point & Config

| Feature | Location |
|---------|----------|
| Server Entry Point (HTTP/WSS, federation boot) | `packages/server-vps/src/index.ts` |
| Server Configuration (env/dotenv) | `packages/server-vps/src/config.ts` |
| Constants (limits, timeouts, sizes) | `packages/server-vps/src/constants.ts` |
| Core Type Definitions | `packages/server-vps/src/types.ts` |

### VPS -- Client Handlers

| Feature | Location |
|---------|----------|
| Client Handler (message router + rate limiter) | `packages/server-vps/src/client/handler.ts` |
| Handler Context (shared state interface) | `packages/server-vps/src/client/context.ts` |
| Client Types (message schemas, config) | `packages/server-vps/src/client/types.ts` |
| Client Module Index | `packages/server-vps/src/client/index.ts` |
| Signaling Handler (pairing, WebRTC, call forwarding) | `packages/server-vps/src/client/signaling-handler.ts` |
| Relay Handler (relay registration, rendezvous, heartbeat) | `packages/server-vps/src/client/relay-handler.ts` |
| Chunk Relay (source tracking, LRU cache, fan-out) | `packages/server-vps/src/client/chunk-relay.ts` |
| Channel Handler (ownership, subscriptions, upstream, streaming) | `packages/server-vps/src/client/channel-handler.ts` |
| Link Handler (device linking, web-to-mobile) | `packages/server-vps/src/client/link-handler.ts` |
| Attestation Handler (challenge/response gating) | `packages/server-vps/src/client/attestation-handler.ts` |

### VPS -- Registry

| Feature | Location |
|---------|----------|
| Registry Module Index | `packages/server-vps/src/registry/index.ts` |
| Relay Registry (peer capacity, load balancing) | `packages/server-vps/src/registry/relay-registry.ts` |
| Rendezvous Registry (meeting points, dead drops, SQLite) | `packages/server-vps/src/registry/rendezvous-registry.ts` |
| Distributed Rendezvous (DHT routing wrapper) | `packages/server-vps/src/registry/distributed-rendezvous.ts` |

### VPS -- Federation

| Feature | Location |
|---------|----------|
| Federation Module Index | `packages/server-vps/src/federation/index.ts` |
| Federation Manager (gossip orchestrator) | `packages/server-vps/src/federation/federation-manager.ts` |
| Bootstrap Client (CF Workers registration/discovery) | `packages/server-vps/src/federation/bootstrap-client.ts` |
| SWIM Gossip Protocol | `packages/server-vps/src/federation/gossip/protocol.ts` |
| Membership Management (incarnation, status) | `packages/server-vps/src/federation/gossip/membership.ts` |
| Failure Detector (ping, indirect ping, suspicion) | `packages/server-vps/src/federation/gossip/failure-detector.ts` |
| DHT Hash Ring (consistent hashing, virtual nodes) | `packages/server-vps/src/federation/dht/hash-ring.ts` |
| Server-to-Server Transport (WebSocket, signature handshake) | `packages/server-vps/src/federation/transport/server-connection.ts` |

### VPS -- Admin Dashboard

| Feature | Location |
|---------|----------|
| Admin Module Index | `packages/server-vps/src/admin/index.ts` |
| JWT Authentication (shared secret with CF Workers) | `packages/server-vps/src/admin/auth.ts` |
| Metrics Collector (rolling window aggregation) | `packages/server-vps/src/admin/metrics.ts` |
| Admin API Routes (REST endpoints) | `packages/server-vps/src/admin/routes.ts` |
| Admin WebSocket (real-time metrics streaming) | `packages/server-vps/src/admin/websocket.ts` |
| Admin Types (JWT payload, config, metrics) | `packages/server-vps/src/admin/types.ts` |

### VPS -- Other Modules

| Feature | Location |
|---------|----------|
| Server Identity (Ed25519 keygen, signing) | `packages/server-vps/src/identity/server-identity.ts` |
| Attestation Manager (challenge proxy, session tokens) | `packages/server-vps/src/attestation/attestation-manager.ts` |
| Attestation Module Index | `packages/server-vps/src/attestation/index.ts` |
| Storage Interface (abstract backend) | `packages/server-vps/src/storage/interface.ts` |
| SQLite Storage (better-sqlite3 persistence) | `packages/server-vps/src/storage/sqlite.ts` |
| Secure Random (rejection sampling CSPRNG) | `packages/server-vps/src/crypto/secure-random.ts` |
| Logger (structured, OWASP-compliant redaction) | `packages/server-vps/src/utils/logger.ts` |

### VPS -- Unit Tests

| Suite | Location |
|-------|----------|
| Pairing Handler Tests | `packages/server-vps/tests/unit/client-handler-pairing.test.ts` |
| Call Signaling Handler Tests | `packages/server-vps/tests/unit/client-handler-call-signaling.test.ts` |
| Channel Handler Tests | `packages/server-vps/tests/unit/client-handler-channels.test.ts` |
| Chunk Handler Tests | `packages/server-vps/tests/unit/client-handler-chunks.test.ts` |
| Link Handler Tests | `packages/server-vps/tests/unit/client-handler-link.test.ts` |
| Rendezvous Handler Tests | `packages/server-vps/tests/unit/client-handler-rendezvous.test.ts` |
| Relay Registry Tests | `packages/server-vps/tests/unit/relay-registry.test.ts` |
| Rendezvous Registry Tests | `packages/server-vps/tests/unit/rendezvous-registry.test.ts` |
| Hash Ring Tests | `packages/server-vps/tests/unit/hash-ring.test.ts` |
| Attestation Tests | `packages/server-vps/tests/unit/attestation.test.ts` |
| Server Identity Tests | `packages/server-vps/tests/unit/identity.test.ts` |
| SQLite Storage Tests | `packages/server-vps/tests/unit/storage.test.ts` |

### VPS -- Integration Tests

| Suite | Location |
|-------|----------|
| Federation Integration Tests | `packages/server-vps/tests/integration/federation.test.ts` |
| Distributed Rendezvous Tests | `packages/server-vps/tests/integration/distributed-rendezvous.test.ts` |
| Bootstrap Client Tests | `packages/server-vps/tests/integration/bootstrap-client.test.ts` |
| Real Server Tests | `packages/server-vps/tests/integration/real-server.test.ts` |
| Test Harness | `packages/server-vps/tests/harness/server-harness.ts` |
| Mock Bootstrap Server | `packages/server-vps/tests/harness/mock-bootstrap.ts` |

---

## Headless Client

| Feature | Location |
|---------|----------|
| Client Orchestrator (30+ methods) | `packages/headless-client/zajel/client.py` |
| Signaling Client (WebSocket) | `packages/headless-client/zajel/signaling.py` |
| Crypto Service (X25519 + ChaCha20) | `packages/headless-client/zajel/crypto.py` |
| Message Protocol (framing, parsing) | `packages/headless-client/zajel/protocol.py` |
| Channel Support (Ed25519, chunks) | `packages/headless-client/zajel/channels.py` |
| Group Support (sender keys) | `packages/headless-client/zajel/groups.py` |
| Vector Clock (causal ordering, sync) | `packages/headless-client/zajel/vector_clock.py` |
| Dead Drop Support (models, encryption) | `packages/headless-client/zajel/dead_drop.py` |
| File Transfer (chunked) | `packages/headless-client/zajel/file_transfer.py` |
| WebRTC Service (aiortc) | `packages/headless-client/zajel/webrtc.py` |
| Peer Storage (SQLite) | `packages/headless-client/zajel/peer_storage.py` |
| Event System | `packages/headless-client/zajel/hooks.py` |
| Logging Config (structured JSON) | `packages/headless-client/zajel/logging_config.py` |

### Headless Client -- CLI

| Feature | Location |
|---------|----------|
| CLI Daemon (UNIX socket + dispatch) | `packages/headless-client/zajel/cli/daemon.py` |
| CLI Client (argparse + socket) | `packages/headless-client/zajel/cli/client.py` |
| Protocol (JSON-line framing) | `packages/headless-client/zajel/cli/protocol.py` |
| Serializers (dataclass -> JSON) | `packages/headless-client/zajel/cli/serializers.py` |
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
| Dead Drop Tests | `packages/headless-client/tests/unit/test_dead_drop.py` |
| Typing Receipts Tests | `packages/headless-client/tests/unit/test_typing_receipts.py` |
| Vector Clock Tests | `packages/headless-client/tests/unit/test_vector_clock.py` |

---

## Integration Tests

Cross-app integration tests using Playwright and WebSocket clients against real or local VPS servers.

| Feature | Location |
|---------|----------|
| Test Orchestrator (server + browser lifecycle) | `packages/integration-tests/src/orchestrator.ts` |
| Module Index | `packages/integration-tests/src/index.ts` |
| Test Constants (timeouts, network config) | `packages/integration-tests/src/test-constants.ts` |
| Pairing Flow Tests | `packages/integration-tests/src/scenarios/pairing-flow.test.ts` |
| VoIP Flow Tests | `packages/integration-tests/src/scenarios/voip-flow.test.ts` |
| Web-to-Web Tests (real deployed servers) | `packages/integration-tests/src/scenarios/web-to-web.test.ts` |
| Vitest Config | `packages/integration-tests/vitest.config.ts` |

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
