# Issue #20: Type Validation Consistency Research

## Summary

This document audits the current state of runtime type validation across the Zajel codebase, identifies which `JSON.parse()` calls have proper validation, and provides recommendations for achieving consistent type safety at system boundaries.

---

## Current State Audit

### Overview

The web-client package has implemented comprehensive runtime validation in `/packages/web-client/src/lib/validation.ts`. However, validation consistency varies across the codebase. This audit examines all `JSON.parse()` locations and their validation status.

---

## JSON.parse() Locations Audit

### Web Client (TypeScript)

| File | Location | Has Validation | Notes |
|------|----------|----------------|-------|
| `/packages/web-client/src/lib/validation.ts:569` | `safeJsonParse()` | Yes (wrapper) | Safe wrapper that returns null on failure |
| `/packages/web-client/src/lib/signaling.ts:176` | WebSocket onmessage | **Yes** | Uses `safeJsonParse()` + `validateServerMessage()` |
| `/packages/web-client/src/lib/webrtc.ts:179` | Message channel | **Yes** | Uses `safeJsonParse()` + `validateHandshake()` |
| `/packages/web-client/src/lib/webrtc.ts:211` | File channel | **Yes** | Uses `safeJsonParse()` + `validateDataChannelMessage()` |

**Status**: Web client has **complete validation coverage** for all JSON parsing of untrusted network data.

### Server VPS (TypeScript)

| File | Location | Has Validation | Notes |
|------|----------|----------------|-------|
| `/packages/server-vps/src/client/handler.ts:292` | Client message handler | **Partial** | Parses to `ClientMessage` type assertion, then switch on type |
| `/packages/server-vps/src/federation/federation-manager.ts:285` | Federation messages | **No** | Direct parse with type checks only |
| `/packages/server-vps/src/federation/transport/server-connection.ts:251` | Outgoing handshake | **Partial** | Checks `message.type` but no full validation |
| `/packages/server-vps/src/federation/transport/server-connection.ts:321` | Incoming handshake | **Partial** | Verifies signature but no schema validation |
| `/packages/server-vps/src/federation/transport/server-connection.ts:433` | Federation messages | **No** | Only checks `message.type === 'gossip'` |
| `/packages/server-vps/src/storage/sqlite.ts:148,178,258,284,484,509,534,564,580` | Database reads | **No** | Parses stored JSON (trusted data from DB) |
| `/packages/server-vps/src/identity/server-identity.ts:147,221` | Identity loading | **No** | Parses from file/payload (should validate) |

**Status**: Server VPS has **gaps in validation**, particularly for:
1. Client message handling (uses type assertions)
2. Federation protocol messages
3. Identity payload parsing

### Server (Cloudflare Workers - JavaScript)

| File | Location | Has Validation | Notes |
|------|----------|----------------|-------|
| `/packages/server/src/websocket-handler.js:39` | Message handler | **Minimal** | Try-catch only, no field validation |
| `/packages/server/src/signaling-room.js:37` | WebSocket message | **Minimal** | Try-catch only, basic type checks |
| `/packages/server/src/durable-objects/relay-registry-do.js:95` | WebSocket message | **Minimal** | Try-catch with field existence checks |

**Status**: Cloudflare Workers server has **minimal validation** - only basic error handling without schema validation.

### Test Files

Test files use `JSON.parse()` for assertions which is acceptable:
- `/packages/server/src/__tests__/websocket-handler.test.js:28`
- `/packages/server/src/__tests__/relay-registry-do.test.js:87,127,133,199,246`
- `/packages/web-client/src/lib/__tests__/signaling.test.ts:78`
- `/packages/web-client/src/lib/__tests__/webrtc.test.ts:534,627,646,663,678`
- `/packages/server-vps/tests/unit/client-handler-pairing.test.ts:49`

---

## Validation Implementation Analysis

### Current validation.ts Features

The existing `/packages/web-client/src/lib/validation.ts` implements:

1. **Type Guards**: `isObject()`, `isString()`, `isBoolean()`, `isNumber()`, `isInteger()`
2. **Domain Validators**: `isValidPairingCode()`, `isValidPublicKey()`, `isValidSdpPayload()`, `isValidIceCandidatePayload()`
3. **Message Validators**: Complete validators for all server and data channel message types
4. **Discriminated Union Pattern**: `validateServerMessage()` and `validateDataChannelMessage()` dispatch by type
5. **XSS Prevention**: `sanitizeDisplayName()`, `sanitizeFilename()`, `sanitizeMessage()`, `sanitizeErrorMessage()`, `sanitizeUrl()`
6. **Result Type**: `ValidationResult<T>` with `success`/`failure` factories

### Strengths

- Comprehensive coverage of all web client message types
- Size limits enforced (MAX_PUBLIC_KEY_LENGTH, MAX_SDP_LENGTH, etc.)
- Returns structured validation results, not just boolean
- XSS prevention for user-facing data

### Gaps Identified

1. **No shared validation between packages**: Server-VPS could reuse web-client validators
2. **No Zod adoption**: Custom validators work but miss Zod's type inference benefits
3. **Server-side validation incomplete**: VPS and Cloudflare Workers lack equivalent validation
4. **Federation messages unvalidated**: Gossip protocol messages have no schema validation

---

## Library Comparison

### Runtime Type Validation Libraries

Based on research from [typescript-runtime-type-benchmarks](https://github.com/moltar/typescript-runtime-type-benchmarks) and [Runtype Benchmarks](https://moltar.github.io/typescript-runtime-type-benchmarks/):

| Library | Bundle Size | Performance | TypeScript DX | Best For |
|---------|-------------|-------------|---------------|----------|
| **Zod** | ~15-17 kB (min), ~8 kB (gzip) | Moderate | Excellent | General use, great DX |
| **Valibot** | ~1.37 kB (gzip) | Fast (2x Zod) | Good | Bundle-critical apps |
| **TypeBox + AJV** | Varies | Fastest (10x Zod) | Good | High-throughput APIs |
| **io-ts** | ~35 kB | Moderate | Good (FP style) | Functional programming |
| **Custom (current)** | ~2 kB | Fast | Manual | Full control |

### Recommendation

For Zajel's use case:
- **Keep custom validators** for web-client (already implemented, working well)
- **Add validation to server-vps** using shared validator module or Zod
- **Consider Valibot** if bundle size becomes critical

---

## How Other Apps Validate Messages

### Discord Gateway

Discord uses WebSocket Gateway with these validation approaches:
- **OP Codes**: Each message has an operation code for type discrimination
- **Rate Limiting**: 120 events per 60 seconds to prevent abuse
- **Heartbeat Mechanism**: Regular keepalive messages required
- **Session Validation**: Authentication via bot tokens with identification payloads
- **Compression Support**: Zlib-compressed JSON with detection before parsing

Source: [Discord Gateway Documentation](https://github.com/meew0/discord-api-docs-1/blob/master/docs/topics/GATEWAY.md)

### Slack API

Slack emphasizes security at system boundaries:
- **Request Signing**: HMAC SHA256 signatures verified using signing secret
- **Timestamp Validation**: Prevents replay attacks with X-Slack-Request-Timestamp
- **Raw Body Preservation**: Original request body used for signature calculation
- **Token Security**: Secrets never exposed in client-side code
- **Input Validation**: All function inputs validated before processing

Sources:
- [Slack Security Best Practices](https://api.slack.com/automation/security)
- [Verifying Requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/)

### Matrix Protocol

Matrix treats event bodies as untrusted data:
- **JSON Schema**: Uses Draft 2020-12 for event validation
- **Canonical JSON**: Required for signature verification
- **Server-Side Validation**: Federation requires strict validation
- **Event Schemas**: Maintained at [matrix-org/matrix-spec](https://github.com/matrix-org/matrix-spec/tree/main/data/event-schemas/schema)

Key principle from Matrix spec:
> "Event bodies are considered untrusted data. Any application using Matrix must validate that the event body is of the expected shape/schema before using the contents verbatim."

Source: [Matrix Specification](https://spec.matrix.org/latest/)

---

## Implementation Plan

### Phase 1: Server-VPS Validation (High Priority)

1. **Create shared validators module**
   - Extract common validators from web-client
   - Add server-specific message validators
   - Location: `/packages/server-vps/src/validation/`

2. **Update client handler**
   ```typescript
   // /packages/server-vps/src/client/handler.ts
   import { validateClientMessage } from './validation';

   async handleMessage(ws: WebSocket, data: string): Promise<void> {
     // Existing size check...

     const parsed = safeJsonParse(data);
     if (parsed === null) {
       this.sendError(ws, 'Invalid JSON');
       return;
     }

     const result = validateClientMessage(parsed);
     if (!result.success) {
       this.sendError(ws, `Invalid message: ${result.error}`);
       return;
     }

     // Handle validated message...
   }
   ```

3. **Add federation message validators**
   - Validate handshake messages
   - Validate gossip protocol messages
   - Validate state sync payloads

### Phase 2: Cloudflare Workers Server (Medium Priority)

1. **Add validation module**
   - Port essential validators to JavaScript
   - Keep bundle size minimal for edge deployment

2. **Update message handlers**
   - `/packages/server/src/websocket-handler.js`
   - `/packages/server/src/signaling-room.js`
   - `/packages/server/src/durable-objects/relay-registry-do.js`

### Phase 3: Dart Mobile App (Lower Priority)

1. **Create message validator class**
   - Location: `/packages/app/lib/core/network/message_validator.dart`
   - Safe extraction helpers with null fallbacks
   - Type-checked deserialization

2. **Update network services**
   - `/packages/app/lib/core/network/signaling_client.dart`
   - `/packages/app/lib/core/network/webrtc_service.dart`

---

## Validation Checklist

### Server Message Types (Server -> Client)

| Message Type | Web Client | Server VPS | CF Workers |
|-------------|------------|------------|------------|
| registered | Validated | N/A | Sends only |
| pair_incoming | Validated | Sends only | Sends only |
| pair_expiring | Validated | Sends only | N/A |
| pair_matched | Validated | Sends only | N/A |
| pair_rejected | Validated | Sends only | N/A |
| pair_timeout | Validated | Sends only | N/A |
| pair_error | Validated | Sends only | N/A |
| offer | Validated | Forwards | Forwards |
| answer | Validated | Forwards | Forwards |
| ice_candidate | Validated | Forwards | Forwards |
| pong | Validated | Sends only | Sends only |
| error | Validated | Sends only | Sends only |

### Client Message Types (Client -> Server)

| Message Type | Server VPS | CF Workers |
|-------------|------------|------------|
| register | **Needs validation** | Basic checks only |
| pair_request | **Needs validation** | N/A |
| pair_response | **Needs validation** | N/A |
| offer | **Needs validation** | Forwards only |
| answer | **Needs validation** | Forwards only |
| ice_candidate | **Needs validation** | Forwards only |
| ping | Validated (simple) | Validated (simple) |
| update_load | **Needs validation** | Basic checks only |

### Data Channel Messages

| Message Type | Web Client |
|-------------|------------|
| handshake | Validated |
| file_start | Validated |
| file_chunk | Validated |
| file_complete | Validated |
| file_error | Validated |
| file_start_ack | Validated |
| chunk_ack | Validated |
| chunk_retry | Validated |
| file_complete_ack | Validated |
| transfer_cancel | Validated |

---

## Security Considerations

### Attack Vectors Mitigated by Validation

1. **Type Confusion**: Strict type checking prevents wrong type exploitation
2. **Buffer Overflow**: Length limits on strings prevent memory issues
3. **Injection Attacks**: Input sanitization prevents XSS/injection
4. **DoS via Malformed Messages**: Invalid messages rejected early
5. **State Corruption**: Incomplete messages don't trigger handlers

### Remaining Risks

1. **Server-side validation gaps**: Client messages not fully validated on servers
2. **Federation trust**: Gossip messages between servers lack schema validation
3. **Replay attacks**: No validation of message freshness (separate issue)

---

## Testing Recommendations

1. **Unit Tests**: Each validator with valid/invalid inputs
2. **Fuzz Testing**: Generate random inputs to find edge cases
3. **Integration Tests**: End-to-end with malformed payloads
4. **Property-Based Tests**: Verify validation consistency

Existing tests:
- `/packages/web-client/src/lib/__tests__/validation-xss.test.ts`
- Need: Server-side validation tests

---

## Conclusion

The web-client package has achieved comprehensive runtime type validation for all JSON parsing of untrusted data. However, validation consistency is lacking in:

1. **Server-VPS**: Client message handling and federation protocol
2. **Cloudflare Workers**: Minimal validation beyond try-catch
3. **Dart Mobile App**: Relies on unsafe type casts

### Priority Actions

1. **High**: Add client message validation to server-vps handler
2. **Medium**: Add validation to Cloudflare Workers signaling
3. **Medium**: Add federation message schema validation
4. **Lower**: Port validation patterns to Dart mobile app

The custom validation approach in web-client is working well and doesn't require replacing with Zod. However, the validation patterns should be extended to server-side code for defense in depth.

---

## References

- [Zod Documentation](https://zod.dev/)
- [TypeScript Runtime Type Benchmarks](https://github.com/moltar/typescript-runtime-type-benchmarks)
- [Valibot Comparison](https://valibot.dev/guides/comparison/)
- [Discord Gateway](https://github.com/meew0/discord-api-docs-1/blob/master/docs/topics/GATEWAY.md)
- [Slack Security Best Practices](https://api.slack.com/automation/security)
- [Matrix Specification](https://spec.matrix.org/latest/)
- [Matrix Event Schemas](https://github.com/matrix-org/matrix-spec/tree/main/data/event-schemas/schema)
