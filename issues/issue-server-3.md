# [CRITICAL] WebSocket peer identity is self-asserted with no verification

**Area**: Server
**File**: packages/server/src/websocket-handler.js:111-136
**Type**: Security

**Description**: When a WebSocket client sends a `register` message, the `peerId` is entirely self-asserted by the client with no authentication or verification. The server blindly trusts whatever `peerId` the client provides. Any client can claim to be any peer.

Similarly, `handleUpdateLoad`, `handleRegisterRendezvous`, `handleChunkAnnounce`, `handleChunkRequest`, and `handleHeartbeat` all accept `peerId` from the message body without verifying the sender owns that identity.

**Impact**:
- **Identity spoofing**: An attacker can impersonate any peer by sending `{ type: 'register', peerId: 'victim-peer-id' }`, hijacking the victim's WebSocket mapping and receiving their messages.
- **Session hijacking**: By registering with a victim's peerId, the attacker's WebSocket replaces the victim's in `wsConnections`, so subsequent messages intended for the victim go to the attacker.
- **Load manipulation**: An attacker can send `update_load` messages for any peerId, manipulating relay selection.

**Fix**:
1. Bind peerId to the WebSocket connection upon first registration and reject subsequent messages with a different peerId.
2. Require cryptographic proof of identity (e.g., sign a challenge with the peer's Ed25519 key) during registration.
3. At minimum, derive the peerId from the WebSocket object reference rather than trusting client-provided values in every message.
