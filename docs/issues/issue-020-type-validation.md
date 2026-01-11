# Issue #20: No Runtime Type Validation

## Summary

Signaling messages are parsed as JSON but not validated at runtime. Malformed messages could cause crashes or unexpected behavior. This issue affects both the TypeScript web client and the Dart mobile app.

---

## Current Parsing Analysis

### TypeScript Web Client

#### File: `/packages/web-client/src/lib/signaling.ts`

**Lines 88-106 - WebSocket Message Handling:**
```typescript
this.ws.onmessage = (event) => {
  try {
    // Check message size before processing
    const messageSize = typeof event.data === 'string'
      ? event.data.length
      : event.data.byteLength || 0;
    if (messageSize > MAX_MESSAGE_SIZE) {
      console.error('Rejected WebSocket message: exceeds 1MB size limit');
      this.disconnect();
      this.events.onError('Connection closed: message too large');
      return;
    }

    const message = JSON.parse(event.data) as ServerMessage;  // <-- TYPE ASSERTION WITHOUT VALIDATION
    this.handleMessage(message);
  } catch (e) {
    console.error('Failed to parse message:', e);
  }
};
```

**Problems Identified:**
1. **Unsafe Type Assertion**: `as ServerMessage` is a compile-time only assertion that does no runtime checking
2. **Silent Failure**: JSON parse errors are logged but no recovery action is taken
3. **No Field Validation**: Missing or malformed fields will cause runtime errors in `handleMessage()`

**Lines 188-244 - Message Handler:**
```typescript
private handleMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'pair_incoming':
      this.setState('pending_approval');
      this.events.onPairIncoming(message.fromCode, message.fromPublicKey);  // <-- CRASHES IF FIELDS MISSING
      break;
    // ... other cases
  }
}
```

If `message.fromCode` or `message.fromPublicKey` is undefined, the callback receives undefined values, potentially crashing the application or causing downstream bugs.

#### File: `/packages/web-client/src/lib/webrtc.ts`

**Lines 132-155 - Message Channel Handling:**
```typescript
channel.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);  // <-- NO TYPE VALIDATION
    if (data.type === 'handshake') {
      this.events.onHandshake(data.publicKey);  // <-- CRASHES IF publicKey MISSING
    } else {
      this.events.onMessage(event.data);
    }
  } catch {
    this.events.onMessage(event.data);
  }
};
```

**Lines 163-197 - File Channel Handling:**
```typescript
channel.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);  // <-- NO TYPE VALIDATION
    switch (data.type) {
      case 'file_start':
        this.events.onFileStart(
          data.fileId,      // <-- UNDEFINED IF MISSING
          data.fileName,    // <-- UNDEFINED IF MISSING
          data.totalSize,   // <-- UNDEFINED IF MISSING
          data.totalChunks  // <-- UNDEFINED IF MISSING
        );
        break;
      // ...
    }
  } catch (e) {
    console.error('Failed to parse file message:', e);
  }
};
```

### Dart Mobile App

#### File: `/packages/app/lib/core/network/signaling_client.dart`

**Lines 175-261 - Message Handling:**
```dart
void _handleMessage(dynamic data) {
  try {
    final json = jsonDecode(data as String) as Map<String, dynamic>;
    final type = json['type'] as String;  // <-- CRASHES IF 'type' IS MISSING OR NOT A STRING

    switch (type) {
      case 'offer':
        _messageController.add(SignalingMessage.offer(
          from: json['from'] as String,  // <-- CRASHES IF 'from' IS MISSING OR NOT A STRING
          payload: json['payload'] as Map<String, dynamic>,  // <-- CRASHES IF NOT A MAP
        ));
        break;
      // ... other cases
    }
  } catch (e) {
    // Invalid message format - SILENTLY IGNORED
  }
}
```

**Problems:**
1. **Unsafe Casts**: `as String` and `as Map<String, dynamic>` throw exceptions if types don't match
2. **Silent Failures**: Exceptions are caught but not logged or reported
3. **No Graceful Degradation**: Application state may become inconsistent

#### File: `/packages/app/lib/core/network/webrtc_service.dart`

**Lines 367-394 - Message Channel:**
```dart
void _handleMessageChannelData(String peerId, RTCDataChannelMessage message) async {
  final text = message.text;

  try {
    final json = jsonDecode(text) as Map<String, dynamic>;
    if (json['type'] == 'handshake') {
      final publicKey = json['publicKey'] as String;  // <-- CRASHES IF NOT A STRING
      await _cryptoService.establishSession(peerId, publicKey);
      // ...
    }
  } catch (_) {
    // Silent failure
  }
  // ...
}
```

**Lines 396-437 - File Channel:**
```dart
void _handleFileChannelData(String peerId, RTCDataChannelMessage message) async {
  try {
    final json = jsonDecode(message.text) as Map<String, dynamic>;
    final type = json['type'] as String;
    final fileId = json['fileId'] as String;  // <-- CRASHES IF NOT A STRING

    if (type == 'file_start') {
      final fileName = json['fileName'] as String;      // <-- UNSAFE CAST
      final totalSize = json['totalSize'] as int;       // <-- UNSAFE CAST
      final totalChunks = json['totalChunks'] as int;   // <-- UNSAFE CAST
      // ...
    }
  } catch (e) {
    logger.error('WebRTCService', 'Error handling file data', e);
  }
}
```

---

## Attack Vectors from Malformed Messages

### 1. Denial of Service (DoS)

**Attack**: Send messages with missing required fields
```json
{"type": "pair_incoming"}  // Missing fromCode, fromPublicKey
```

**Impact**:
- TypeScript: `undefined` values passed to callbacks causing downstream crashes
- Dart: `TypeError` exceptions causing message processing to fail

### 2. Application State Corruption

**Attack**: Send out-of-sequence or duplicate messages
```json
{"type": "pair_matched", "peerCode": "ABCD12", "peerPublicKey": "", "isInitiator": true}
```

**Impact**:
- Empty public key could bypass key validation
- Incorrect `isInitiator` value could cause both peers to create offers

### 3. Type Confusion

**Attack**: Send fields with unexpected types
```json
{"type": "file_start", "fileId": 12345, "fileName": {"malicious": true}, "totalSize": "large", "totalChunks": null}
```

**Impact**:
- TypeScript: Values pass through due to `as` assertion, causing subtle bugs
- Dart: Immediate crash due to strict type casting

### 4. Injection via Nested Payloads

**Attack**: Malformed SDP or ICE candidates
```json
{"type": "offer", "from": "PEER01", "payload": {"sdp": null, "type": 12345}}
```

**Impact**:
- Invalid SDP passed to WebRTC APIs causing browser-level errors
- Potential security implications if WebRTC implementation has vulnerabilities

### 5. Buffer Exhaustion

**Attack**: Send extremely large string fields
```json
{"type": "error", "message": "A" * 100000000}
```

**Impact**:
- While there's a 1MB message size check, large strings within that limit could still cause memory pressure
- String operations on large values could be slow

### 6. Integer Overflow/Underflow

**Attack**: Send extreme integer values for file transfer
```json
{"type": "file_start", "fileId": "x", "fileName": "test", "totalSize": -1, "totalChunks": 9007199254740992}
```

**Impact**:
- Negative sizes could cause array allocation errors
- Large chunk counts could cause infinite loops or memory exhaustion

---

## Proposed Validation Solution

### Approach: Zod for TypeScript, Manual Validation for Dart

**Why Zod?**
- Zero dependencies, small bundle size (~8kb gzipped)
- TypeScript-first with excellent type inference
- Composable schemas
- Detailed error messages
- Industry standard for runtime validation

**Alternative Considered: io-ts**
- More functional programming style
- Steeper learning curve
- Less actively maintained

**Manual validation for Dart:**
- Dart's type system is already stronger at runtime
- No widely-adopted equivalent to Zod
- Custom validation gives full control

### TypeScript Implementation

#### 1. Install Zod

```bash
cd packages/web-client
npm install zod
```

#### 2. Create Validation Schemas

**New file: `/packages/web-client/src/lib/validation.ts`**

```typescript
import { z } from 'zod';

// Common validators
const pairingCodeSchema = z.string().regex(/^[A-HJ-NP-Z2-9]{6}$/);
const publicKeySchema = z.string().min(32).max(256);

// Server -> Client message schemas
export const registeredMessageSchema = z.object({
  type: z.literal('registered'),
  pairingCode: pairingCodeSchema,
});

export const pairIncomingMessageSchema = z.object({
  type: z.literal('pair_incoming'),
  fromCode: pairingCodeSchema,
  fromPublicKey: publicKeySchema,
});

export const pairMatchedMessageSchema = z.object({
  type: z.literal('pair_matched'),
  peerCode: pairingCodeSchema,
  peerPublicKey: publicKeySchema,
  isInitiator: z.boolean(),
});

export const pairRejectedMessageSchema = z.object({
  type: z.literal('pair_rejected'),
  peerCode: pairingCodeSchema,
});

export const pairTimeoutMessageSchema = z.object({
  type: z.literal('pair_timeout'),
  peerCode: pairingCodeSchema,
});

export const pairErrorMessageSchema = z.object({
  type: z.literal('pair_error'),
  error: z.string().max(1000),
});

// SDP payload schema
const rtcSessionDescriptionSchema = z.object({
  type: z.enum(['offer', 'answer', 'pranswer', 'rollback']).optional(),
  sdp: z.string().max(100000).optional(),
});

// ICE candidate schema
const rtcIceCandidateSchema = z.object({
  candidate: z.string().max(10000).optional(),
  sdpMid: z.string().max(100).optional().nullable(),
  sdpMLineIndex: z.number().int().min(0).max(255).optional().nullable(),
  usernameFragment: z.string().max(100).optional().nullable(),
});

export const offerReceivedMessageSchema = z.object({
  type: z.literal('offer'),
  from: pairingCodeSchema,
  payload: rtcSessionDescriptionSchema,
});

export const answerReceivedMessageSchema = z.object({
  type: z.literal('answer'),
  from: pairingCodeSchema,
  payload: rtcSessionDescriptionSchema,
});

export const iceCandidateReceivedMessageSchema = z.object({
  type: z.literal('ice_candidate'),
  from: pairingCodeSchema,
  payload: rtcIceCandidateSchema,
});

export const pongMessageSchema = z.object({
  type: z.literal('pong'),
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string().max(1000),
});

// Union of all server messages
export const serverMessageSchema = z.discriminatedUnion('type', [
  registeredMessageSchema,
  pairIncomingMessageSchema,
  pairMatchedMessageSchema,
  pairRejectedMessageSchema,
  pairTimeoutMessageSchema,
  pairErrorMessageSchema,
  offerReceivedMessageSchema,
  answerReceivedMessageSchema,
  iceCandidateReceivedMessageSchema,
  pongMessageSchema,
  errorMessageSchema,
]);

// Data channel message schemas
export const handshakeMessageSchema = z.object({
  type: z.literal('handshake'),
  publicKey: publicKeySchema,
});

export const fileStartMessageSchema = z.object({
  type: z.literal('file_start'),
  fileId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  totalSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  totalChunks: z.number().int().min(1).max(1000000),
});

export const fileChunkMessageSchema = z.object({
  type: z.literal('file_chunk'),
  fileId: z.string().uuid(),
  chunkIndex: z.number().int().min(0),
  data: z.string(), // Base64 encrypted data
});

export const fileCompleteMessageSchema = z.object({
  type: z.literal('file_complete'),
  fileId: z.string().uuid(),
});

export const fileErrorMessageSchema = z.object({
  type: z.literal('file_error'),
  fileId: z.string().uuid(),
  error: z.string().max(1000),
});

export const dataChannelMessageSchema = z.discriminatedUnion('type', [
  handshakeMessageSchema,
  fileStartMessageSchema,
  fileChunkMessageSchema,
  fileCompleteMessageSchema,
  fileErrorMessageSchema,
]);

// Type exports
export type ValidatedServerMessage = z.infer<typeof serverMessageSchema>;
export type ValidatedDataChannelMessage = z.infer<typeof dataChannelMessageSchema>;

// Validation functions with error handling
export function validateServerMessage(data: unknown): ValidatedServerMessage | null {
  const result = serverMessageSchema.safeParse(data);
  if (!result.success) {
    console.warn('Invalid server message:', result.error.format());
    return null;
  }
  return result.data;
}

export function validateDataChannelMessage(data: unknown): ValidatedDataChannelMessage | null {
  const result = dataChannelMessageSchema.safeParse(data);
  if (!result.success) {
    console.warn('Invalid data channel message:', result.error.format());
    return null;
  }
  return result.data;
}
```

#### 3. Update Signaling Client

**Modified `/packages/web-client/src/lib/signaling.ts`:**

```typescript
import { validateServerMessage } from './validation';

// In onmessage handler:
this.ws.onmessage = (event) => {
  try {
    // Size check (existing)
    const messageSize = typeof event.data === 'string'
      ? event.data.length
      : event.data.byteLength || 0;
    if (messageSize > MAX_MESSAGE_SIZE) {
      console.error('Rejected WebSocket message: exceeds 1MB size limit');
      this.disconnect();
      this.events.onError('Connection closed: message too large');
      return;
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      console.error('Failed to parse message as JSON');
      return;
    }

    // Validate message structure
    const message = validateServerMessage(parsed);
    if (!message) {
      console.error('Message validation failed');
      return;
    }

    this.handleMessage(message);
  } catch (e) {
    console.error('Unexpected error handling message:', e);
  }
};
```

#### 4. Update WebRTC Service

**Modified `/packages/web-client/src/lib/webrtc.ts`:**

```typescript
import { validateDataChannelMessage, handshakeMessageSchema } from './validation';

// In setupMessageChannel:
channel.onmessage = (event) => {
  // Size check (existing)
  const dataSize = typeof event.data === 'string'
    ? event.data.length
    : event.data.byteLength || 0;
  if (dataSize > MAX_DATA_CHANNEL_MESSAGE_SIZE) {
    console.error('Rejected message channel data: exceeds 1MB size limit');
    return;
  }

  // Try to parse as JSON for handshake
  try {
    const parsed = JSON.parse(event.data);
    const handshake = handshakeMessageSchema.safeParse(parsed);
    if (handshake.success) {
      this.events.onHandshake(handshake.data.publicKey);
      return;
    }
  } catch {
    // Not JSON, treat as encrypted message
  }

  // Regular encrypted message
  this.events.onMessage(event.data);
};

// In setupFileChannel:
channel.onmessage = (event) => {
  const dataSize = typeof event.data === 'string'
    ? event.data.length
    : event.data.byteLength || 0;
  if (dataSize > MAX_DATA_CHANNEL_MESSAGE_SIZE) {
    console.error('Rejected file channel data: exceeds 1MB size limit');
    return;
  }

  try {
    const parsed = JSON.parse(event.data);
    const message = validateDataChannelMessage(parsed);

    if (!message) {
      console.error('Invalid file channel message');
      return;
    }

    switch (message.type) {
      case 'file_start':
        this.events.onFileStart(
          message.fileId,
          message.fileName,
          message.totalSize,
          message.totalChunks
        );
        break;
      case 'file_chunk':
        this.events.onFileChunk(message.fileId, message.chunkIndex, message.data);
        break;
      case 'file_complete':
        this.events.onFileComplete(message.fileId);
        break;
      case 'file_error':
        this.events.onFileError(message.fileId, message.error);
        break;
    }
  } catch (e) {
    console.error('Failed to process file message:', e);
  }
};
```

### Dart Implementation

#### New file: `/packages/app/lib/core/network/message_validator.dart`

```dart
import 'dart:convert';

/// Validation result containing either valid data or an error message.
class ValidationResult<T> {
  final T? data;
  final String? error;

  ValidationResult.success(this.data) : error = null;
  ValidationResult.failure(this.error) : data = null;

  bool get isValid => data != null;
}

/// Validator for signaling messages.
class SignalingMessageValidator {
  static const _pairingCodePattern = r'^[A-HJ-NP-Z2-9]{6}$';
  static final _pairingCodeRegex = RegExp(_pairingCodePattern);

  /// Validates a pairing code format.
  static bool isValidPairingCode(String? code) {
    if (code == null) return false;
    return _pairingCodeRegex.hasMatch(code);
  }

  /// Validates a public key (base64 encoded).
  static bool isValidPublicKey(String? key) {
    if (key == null || key.length < 32 || key.length > 256) return false;
    try {
      base64Decode(key);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Safely extracts a string from a map.
  static String? getString(Map<String, dynamic> json, String key, {
    int? maxLength,
    bool required = true,
  }) {
    final value = json[key];
    if (value == null) {
      return required ? null : '';
    }
    if (value is! String) return null;
    if (maxLength != null && value.length > maxLength) return null;
    return value;
  }

  /// Safely extracts an int from a map.
  static int? getInt(Map<String, dynamic> json, String key, {
    int? min,
    int? max,
  }) {
    final value = json[key];
    if (value == null || value is! int) return null;
    if (min != null && value < min) return null;
    if (max != null && value > max) return null;
    return value;
  }

  /// Safely extracts a bool from a map.
  static bool? getBool(Map<String, dynamic> json, String key) {
    final value = json[key];
    if (value == null || value is! bool) return null;
    return value;
  }

  /// Safely extracts a map from a map.
  static Map<String, dynamic>? getMap(Map<String, dynamic> json, String key) {
    final value = json[key];
    if (value == null || value is! Map<String, dynamic>) return null;
    return value;
  }

  /// Validates an offer message.
  static ValidationResult<Map<String, dynamic>> validateOffer(Map<String, dynamic> json) {
    final from = getString(json, 'from');
    if (from == null || !isValidPairingCode(from)) {
      return ValidationResult.failure('Invalid or missing "from" field');
    }

    final payload = getMap(json, 'payload');
    if (payload == null) {
      return ValidationResult.failure('Invalid or missing "payload" field');
    }

    // Validate SDP structure
    final sdp = getString(payload, 'sdp', maxLength: 100000, required: false);
    final type = getString(payload, 'type', required: false);
    if (type != null && !['offer', 'answer', 'pranswer', 'rollback'].contains(type)) {
      return ValidationResult.failure('Invalid SDP type');
    }

    return ValidationResult.success({
      'from': from,
      'payload': {'sdp': sdp, 'type': type},
    });
  }

  /// Validates an answer message.
  static ValidationResult<Map<String, dynamic>> validateAnswer(Map<String, dynamic> json) {
    // Same validation as offer
    return validateOffer(json);
  }

  /// Validates an ICE candidate message.
  static ValidationResult<Map<String, dynamic>> validateIceCandidate(Map<String, dynamic> json) {
    final from = getString(json, 'from');
    if (from == null || !isValidPairingCode(from)) {
      return ValidationResult.failure('Invalid or missing "from" field');
    }

    final payload = getMap(json, 'payload');
    if (payload == null) {
      return ValidationResult.failure('Invalid or missing "payload" field');
    }

    // ICE candidate fields are all optional
    final candidate = getString(payload, 'candidate', maxLength: 10000, required: false);
    final sdpMid = getString(payload, 'sdpMid', maxLength: 100, required: false);
    final sdpMLineIndex = getInt(payload, 'sdpMLineIndex', min: 0, max: 255);

    return ValidationResult.success({
      'from': from,
      'payload': {
        'candidate': candidate,
        'sdpMid': sdpMid,
        'sdpMLineIndex': sdpMLineIndex,
      },
    });
  }

  /// Validates a pair_incoming message.
  static ValidationResult<Map<String, dynamic>> validatePairIncoming(Map<String, dynamic> json) {
    final fromCode = getString(json, 'fromCode');
    if (fromCode == null || !isValidPairingCode(fromCode)) {
      return ValidationResult.failure('Invalid or missing "fromCode" field');
    }

    final fromPublicKey = getString(json, 'fromPublicKey', maxLength: 256);
    if (fromPublicKey == null || !isValidPublicKey(fromPublicKey)) {
      return ValidationResult.failure('Invalid or missing "fromPublicKey" field');
    }

    return ValidationResult.success({
      'fromCode': fromCode,
      'fromPublicKey': fromPublicKey,
    });
  }

  /// Validates a pair_matched message.
  static ValidationResult<Map<String, dynamic>> validatePairMatched(Map<String, dynamic> json) {
    final peerCode = getString(json, 'peerCode');
    if (peerCode == null || !isValidPairingCode(peerCode)) {
      return ValidationResult.failure('Invalid or missing "peerCode" field');
    }

    final peerPublicKey = getString(json, 'peerPublicKey', maxLength: 256);
    if (peerPublicKey == null || !isValidPublicKey(peerPublicKey)) {
      return ValidationResult.failure('Invalid or missing "peerPublicKey" field');
    }

    final isInitiator = getBool(json, 'isInitiator');
    if (isInitiator == null) {
      return ValidationResult.failure('Invalid or missing "isInitiator" field');
    }

    return ValidationResult.success({
      'peerCode': peerCode,
      'peerPublicKey': peerPublicKey,
      'isInitiator': isInitiator,
    });
  }

  /// Validates a handshake message.
  static ValidationResult<Map<String, dynamic>> validateHandshake(Map<String, dynamic> json) {
    final publicKey = getString(json, 'publicKey', maxLength: 256);
    if (publicKey == null || !isValidPublicKey(publicKey)) {
      return ValidationResult.failure('Invalid or missing "publicKey" field');
    }

    return ValidationResult.success({'publicKey': publicKey});
  }

  /// Validates a file_start message.
  static ValidationResult<Map<String, dynamic>> validateFileStart(Map<String, dynamic> json) {
    final fileId = getString(json, 'fileId', maxLength: 100);
    if (fileId == null || fileId.isEmpty) {
      return ValidationResult.failure('Invalid or missing "fileId" field');
    }

    final fileName = getString(json, 'fileName', maxLength: 255);
    if (fileName == null || fileName.isEmpty) {
      return ValidationResult.failure('Invalid or missing "fileName" field');
    }

    final totalSize = getInt(json, 'totalSize', min: 0);
    if (totalSize == null) {
      return ValidationResult.failure('Invalid or missing "totalSize" field');
    }

    final totalChunks = getInt(json, 'totalChunks', min: 1, max: 1000000);
    if (totalChunks == null) {
      return ValidationResult.failure('Invalid or missing "totalChunks" field');
    }

    return ValidationResult.success({
      'fileId': fileId,
      'fileName': fileName,
      'totalSize': totalSize,
      'totalChunks': totalChunks,
    });
  }

  /// Validates a file_chunk message.
  static ValidationResult<Map<String, dynamic>> validateFileChunk(Map<String, dynamic> json) {
    final fileId = getString(json, 'fileId', maxLength: 100);
    if (fileId == null || fileId.isEmpty) {
      return ValidationResult.failure('Invalid or missing "fileId" field');
    }

    final chunkIndex = getInt(json, 'chunkIndex', min: 0);
    if (chunkIndex == null) {
      return ValidationResult.failure('Invalid or missing "chunkIndex" field');
    }

    final data = getString(json, 'data');
    if (data == null) {
      return ValidationResult.failure('Invalid or missing "data" field');
    }

    return ValidationResult.success({
      'fileId': fileId,
      'chunkIndex': chunkIndex,
      'data': data,
    });
  }
}
```

#### Updated signaling client usage:

```dart
void _handleMessage(dynamic data) {
  Map<String, dynamic> json;
  try {
    json = jsonDecode(data as String) as Map<String, dynamic>;
  } catch (e) {
    logger.warning('SignalingClient', 'Failed to parse message JSON', e);
    return;
  }

  final type = json['type'];
  if (type is! String) {
    logger.warning('SignalingClient', 'Message missing type field');
    return;
  }

  switch (type) {
    case 'offer':
      final result = SignalingMessageValidator.validateOffer(json);
      if (!result.isValid) {
        logger.warning('SignalingClient', 'Invalid offer: ${result.error}');
        return;
      }
      _messageController.add(SignalingMessage.offer(
        from: result.data!['from'] as String,
        payload: result.data!['payload'] as Map<String, dynamic>,
      ));
      break;
    // ... other cases with validation
  }
}
```

---

## Performance Considerations

### Bundle Size Impact

| Library | Minified | Gzipped |
|---------|----------|---------|
| Zod     | ~45kb    | ~8kb    |
| io-ts   | ~35kb    | ~7kb    |
| Manual  | ~2kb     | ~0.5kb  |

**Recommendation**: Zod's 8kb gzipped overhead is acceptable for the security benefits. For extremely size-sensitive applications, the manual validation approach shown above adds negligible overhead.

### Runtime Performance

**Zod benchmarks** (typical message validation):
- Simple object: ~0.01ms
- Complex discriminated union: ~0.05ms
- With nested objects: ~0.1ms

**Impact analysis**:
- Messages are received at low frequency (signaling: ~1/sec, file chunks: ~100/sec)
- 0.1ms validation overhead is negligible compared to network latency
- No observable user impact

### Memory Considerations

- Zod schemas are defined once and reused
- Validation creates minimal intermediate objects
- Garbage collection impact is negligible

### Optimizations

1. **Schema Caching**: Zod schemas should be defined at module level, not per-call
2. **Lazy Parsing**: For file chunks, validate only metadata fields first
3. **Discriminated Unions**: Use `z.discriminatedUnion()` instead of `z.union()` for O(1) type resolution

---

## Implementation Priority

### High Priority (Security Critical)
1. `pair_matched` - contains public key for encryption
2. `offer` / `answer` - SDP could be malformed
3. `handshake` - public key exchange

### Medium Priority
4. `pair_incoming` - user-facing pairing code display
5. `ice_candidate` - WebRTC connection
6. `file_start` - file metadata

### Lower Priority
7. `file_chunk` - already has size limits
8. `pong` - no payload
9. `error` - informational only

---

## Testing Requirements

1. **Unit Tests**: Each validator function with valid/invalid inputs
2. **Fuzz Testing**: Random input generation to find edge cases
3. **Integration Tests**: End-to-end with malformed server responses
4. **Property-Based Tests**: Verify round-trip serialization/deserialization

---

## Summary

The current codebase has no runtime type validation for signaling messages, relying solely on TypeScript's compile-time type assertions and Dart's unsafe casts. This creates multiple attack vectors including DoS, state corruption, and type confusion.

**Recommended Solution**:
- TypeScript: Add Zod validation schemas (~8kb bundle impact)
- Dart: Add manual validation helper class (~2kb impact)

**Expected Outcomes**:
- Graceful handling of malformed messages
- Detailed error logging for debugging
- Protection against malicious message injection
- No observable performance impact

---

## Research: How Other Apps Solve This

This section documents how production messaging applications and popular validation libraries handle runtime type validation for protocol messages.

### 1. Signal Protocol: Protobuf Message Validation

**Approach: Schema-First with Binary Serialization**

Signal uses [Protocol Buffers (Protobuf)](https://protobuf.dev/programming-guides/proto3/) for all protocol messages. The [libsignal repository](https://github.com/signalapp/libsignal) implements the Signal Protocol in Rust with bindings for Java, Swift, and TypeScript.

**How It Works:**
- Message schemas are defined in `.proto` files (e.g., `WhisperMessage`, `PreKeyWhisperMessage`, `Envelope`)
- Each message type has a unique 32-bit Constructor ID for identification
- The Rust implementation uses the [prost](https://crates.io/crates/libsignal-rust) library for protobuf serialization/deserialization
- Decoding invalid messages returns explicit errors rather than crashing

**Validation Characteristics:**
- **Type Safety**: Protobuf enforces field types at the schema level
- **Wire Format Validation**: Invalid binary data fails to parse with explicit errors
- **Field Presence**: Proto3 distinguishes between unset and zero-value for wrapper types
- **Evolution**: Numbered fields allow backward-compatible schema changes

**Malformed Message Handling:**
```rust
// Example pattern from libsignal-rust
let message = WhisperMessage::decode(message_bytes)
    .map_err(|e| SignalProtocolError::InvalidMessage(format!("decode error: {}", e)))?;
```

**Lessons for Zajel:**
- Schema-first approach catches type errors at compile time
- Binary format is more compact and faster to parse than JSON
- Consider [protovalidate](https://github.com/bufbuild/protovalidate) for semantic validation rules

---

### 2. Telegram MTProto: TL Schema Validation

**Approach: Custom Type Language with Binary Serialization**

Telegram uses [MTProto](https://core.telegram.org/mtproto), a custom protocol with TL (Type Language) schema definitions. The [TL Schema](https://core.telegram.org/schema/mtproto) defines all message types.

**How It Works:**
- TL schemas compile to binary `.tlo` files for fast parsing
- Each object has a unique constructor ID (32-bit hash of type signature)
- Libraries like [gotd/tl](https://github.com/gotd/tl) provide schema parsing with validation
- [Telethon](https://deepwiki.com/LonamiWebs/Telethon/5.1-tlobject-system-and-binary-handling) (Python client) implements comprehensive type checking

**Validation Process:**
1. Read constructor ID from binary stream
2. Look up type definition in schema
3. Parse fields according to schema types
4. Raise `TypeNotFoundError` for unknown constructors

**Error Handling (from Telethon):**
```python
# When an unknown constructor ID is encountered
raise TypeNotFoundError(constructor_id, binary_data)
```

**Malformed Message Handling:**
- Unknown constructor IDs trigger explicit errors with debug info
- Type mismatches during serialization are caught before transmission
- Strict binary format prevents injection attacks

**Lessons for Zajel:**
- Constructor IDs enable fast message type discrimination
- Schema compilation step catches errors early
- Explicit error types help with debugging

---

### 3. Matrix Protocol: JSON Schema Event Validation

**Approach: JSON with Server-Side Validation**

The [Matrix Specification](https://spec.matrix.org/latest/) uses JSON for all events with comprehensive validation requirements documented in [Issue #365](https://github.com/matrix-org/matrix-spec/issues/365).

**Validation Philosophy:**
> "Event bodies are considered untrusted data. Any application using Matrix must validate that the event body is of the expected shape/schema before using the contents verbatim."

**Server-Side Validation (Federation):**
The [gomatrixserverlib](https://pkg.go.dev/github.com/matrix-org/gomatrixserverlib) Go package performs:
- Required field presence checks
- Type matching against expected grammars
- Length limit enforcement
- Event-type-specific validation (e.g., membership values)
- Signature verification for origin server

**JSON Schema Standards:**
- Uses JSON Schema Draft 2020-12 for event schemas
- Application Service Registration schema formally defined
- OpenAPI specs generated from schemas

**Canonical JSON:**
```go
// CanonicalJSON re-encodes JSON in canonical form
// Returns BadJSONError if validation fails
func CanonicalJSON(input []byte) ([]byte, error)
```

**Lessons for Zajel:**
- JSON Schema provides standardized validation language
- Canonical JSON ensures consistent hashing/signing
- Federation requires stricter validation than client-server

---

### 4. WhatsApp: Security Lessons from Protobuf

**Historical Vulnerabilities:**

[Check Point Research](https://research.checkpoint.com/2018/fakesapp-a-vulnerability-in-whatsapp/) discovered that WhatsApp uses protobuf2 for message serialization. By decrypting and manipulating protobuf fields, researchers found message spoofing vulnerabilities.

**Security Advisories ([WhatsApp Security](https://www.whatsapp.com/security/advisories/archive)):**
- Input validation issues allowed files with wrong extensions
- Buffer overflow in VOIP stack via malformed RTCP packets
- Heap corruption from malformed RTP packets

**Key Insight:**
Even with Protobuf's type safety, semantic validation (e.g., checking extension vs filename) is still required. Protobuf validates structure, not business logic.

---

### 5. TypeScript/JavaScript Validation Libraries

#### Zod (Recommended for Most Projects)

[Zod](https://zod.dev/) is the de-facto standard for TypeScript runtime validation.

**Performance Characteristics ([Benchmarks](https://moltar.github.io/typescript-runtime-type-benchmarks/)):**
- Simple object validation: ~0.01ms
- Complex discriminated union: ~0.05ms
- Bundle size: ~15-17 kB (minified), ~8 kB (gzipped)

**Strengths:**
- Excellent TypeScript type inference
- Chainable API with great DX
- `discriminatedUnion()` provides O(1) type resolution
- Active community and ecosystem integration

**Weaknesses ([Why is Zod slow?](https://blog.logrocket.com/why-zod-slow/)):**
- Parsing and deep-copying inputs reduces performance
- Methods like `.extend/.pick/.omit` cause performance regression
- Not suitable for >1000 validations/second scenarios

#### TypeBox (Fastest Runtime)

[TypeBox](https://github.com/sinclairzx81/typebox) generates JSON Schema from TypeScript types.

**Performance:**
- 5-18x faster than Zod for complex validations
- Compiles schemas to optimized JavaScript functions
- Works with AJV for validation

**Best For:**
- OpenAPI specification generation
- High-throughput APIs
- JSON Schema interoperability

#### Valibot (Smallest Bundle)

[Valibot](https://valibot.dev/guides/comparison/) focuses on minimal bundle size.

**Performance:**
- ~2x faster than Zod v3, similar to Zod v4
- Bundle size: ~1.37 kB (90% smaller than Zod)
- Tree-shakable design

**Best For:**
- Bundle-sensitive applications
- Mobile web apps
- Large/complex schemas

#### io-ts (Functional Approach)

[io-ts](https://github.com/gcanti/io-ts) provides functional programming patterns.

**Performance:**
- ~8x slower than AJV
- Better than Zod for most operations
- Integrates with fp-ts ecosystem

**Best For:**
- Teams comfortable with FP patterns
- Projects using fp-ts/Effect

#### AJV (Fastest JSON Schema)

[AJV](https://ajv.js.org/) is the fastest JSON Schema validator.

**Performance:**
- Processing in ~42 nanoseconds
- Pre-compiles schemas to JavaScript
- Supports JSON Schema drafts 4-2020-12

**Weaknesses:**
- Poor TypeScript DX (manual type definitions)
- JSON Schema verbosity
- More setup required

#### Comparison Table

| Library | Runtime Speed | Bundle Size | TypeScript DX | Best For |
|---------|--------------|-------------|---------------|----------|
| **TypeBox + AJV** | Fastest (10x faster) | Small | Good | High-throughput APIs |
| **Valibot** | Fast (2x faster than Zod) | Smallest (~1.4 kB) | Good | Bundle-sensitive apps |
| **Zod** | Moderate | Medium (~15 kB) | Excellent | Most TypeScript projects |
| **io-ts** | Moderate | Small | Good (FP) | Functional programming |
| **AJV** | Fastest | Larger | Poor | JSON Schema compatibility |

---

### 6. Dart Validation Libraries

#### json_serializable (Code Generation)

[json_serializable](https://pub.dev/packages/json_serializable) generates `fromJson`/`toJson` methods.

**How It Works:**
- Annotate classes with `@JsonSerializable()`
- Run `build_runner` to generate code
- Type checking happens at generation time

**Limitations:**
- Runtime casts can still throw if JSON has wrong types
- No semantic validation (e.g., string length, ranges)
- Requires regeneration on model changes

#### freezed (Immutable Models + Serialization)

[freezed](https://pub.dev/packages/freezed) combines immutability with json_serializable.

**Features:**
- Generates `copyWith`, `==`, `hashCode`, `toString`
- Union types with `runtimeType` discrimination
- Integrates with json_serializable

**Runtime Type Handling:**
```dart
// Freezed checks 'runtimeType' in JSON for union types
@freezed
class Message with _$Message {
  const factory Message.text({required String content}) = TextMessage;
  const factory Message.file({required String fileId}) = FileMessage;
}
```

**Limitations:**
- Code generation is slow on large projects
- Still relies on unsafe casts for primitives
- Generic types have limitations

#### built_value (Immutable + Validation)

[built_value](https://pub.dev/packages/built_value) provides builder pattern with validation.

**Validation Approach:**
- Override `_initializeBuilder` for defaults
- Add `_validate` method for custom rules
- Throws if invariants violated

#### Safe Parsing Libraries

**[json_type_guard](https://pub.dev/packages/json_type_guard)**
- Zero-codegen runtime-safe parsing
- Field-level error messages
- Type coercion with fallbacks

**[autosafe_json](https://pub.dev/packages/autosafe_json)**
- Automatic type coercion ("true" -> true, "123" -> 123)
- Null fallback on conversion failure

**[json_schema](https://pub.dev/packages/json_schema)**
- JSON Schema Draft 4-7 validation
- Validate parsed or raw JSON strings

**[deep_pick](https://pub.dev/packages/deep_pick)**
- Type-safe nested JSON access
- Optional values with defaults

#### Recommended Dart Approach

For Zajel's use case, combine:
1. **freezed** for immutable message models
2. **Manual validation helper** (as proposed) for semantic checks
3. **Try-catch with logging** instead of silent failures

Example pattern:
```dart
ValidationResult<T> safeDeserialize<T>(
  String json,
  T Function(Map<String, dynamic>) fromJson,
) {
  try {
    final map = jsonDecode(json) as Map<String, dynamic>;
    return ValidationResult.success(fromJson(map));
  } on FormatException catch (e) {
    return ValidationResult.failure('Invalid JSON: $e');
  } on TypeError catch (e) {
    return ValidationResult.failure('Type mismatch: $e');
  }
}
```

---

### 7. Schema-First vs Code-First Validation

| Aspect | Schema-First (Protobuf/TL) | Code-First (Zod/TypeScript) |
|--------|---------------------------|------------------------------|
| **Type Safety** | Enforced at schema level | Runtime checking |
| **Performance** | Faster (binary, compiled) | Slower (JSON parsing) |
| **Flexibility** | Requires schema updates | Iterate quickly |
| **Validation Depth** | Structure only (needs protovalidate) | Full semantic validation |
| **Backward Compatibility** | Built-in (numbered fields) | Manual management |
| **Learning Curve** | Higher (new tools) | Lower (familiar patterns) |
| **Bundle Size** | Smaller (binary) | Larger (JSON + validator) |

**For Zajel:**
- Current JSON-based approach is appropriate for a WebRTC signaling app
- Adding Zod provides sufficient validation without protocol changes
- If performance becomes critical, consider protobuf migration

---

### 8. Best Practices for Malformed Message Handling

Based on [RFC 7103](https://datatracker.ietf.org/doc/rfc7103/) and messaging system patterns:

#### 1. Fail Fast, Fail Safely
```typescript
// Bad: Silent failure
try { handleMessage(parse(data)); } catch {}

// Good: Log and gracefully degrade
const result = validateMessage(data);
if (!result.success) {
  logger.warn('Invalid message', { error: result.error, data });
  return; // Don't crash, don't proceed with invalid data
}
handleMessage(result.data);
```

#### 2. Detailed Error Context
Include in validation errors:
- Field name that failed
- Expected type vs received type
- Truncated sample of invalid value
- Message type if determinable

#### 3. Rate Limiting Invalid Messages
Repeated invalid messages may indicate:
- Protocol mismatch (version skew)
- Malicious actor (fuzzing attack)
- Network corruption

Consider disconnecting after N consecutive failures.

#### 4. Dead Letter Queue Pattern
For async systems, move invalid messages to a dead letter queue for:
- Later analysis
- Pattern detection
- Debugging

#### 5. Canonical Form Enforcement
For security-sensitive messages (like signed payloads):
- Re-encode to canonical form before verification
- Reject non-canonical encodings

---

### 9. Performance Considerations Summary

| Scenario | Recommended Approach | Expected Overhead |
|----------|---------------------|-------------------|
| Signaling (1-10 msg/sec) | Zod with full validation | Negligible (<1ms) |
| File chunks (100+ msg/sec) | Validate metadata only | ~0.1ms per message |
| High-throughput API | TypeBox + AJV | ~0.001ms per message |
| Bundle-critical web | Valibot | Smallest size |
| Mobile (Dart) | Manual + freezed | ~0.5ms per message |

**Key Insight:**
For Zajel's signaling use case, validation overhead is negligible compared to network latency. Prioritize correctness and developer experience over micro-optimization.

---

### 10. References

**Protocol Implementations:**
- [Signal libsignal](https://github.com/signalapp/libsignal) - Signal Protocol implementation
- [Telegram MTProto](https://core.telegram.org/mtproto) - Telegram protocol specification
- [Matrix Specification](https://spec.matrix.org/latest/) - Matrix protocol docs
- [protovalidate](https://github.com/bufbuild/protovalidate) - Protobuf semantic validation

**TypeScript Libraries:**
- [Zod](https://zod.dev/) - TypeScript-first schema validation
- [TypeBox](https://github.com/sinclairzx81/typebox) - JSON Schema type builder
- [Valibot](https://valibot.dev/) - Modular validation library
- [Runtype Benchmarks](https://moltar.github.io/typescript-runtime-type-benchmarks/) - Performance comparison

**Dart Libraries:**
- [freezed](https://pub.dev/packages/freezed) - Immutable class generator
- [json_serializable](https://pub.dev/packages/json_serializable) - JSON serialization
- [json_type_guard](https://pub.dev/packages/json_type_guard) - Runtime-safe parsing

**Security Research:**
- [FakesApp Vulnerability](https://research.checkpoint.com/2018/fakesapp-a-vulnerability-in-whatsapp/) - WhatsApp protobuf manipulation
- [RFC 7103](https://datatracker.ietf.org/doc/rfc7103/) - Handling malformed messages
