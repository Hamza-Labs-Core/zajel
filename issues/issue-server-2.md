# [CRITICAL] Server registration and deletion have no authentication

**Area**: Server
**File**: packages/server/src/durable-objects/server-registry-do.js:33-45
**Type**: Security

**Description**: The `POST /servers` (register), `DELETE /servers/:serverId` (unregister), and `POST /servers/heartbeat` endpoints have zero authentication. Any unauthenticated client can register rogue servers, delete legitimate servers, or send heartbeats for arbitrary server IDs.

**Impact**:
- An attacker can register malicious VPS endpoints that clients will discover and connect to, enabling man-in-the-middle attacks on signaling.
- An attacker can delete all legitimate servers from the registry, causing a denial of service.
- An attacker can send heartbeats for servers they do not own, keeping rogue entries alive or preventing legitimate entries from expiring.

**Fix**: Add authentication to all `/servers` mutation endpoints. Options:
1. Require a shared secret or API key in the `Authorization` header (similar to how `CI_UPLOAD_SECRET` protects attestation upload).
2. Require each VPS server to register with a signed request using its Ed25519 key, and verify the signature on registration/heartbeat/delete.
3. At minimum, the `DELETE` endpoint should verify that the requester owns the `serverId` being deleted.
