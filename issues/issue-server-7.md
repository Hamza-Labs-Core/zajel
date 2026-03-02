# [HIGH] Pairing code has no length or format validation enabling storage abuse

**Area**: Server
**File**: packages/server/src/signaling-room.js:83-120
**Type**: Security

**Description**: The `handleRegister` method in `SignalingRoom` only checks that `pairingCode` is a truthy string (`!pairingCode || typeof pairingCode !== 'string'`). There is no validation of:
- Maximum length (a client could send a multi-megabyte string as a pairing code)
- Minimum length
- Character set (alphanumeric, etc.)
- Format (expected pattern)

The same issue exists in `handleSignaling` for the `target` field and in `handleMessage` for the `payload` field -- the SDP/ICE payloads forwarded via `handleSignaling` have no size validation.

**Impact**:
- Memory exhaustion: An attacker can register with extremely long pairing codes, consuming memory in the `this.clients` Map.
- A malicious client can send arbitrarily large signaling payloads through `handleSignaling`, which are forwarded verbatim to the target peer, enabling payload amplification attacks.

**Fix**:
1. Validate pairing code format: `if (pairingCode.length > 32 || !/^[A-Za-z0-9-]+$/.test(pairingCode))`.
2. Add maximum payload size checks for signaling messages.
3. Consider adding a maximum number of registered clients per SignalingRoom.
