# RESOLVED -- Dead code removed; VPS validates pairing codes with PAIRING_CODE.REGEX

**Status**: RESOLVED
**Resolution**: The original `SignalingRoom` was dead code in the CF Worker and has been deleted (commit 366c85d). The VPS server validates pairing codes using `PAIRING_CODE.REGEX` in `handlePairingCodeRegister()`, validates public key format and length (X25519 32-byte check), and enforces message-level size limits via `WEBSOCKET.MAX_MESSAGE_SIZE` (256KB) at both the `ws` library level (`maxPayload`) and application level.
**Original target**: `packages/server/src/signaling-room.js` (deleted)
**VPS status**: `packages/server-vps/src/client/handler.ts` lines 940-1024 (`handlePairingCodeRegister`) validates: (1) pairingCode presence, (2) format via `PAIRING_CODE.REGEX.test(pairingCode)`, (3) publicKey base64 format, (4) publicKey length (32 bytes for X25519). Signaling payloads are size-constrained by the WebSocket `maxPayload: WEBSOCKET.MAX_MESSAGE_SIZE` setting in `index.ts` line 155.

---

# Plan: Pairing code has no length or format validation enabling storage abuse

**Issue**: issue-server-7.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/signaling-room.js`

## Analysis

In `packages/server/src/signaling-room.js`:

- `handleRegister()` (lines 83-120): Validates only that `pairingCode` is truthy and a string (line 86: `if (!pairingCode || typeof pairingCode !== 'string')`). No length, format, or character set validation.
- `handleSignaling()` (lines 122-158): The `target` field (line 123: `const { type, target, payload } = message`) has no validation beyond truthiness (line 139: `if (!target || !payload)`). No size check on `payload`.
- The `payload` field is forwarded verbatim to the target peer at line 151-155 via `targetClient.send(JSON.stringify({ type, from: senderCode, payload }))`. A multi-megabyte payload passes through unchecked.

## Fix Steps

1. **Add pairing code validation in `handleRegister()`** (after line 86):
   ```js
   if (!pairingCode || typeof pairingCode !== 'string') {
     this.sendError(ws, 'Invalid pairing code');
     return;
   }
   if (pairingCode.length > 64 || !/^[A-Za-z0-9_-]+$/.test(pairingCode)) {
     this.sendError(ws, 'Invalid pairing code format: must be 1-64 alphanumeric characters');
     return;
   }
   ```

2. **Add target validation in `handleSignaling()`** (after line 139):
   ```js
   if (!target || typeof target !== 'string' || target.length > 64 || !/^[A-Za-z0-9_-]+$/.test(target)) {
     this.sendError(ws, 'Invalid target');
     return;
   }
   ```

3. **Add payload size validation in `handleSignaling()`** (after target validation):
   ```js
   const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
   if (payloadStr.length > 65536) { // 64KB max for SDP/ICE payloads
     this.sendError(ws, 'Payload too large');
     return;
   }
   ```

4. **Add maximum client count check in `handleRegister()`** (before line 109 `this.clients.set(pairingCode, ws)`):
   ```js
   if (this.clients.size >= 100) { // Max 100 clients per SignalingRoom
     this.sendError(ws, 'Room is full');
     return;
   }
   ```

## Testing

- Verify that valid pairing codes (alphanumeric, 1-64 chars) are accepted.
- Verify that pairing codes with special characters, excessive length, or empty strings are rejected.
- Verify that oversized signaling payloads are rejected.
- Verify that valid signaling messages (typical SDP/ICE payloads, usually a few KB) still work.
- Run existing pairing/signaling tests.

## Risk Assessment

- **Client compatibility**: Verify that the client-side pairing code generation produces codes matching the new validation pattern. Check the Flutter app's pairing code format.
- **Payload size limit**: 64KB is generous for SDP offers/answers (typically 1-5KB) and ICE candidates (a few hundred bytes). If any legitimate payload exceeds this, increase the limit.
- **Room capacity limit**: 100 clients per room is generous for a pairing scenario that typically involves 2 peers. Adjust based on expected usage.
