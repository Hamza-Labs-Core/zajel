# Issue #33: Inconsistent Error Handling Analysis

## Summary

The web client codebase has inconsistent error handling across different modules. Some errors are logged to console, some are shown to users, and some fail silently. This document provides a comprehensive inventory and proposes a consistent strategy.

---

## Error Handling Inventory

### 1. App.tsx - Main Application Component

| Location | Line(s) | Error Type | Handling | Category |
|----------|---------|------------|----------|----------|
| `init()` | 56-281 | Crypto/Signaling init | **No try-catch** - exceptions bubble up | SILENT FAIL |
| `onMessage` callback | 128-148 | Decryption failure | `console.error` only | LOGGED ONLY |
| `onFileStart` | 150-156 | File too large | `console.warn` + notify peer | LOGGED + PEER NOTIFIED |
| `onFileChunk` | 191-209 | Chunk decryption failure | `console.error` + update UI + notify peer | FULL HANDLING |
| `onFileComplete` | 221-254 | Missing chunks/no data | Update UI with error state | USER SHOWN |
| `onPairRejected` | 82-86 | Connection rejected | `setError()` - shown to user | USER SHOWN |
| `onPairTimeout` | 87-91 | Connection timeout | `setError()` - shown to user | USER SHOWN |
| `onPairError` | 92-95 | Pairing error | `setError()` - shown to user | USER SHOWN |
| `onError` | 105-107 | Generic signaling error | `setError()` - shown to user | USER SHOWN |

### 2. crypto.ts - Cryptographic Service

| Location | Line(s) | Error Type | Handling | Category |
|----------|---------|------------|----------|----------|
| `getPublicKeyBase64()` | 48-51 | Not initialized | Throws `Error` | THROWS |
| `getPublicKeyHex()` | 53-56 | Not initialized | Throws `Error` | THROWS |
| `getPublicKeyFingerprint()` | 67-72 | Not initialized | Throws `Error` | THROWS |
| `getPeerPublicKeyFingerprint()` | 82-99 | Invalid base64 | Throws `Error` | THROWS |
| `getPeerPublicKeyFingerprint()` | 92-94 | Wrong key length | Throws `Error` | THROWS |
| `establishSession()` | 110-139 | Not initialized | Throws `Error` | THROWS |
| `establishSession()` | 115-121 | Invalid base64 | Throws `Error` | THROWS |
| `establishSession()` | 124-126 | Wrong key length | Throws `Error` | THROWS |
| `encrypt()` | 155-183 | No session | Throws `Error` | THROWS |
| `decrypt()` | 185-237 | No session | Throws `Error` | THROWS |
| `decrypt()` | 222-229 | Replay attack (old seq) | Throws `Error` | THROWS |
| `decrypt()` | 227-229 | Replay attack (duplicate) | Throws `Error` | THROWS |
| `encryptBytes()` | 239-264 | No session | Throws `Error` | THROWS |
| `decryptBytes()` | 266-309 | No session/replay | Throws `Error` | THROWS |

### 3. signaling.ts - WebSocket Signaling Client

| Location | Line(s) | Error Type | Handling | Category |
|----------|---------|------------|----------|----------|
| `ws.onmessage` | 88-107 | Message too large | `console.error` + disconnect + user notify | FULL HANDLING |
| `ws.onmessage` | 104-106 | JSON parse failure | `console.error` only | LOGGED ONLY |
| `ws.onerror` | 109-112 | WebSocket error | `console.error` + `onError` callback | USER SHOWN |
| `send()` | 176-186 | Send failure | Catches silently, returns `false` | SILENT FAIL |
| `requestPairing()` | 247-257 | Invalid code format | `onError` callback | USER SHOWN |
| `respondToPairing()` | 259-270 | Invalid code format | `onError` callback | USER SHOWN |

### 4. webrtc.ts - WebRTC Service

| Location | Line(s) | Error Type | Handling | Category |
|----------|---------|------------|----------|----------|
| `connect()` | 88-92 | Adding pending ICE | **No try-catch** on loop | SILENT FAIL |
| `handleIceCandidate()` | 112-116 | Queue full | `console.warn` only | LOGGED ONLY |
| `handleIceCandidate()` | 120-124 | Add ICE failure | `console.warn` only | LOGGED ONLY |
| `setupMessageChannel.onmessage` | 132-155 | Message too large | `console.error` only, returns | LOGGED ONLY |
| `setupMessageChannel.onmessage` | 144-154 | JSON parse failure | Swallows, treats as encrypted | SILENT HANDLING |
| `setupMessageChannel.onerror` | 157-159 | Channel error | `console.error` only | LOGGED ONLY |
| `setupFileChannel.onmessage` | 163-197 | Message too large | `console.error` only, returns | LOGGED ONLY |
| `setupFileChannel.onmessage` | 194-196 | JSON parse failure | `console.error` only | LOGGED ONLY |
| `sendHandshake()` | 200-205 | Channel not open | Silently skipped | SILENT FAIL |
| `sendMessage()` | 207-211 | Channel not open | Silently skipped | SILENT FAIL |
| `sendFileStart()` | 213-230 | Channel not open | Silently skipped | SILENT FAIL |
| `sendFileChunk()` | 232-243 | Channel not open | Silently skipped | SILENT FAIL |
| `sendFileComplete()` | 245-249 | Channel not open | Silently skipped | SILENT FAIL |
| `sendFileError()` | 251-255 | Channel not open | Silently skipped | SILENT FAIL |

---

## Categorization Summary

### Category 1: User-Shown Errors (8 instances)
These are appropriately handled and displayed to the user via `setError()`:
- Pair rejected, timeout, and errors
- Generic signaling errors
- Invalid pairing code format
- Oversized WebSocket messages

### Category 2: Logged Only (8 instances)
Errors logged to console but not shown to users:
- Message decryption failures (App.tsx:147)
- JSON parse failures (signaling.ts:105, webrtc.ts:195)
- ICE candidate queue overflow (webrtc.ts:113)
- ICE candidate add failures (webrtc.ts:123)
- Data channel errors (webrtc.ts:158)
- Oversized data channel messages (webrtc.ts:139, 170)

### Category 3: Silent Failures (7 instances)
Errors that fail without any indication:
- Initialization failures in App.tsx (no try-catch around init)
- WebSocket send failures (returns false, not propagated)
- Adding pending ICE candidates in connect loop
- All send* methods in WebRTCService (silently skip if channel not open)

### Category 4: Thrown Errors (14 instances)
Errors thrown from crypto.ts that must be caught by callers:
- All "not initialized" checks
- All "no session" checks
- Invalid key format/length
- Replay attack detection

---

## Problem Analysis

### 1. Unhandled Promise Rejections
The `init()` function in App.tsx has no try-catch:
```typescript
useEffect(() => {
  const init = async () => {
    await cryptoService.initialize();  // Could fail
    // ... more async operations
  };
  init();  // No .catch()
}, []);
```

### 2. Silent Send Failures
WebRTC send methods silently fail when channel is not open:
```typescript
sendMessage(encryptedData: string): void {
  if (this.messageChannel?.readyState === 'open') {
    this.messageChannel.send(encryptedData);  // No error handling
  }
  // Silently does nothing if channel not open
}
```

### 3. Inconsistent Logging vs User Notification
Some errors use `console.error` only, while similar errors also notify users. For example:
- Oversized WebSocket message: logs AND notifies user
- Oversized data channel message: logs ONLY

### 4. Thrown Errors Without Catchers
crypto.ts throws errors that are not always caught:
```typescript
// In App.tsx onPairMatched callback:
cryptoService.establishSession(peerCode, peerPublicKey);  // No try-catch
```

---

## Proposed Error Handling Strategy

### 1. Error Classification System

Define three error severity levels:

| Level | Description | Action |
|-------|-------------|--------|
| **FATAL** | Cannot continue operation | Show error to user, reset state |
| **RECOVERABLE** | Operation failed but app continues | Show warning, log, attempt recovery |
| **INFORMATIONAL** | Minor issue, app unaffected | Log only (debug level) |

### 2. Centralized Error Handler

Create a new `ErrorService` module:

```typescript
// Proposed: packages/web-client/src/lib/errors.ts

export enum ErrorSeverity {
  FATAL = 'fatal',
  RECOVERABLE = 'recoverable',
  INFO = 'info'
}

export interface AppError {
  code: string;
  message: string;
  severity: ErrorSeverity;
  context?: Record<string, unknown>;
  originalError?: Error;
}

export type ErrorHandler = (error: AppError) => void;

class ErrorService {
  private handlers: ErrorHandler[] = [];

  subscribe(handler: ErrorHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  report(error: AppError): void {
    // Always log to console with appropriate level
    const logFn = error.severity === ErrorSeverity.FATAL
      ? console.error
      : error.severity === ErrorSeverity.RECOVERABLE
        ? console.warn
        : console.debug;

    logFn(`[${error.code}] ${error.message}`, error.context, error.originalError);

    // Notify handlers for FATAL and RECOVERABLE errors
    if (error.severity !== ErrorSeverity.INFO) {
      this.handlers.forEach(handler => handler(error));
    }
  }

  // Convenience methods
  fatal(code: string, message: string, context?: Record<string, unknown>, originalError?: Error): void {
    this.report({ code, message, severity: ErrorSeverity.FATAL, context, originalError });
  }

  recoverable(code: string, message: string, context?: Record<string, unknown>, originalError?: Error): void {
    this.report({ code, message, severity: ErrorSeverity.RECOVERABLE, context, originalError });
  }

  info(code: string, message: string, context?: Record<string, unknown>): void {
    this.report({ code, message, severity: ErrorSeverity.INFO, context });
  }
}

export const errorService = new ErrorService();
```

### 3. Error Code Registry

Define consistent error codes:

```typescript
// Proposed error codes
export const ErrorCodes = {
  // Crypto errors
  CRYPTO_NOT_INITIALIZED: 'CRYPTO_001',
  CRYPTO_INVALID_KEY: 'CRYPTO_002',
  CRYPTO_DECRYPTION_FAILED: 'CRYPTO_003',
  CRYPTO_REPLAY_DETECTED: 'CRYPTO_004',

  // Signaling errors
  SIGNALING_CONNECTION_FAILED: 'SIG_001',
  SIGNALING_MESSAGE_PARSE_ERROR: 'SIG_002',
  SIGNALING_SEND_FAILED: 'SIG_003',
  SIGNALING_INVALID_CODE: 'SIG_004',

  // WebRTC errors
  WEBRTC_ICE_FAILED: 'RTC_001',
  WEBRTC_CHANNEL_ERROR: 'RTC_002',
  WEBRTC_SEND_FAILED: 'RTC_003',
  WEBRTC_MESSAGE_TOO_LARGE: 'RTC_004',

  // File transfer errors
  FILE_TOO_LARGE: 'FILE_001',
  FILE_CHUNK_FAILED: 'FILE_002',
  FILE_INCOMPLETE: 'FILE_003',
} as const;
```

### 4. Recommended Changes by File

#### App.tsx
```typescript
// Wrap init in try-catch
useEffect(() => {
  const init = async () => {
    try {
      await cryptoService.initialize();
      // ... rest of initialization
    } catch (e) {
      errorService.fatal(
        ErrorCodes.CRYPTO_NOT_INITIALIZED,
        'Failed to initialize encryption',
        undefined,
        e as Error
      );
    }
  };
  init();
}, []);

// Subscribe to error service
useEffect(() => {
  return errorService.subscribe((error) => {
    if (error.severity === ErrorSeverity.FATAL ||
        error.severity === ErrorSeverity.RECOVERABLE) {
      setError(error.message);
    }
  });
}, []);
```

#### signaling.ts
```typescript
// Replace silent send failure
private send(message: ClientMessage): boolean {
  if (this.ws?.readyState === WebSocket.OPEN) {
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (e) {
      errorService.recoverable(
        ErrorCodes.SIGNALING_SEND_FAILED,
        'Failed to send message',
        { messageType: message.type },
        e as Error
      );
      return false;
    }
  }
  errorService.info(
    ErrorCodes.SIGNALING_SEND_FAILED,
    'WebSocket not connected',
    { messageType: message.type }
  );
  return false;
}
```

#### webrtc.ts
```typescript
// Add return value and error reporting to send methods
sendMessage(encryptedData: string): boolean {
  if (this.messageChannel?.readyState === 'open') {
    try {
      this.messageChannel.send(encryptedData);
      return true;
    } catch (e) {
      errorService.recoverable(
        ErrorCodes.WEBRTC_SEND_FAILED,
        'Failed to send message',
        undefined,
        e as Error
      );
      return false;
    }
  }
  errorService.info(
    ErrorCodes.WEBRTC_SEND_FAILED,
    'Message channel not open'
  );
  return false;
}
```

### 5. User-Facing Error Messages

Map error codes to user-friendly messages:

```typescript
export const UserMessages: Record<string, string> = {
  [ErrorCodes.CRYPTO_NOT_INITIALIZED]: 'Security initialization failed. Please refresh the page.',
  [ErrorCodes.CRYPTO_DECRYPTION_FAILED]: 'Could not decrypt message. The connection may be compromised.',
  [ErrorCodes.CRYPTO_REPLAY_DETECTED]: 'Security alert: Possible replay attack detected.',
  [ErrorCodes.SIGNALING_CONNECTION_FAILED]: 'Cannot connect to server. Please check your internet connection.',
  [ErrorCodes.WEBRTC_SEND_FAILED]: 'Message could not be sent. Please try again.',
  [ErrorCodes.FILE_TOO_LARGE]: 'File is too large to transfer (max 100MB).',
  // ... etc
};
```

---

## Implementation Priority

### Phase 1: Critical (Immediate)
1. Add try-catch around `init()` in App.tsx
2. Add try-catch around `cryptoService.establishSession()` call
3. Handle crypto thrown errors in `onMessage` callback (already done, verify)

### Phase 2: Important (Short-term)
1. Create ErrorService module
2. Add error reporting to all `send*` methods in webrtc.ts
3. Standardize error handling in signaling.ts

### Phase 3: Enhancement (Medium-term)
1. Add error code registry
2. Create user-friendly message mapping
3. Add error analytics/telemetry hooks

---

## Testing Recommendations

1. **Unit Tests**: Test each error path in crypto.ts, signaling.ts, webrtc.ts
2. **Integration Tests**: Test error propagation from service to UI
3. **E2E Tests**: Test user-visible error states
4. **Chaos Testing**: Simulate network failures, invalid data, oversized messages

---

## Conclusion

The current codebase has 37 identified error handling points with inconsistent strategies:
- 8 properly shown to users
- 8 logged only (should evaluate if user notification needed)
- 7 silent failures (highest priority to fix)
- 14 thrown errors (need consistent catching)

Implementing the proposed ErrorService and standardized error codes will provide:
1. Consistent error handling across all modules
2. Better debugging with structured error logging
3. Improved user experience with meaningful error messages
4. Foundation for future error analytics

---

## Research: How Other Apps Solve This

This section documents error handling patterns from major messaging applications and industry best practices.

---

### 1. Signal Desktop Error Handling

Signal Desktop is an Electron-based messaging app with robust error handling patterns.

**Source**: [Signal Desktop GitHub](https://github.com/signalapp/Signal-Desktop), [Signal Support - Debug Logs](https://support.signal.org/hc/en-us/articles/360007318591-Debug-Logs-and-Crash-Reports)

#### Error Type Hierarchy

Signal's libsignal library (Rust with TypeScript bindings) uses a rich error type system:

```typescript
// libsignal error pattern (conceptual TypeScript representation)
interface SignalError {
  name: string;           // Error class name
  message: string;        // Human-readable description
  operation?: string;     // What operation failed
  cause?: Error;          // Underlying error if wrapped
}

// Specific error types
class UntrustedIdentityKeyError extends Error {
  addr: string;           // Address of untrusted identity
}

class SealedSenderDecryptionError extends Error {
  // Decryption-specific context
}
```

#### Key Patterns

1. **Hierarchical Error Classes**: Base error with specific subtypes for crypto, network, protocol
2. **Error Downcasting**: Check specific error types for targeted handling:
   ```typescript
   match cipher.decrypt(&message).await {
       Ok(plaintext) => /* success */,
       Err(e) => match e.downcast_ref::<UntrustedIdentityKeyError>() {
           Some(identity_error) => /* handle identity issue */,
           None => /* generic error handling */,
       }
   }
   ```
3. **Crash Reporting Integration**: Signal collects debug logs and crash reports with user consent
4. **Logging Levels**: Structured logging with levels for debugging in production

#### Lessons for Zajel
- Use typed error classes instead of generic Error
- Implement error downcasting for specific handling paths
- Add opt-in crash reporting for production debugging

---

### 2. Telegram Error Handling

Telegram uses a comprehensive HTTP-like error code system with recovery strategies.

**Source**: [Telegram API Errors](https://core.telegram.org/api/errors)

#### Error Code Categories

| Code | Category | Description | Recovery Strategy |
|------|----------|-------------|-------------------|
| **303** | SEE_OTHER | Data center migration required | Redirect request to specified DC |
| **400** | BAD_REQUEST | Client-side input errors | Show validation message to user |
| **401** | UNAUTHORIZED | Authentication failures | Re-authenticate user |
| **403** | FORBIDDEN | Privacy/permission violations | Inform user, don't retry |
| **406** | NOT_ACCEPTABLE | Special handling required | Wait for `updateServiceNotification` |
| **420** | FLOOD | Rate limiting | Wait X seconds before retry |
| **500** | INTERNAL | Server errors | Retry with backoff |

#### Specific Error Patterns

```typescript
// Telegram-style error structure
interface TelegramError {
  error_code: number;      // HTTP-like status code
  error_message: string;   // Pattern: [A-Z_0-9]+ (e.g., "AUTH_KEY_UNREGISTERED")
  error_description?: string; // Human-readable description
}

// Recovery patterns
const handleTelegramError = (error: TelegramError) => {
  switch (error.error_code) {
    case 303:
      // Extract DC number from message (e.g., "PHONE_MIGRATE_5")
      const dc = extractDCNumber(error.error_message);
      return redirectToDC(dc);

    case 420:
      // Extract wait time (e.g., "FLOOD_WAIT_300")
      const waitSeconds = extractWaitTime(error.error_message);
      return scheduleRetry(waitSeconds);

    case 406:
      // Don't show error - wait for service notification
      return waitForServiceNotification();

    default:
      return showUserError(error);
  }
};
```

#### Key Innovations

1. **Structured Error Messages**: Machine-parseable format `[A-Z_0-9]+`
2. **Embedded Recovery Data**: Wait times and DC numbers in error message
3. **406 Pattern**: Deferred error display via push notifications
4. **Rate Limit Transparency**: Exact wait time provided

#### Lessons for Zajel
- Include recovery hints in error responses
- Use structured error codes (not just strings)
- Consider Premium bypass for rate limits (future feature)
- Implement automatic retry with backoff for transient errors

---

### 3. Matrix/Element SDK Error Handling

The Matrix JS SDK provides a comprehensive error handling approach for decentralized messaging.

**Source**: [Matrix JS SDK](https://github.com/matrix-org/matrix-js-sdk), [Matrix Web Docs](https://web-docs.element.dev/Matrix%20JS%20SDK/index.html)

#### Error Class Design

```typescript
// Matrix SDK error patterns
enum InvalidCryptoStoreState {
  TooNew = "TOO_NEW"
}

class InvalidCryptoStoreError extends Error {
  state: InvalidCryptoStoreState;

  constructor(reason: InvalidCryptoStoreState) {
    super(`Crypto store is invalid because ${reason}, ` +
          `please stop the client, delete all data and start the client again`);
    this.state = reason;
  }
}

class KeySignatureUploadError extends Error {
  value: unknown;  // Additional context data

  constructor(message: string, value: unknown) {
    super(message);
    this.value = value;
  }
}

class ClientStoppedError extends Error {
  constructor() {
    super("MatrixClient has been stopped");
  }
}
```

#### Built-in Recovery Mechanisms

The SDK handles common error scenarios automatically:
- **Failed message sending**: Messages marked as "not sent" with retry
- **Network errors**: Automatic retry with exponential backoff
- **Rate limiting**: Automatic wait and retry
- **AbortError handling**: Special handling to prevent infinite loops

#### Event-Based Error Propagation

```typescript
// Matrix uses EventEmitter pattern for error propagation
client.on('error', (error: MatrixError) => {
  console.error('Client error:', error);
  // Handle based on error type
});

room.on('Room.timeline', (event, room, toStartOfTimeline) => {
  if (event.status === EventStatus.NOT_SENT) {
    // Handle failed message
  }
});
```

#### Lessons for Zajel
- Use enum-based error states for machine-readable errors
- Store metadata as properties on error objects
- Implement EventEmitter pattern for error propagation
- Build automatic retry logic into the SDK layer

---

### 4. TypeScript Error Handling Patterns

Modern TypeScript applications use Result types and functional patterns for type-safe error handling.

**Sources**: [neverthrow](https://github.com/supermacro/neverthrow), [fp-ts Either](https://gcanti.github.io/fp-ts/modules/Either.ts.html), [Type-Safe Error Handling](https://dev.to/_gdelgado/type-safe-error-handling-in-typescript-1p4n)

#### Result Type Pattern (neverthrow)

```typescript
import { ok, err, Result, ResultAsync } from 'neverthrow';

// Define domain-specific error types
type CryptoError =
  | { type: 'NOT_INITIALIZED' }
  | { type: 'DECRYPTION_FAILED'; reason: string }
  | { type: 'REPLAY_DETECTED'; sequenceNumber: number };

type NetworkError =
  | { type: 'CONNECTION_FAILED'; url: string }
  | { type: 'TIMEOUT'; durationMs: number }
  | { type: 'RATE_LIMITED'; retryAfterMs: number };

// Function returning Result
function decrypt(data: string): Result<string, CryptoError> {
  if (!isInitialized) {
    return err({ type: 'NOT_INITIALIZED' });
  }

  try {
    const decrypted = performDecryption(data);
    return ok(decrypted);
  } catch (e) {
    return err({ type: 'DECRYPTION_FAILED', reason: e.message });
  }
}

// Chaining Results
const result = decrypt(encryptedMessage)
  .andThen(verifySignature)
  .andThen(parseMessage)
  .mapErr(error => ({
    ...error,
    timestamp: Date.now(),
  }));

// Pattern matching on result
result.match(
  (message) => displayMessage(message),
  (error) => {
    switch (error.type) {
      case 'NOT_INITIALIZED':
        return showFatalError('Encryption not ready');
      case 'DECRYPTION_FAILED':
        return showWarning('Could not decrypt message');
      case 'REPLAY_DETECTED':
        return showSecurityAlert('Possible replay attack');
    }
  }
);
```

#### Async Result Pattern (ResultAsync)

```typescript
// Wrap async operations
const sendMessage = (msg: string): ResultAsync<void, NetworkError> =>
  ResultAsync.fromPromise(
    webrtc.send(msg),
    (e) => ({ type: 'CONNECTION_FAILED', url: 'webrtc' })
  );

// Chain async operations
const result = await validateMessage(msg)
  .asyncAndThen(encryptMessage)
  .andThen(sendMessage);
```

#### Combining Multiple Results

```typescript
// Combine multiple results (all must succeed)
const combined = Result.combine([
  initializeCrypto(),
  connectSignaling(),
  setupWebRTC(),
]);

combined.match(
  ([crypto, signaling, webrtc]) => startApp(crypto, signaling, webrtc),
  (error) => showInitializationError(error)
);
```

#### fp-ts Either Pattern

```typescript
import { Either, left, right, fold } from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

type AppError = { code: string; message: string };

const processMessage = (data: unknown): Either<AppError, Message> =>
  pipe(
    validateInput(data),
    E.chain(decryptContent),
    E.chain(parseMessage),
    E.mapLeft(enrichError)
  );

// Fold to handle both cases
pipe(
  processMessage(rawData),
  fold(
    (error) => handleError(error),
    (message) => displayMessage(message)
  )
);
```

#### Lessons for Zajel
- Consider adopting neverthrow for type-safe error handling
- Define discriminated union types for error categories
- Use Result.combine for initialization flows
- Chain operations with andThen for cleaner error propagation

---

### 5. Dart/Flutter Error Handling

Flutter provides official guidance on error handling with the Result pattern.

**Sources**: [Flutter Result Pattern](https://docs.flutter.dev/app-architecture/design-patterns/result), [Flutter Error Handling](https://docs.flutter.dev/testing/errors), [Firebase Crashlytics](https://firebase.flutter.dev/docs/crashlytics/overview/)

#### Sealed Class Result Pattern

```dart
// Dart 3 sealed class implementation
sealed class Result<T> {
  const Result();

  const factory Result.ok(T value) = Ok._;
  const factory Result.error(Exception error) = Error._;
}

final class Ok<T> extends Result<T> {
  const Ok._(this.value);
  final T value;
}

final class Error<T> extends Result<T> {
  const Error._(this.error);
  final Exception error;
}

// Usage with pattern matching
Future<void> loadUserProfile() async {
  final result = await repository.getUserProfile();

  switch (result) {
    case Ok<UserProfile>():
      state = ProfileLoaded(result.value);
    case Error<UserProfile>():
      state = ProfileError(result.error);
  }
}
```

#### Global Error Handlers

```dart
void main() {
  // Catch Flutter framework errors
  FlutterError.onError = (details) {
    FlutterError.presentError(details);
    FirebaseCrashlytics.instance.recordFlutterError(details);
  };

  // Catch platform/async errors
  PlatformDispatcher.instance.onError = (error, stack) {
    FirebaseCrashlytics.instance.recordError(error, stack, fatal: true);
    return true;
  };

  runApp(MyApp());
}
```

#### Crashlytics Integration Best Practices

```dart
// Add breadcrumbs for context
FirebaseCrashlytics.instance.log('User clicked send button');

// Record non-fatal errors
try {
  await decryptMessage(data);
} catch (e, stack) {
  FirebaseCrashlytics.instance.recordError(
    e,
    stack,
    reason: 'Decryption failed',
    fatal: false,
  );
  // Show user-friendly message
  showSnackBar('Could not decrypt message');
}

// Add custom keys for debugging
FirebaseCrashlytics.instance.setCustomKey('connection_type', 'webrtc');
FirebaseCrashlytics.instance.setCustomKey('peer_id', peerId);
```

#### Lessons for Zajel
- Implement global error handlers at app entry point
- Use breadcrumbs to track user actions before errors
- Distinguish fatal vs non-fatal errors in crash reporting
- Add custom keys for debugging context

---

### 6. Secure Logging Best Practices

OWASP provides comprehensive guidance on logging without exposing sensitive data.

**Source**: [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)

#### Data That MUST NOT Be Logged

| Category | Examples |
|----------|----------|
| **Authentication** | Passwords, API keys, tokens, session IDs |
| **Cryptographic** | Encryption keys, private keys, key material |
| **Personal (PII)** | SSN, health records, financial data |
| **Application Secrets** | Database connection strings, internal IPs |
| **Business Sensitive** | Proprietary algorithms, trade secrets |

#### Data That SHOULD Be Logged

| Category | Examples |
|----------|----------|
| **Authentication Events** | Login success/failure (without credentials) |
| **Authorization Events** | Access denied, privilege changes |
| **Input Validation** | Rejected inputs (sanitized) |
| **Security Events** | Encryption activities, key rotations |
| **Errors** | Stack traces (without sensitive context) |

#### Safe Logging Pattern

```typescript
// Bad - exposes sensitive data
console.error('Decryption failed for message:', messageContent);
console.error('Session key:', sessionKey);

// Good - logs safely
console.error('Decryption failed', {
  errorCode: 'CRYPTO_003',
  messageId: hashId(messageId),      // Hash instead of raw ID
  peerFingerprint: peerFingerprint,  // Public info only
  timestamp: Date.now(),
});

// Utility for safe logging
const safeLog = (level: string, code: string, context: object) => {
  const sanitized = Object.entries(context).reduce((acc, [key, value]) => {
    if (SENSITIVE_KEYS.includes(key)) {
      return { ...acc, [key]: '[REDACTED]' };
    }
    return { ...acc, [key]: value };
  }, {});

  console[level]({ code, ...sanitized, timestamp: Date.now() });
};
```

#### Recommended Log Format

```typescript
interface SecureLogEntry {
  timestamp: string;      // ISO 8601 format
  level: 'error' | 'warn' | 'info' | 'debug';
  code: string;           // Structured error code
  message: string;        // User-safe message
  context: {
    sessionId?: string;   // Hashed, not raw
    operation?: string;   // What was attempted
    component?: string;   // Where it happened
  };
  // Never include: keys, tokens, message content, credentials
}
```

---

### 7. Graceful Degradation Patterns

Messaging apps must handle partial failures gracefully.

**Sources**: [AWS Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_graceful_degradation.html), [Graceful Degradation Patterns](https://dev.to/lovestaco/graceful-degradation-keeping-your-app-functional-when-things-go-south-jgj)

#### Fallback Chain Pattern

```typescript
// Try primary, fall back to alternatives
const sendMessage = async (message: string): Promise<Result<void, SendError>> => {
  // Try WebRTC first
  const webrtcResult = await sendViaWebRTC(message);
  if (webrtcResult.isOk()) return webrtcResult;

  // Fall back to signaling relay
  if (webrtcResult.error.type === 'CHANNEL_CLOSED') {
    const relayResult = await sendViaSignaling(message);
    if (relayResult.isOk()) return relayResult;
  }

  // Queue for later if offline
  if (isOffline()) {
    await queueForLater(message);
    return ok(undefined); // Optimistic success
  }

  return webrtcResult;
};
```

#### Circuit Breaker Pattern

```typescript
class CircuitBreaker {
  private failures = 0;
  private lastFailure?: number;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold: number = 5,
    private resetTimeout: number = 30000
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<Result<T, CircuitError>> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure! > this.resetTimeout) {
        this.state = 'half-open';
      } else {
        return err({ type: 'CIRCUIT_OPEN' });
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return ok(result);
    } catch (e) {
      this.onFailure();
      return err({ type: 'OPERATION_FAILED', cause: e });
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
}
```

#### Offline State Management

```typescript
interface OfflineCapableService {
  // Check connection status
  isOnline(): boolean;

  // Queue operations for when back online
  queueOperation(op: QueuedOperation): void;

  // Replay queued operations
  replayQueue(): Promise<Result<void, ReplayError>[]>;

  // Handle reconnection
  onReconnect(callback: () => void): void;
}

// Usage
const messageService: OfflineCapableService = {
  sendMessage: async (msg) => {
    if (!this.isOnline()) {
      this.queueOperation({ type: 'SEND_MESSAGE', data: msg });
      return ok({ queued: true });
    }
    return await this.sendImmediate(msg);
  },

  onReconnect: () => {
    this.replayQueue();
  }
};
```

---

### 8. Crash Reporting Setup

Modern crash reporting integrates error tracking, performance monitoring, and user session replay.

**Sources**: [Sentry React Docs](https://docs.sentry.io/platforms/javascript/guides/react/), [Firebase Crashlytics](https://firebase.flutter.dev/docs/crashlytics/usage/)

#### Sentry Configuration for React

```typescript
// sentry.config.ts
import * as Sentry from '@sentry/react';

Sentry.init({
  dsn: process.env.VITE_SENTRY_DSN,

  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration(),
  ],

  // Performance monitoring
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // Session replay for debugging
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  // Environment and release tracking
  environment: process.env.NODE_ENV,
  release: `zajel@${process.env.npm_package_version}`,

  // Filter noisy errors
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'Network request failed',
  ],

  // Scrub sensitive data
  beforeSend(event) {
    // Remove any accidental PII
    if (event.request?.data) {
      event.request.data = '[REDACTED]';
    }
    return event;
  },
});
```

#### Error Boundary with Sentry

```typescript
import { ErrorBoundary } from '@sentry/react';

function App() {
  return (
    <ErrorBoundary
      fallback={<CrashFallback />}
      onError={(error, componentStack) => {
        Sentry.captureException(error, {
          contexts: { react: { componentStack } },
          tags: {
            component: 'App',
            userAction: 'unknown',
          },
        });
      }}
    >
      <MainContent />
    </ErrorBoundary>
  );
}
```

#### Breadcrumbs for Context

```typescript
// Track user actions for debugging
const sendMessage = async (text: string) => {
  Sentry.addBreadcrumb({
    category: 'message',
    message: 'User sent message',
    level: 'info',
    data: { messageLength: text.length },
  });

  try {
    await messageService.send(text);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { action: 'send_message' },
      extra: {
        connectionState: webrtc.connectionState,
        channelState: webrtc.channelState,
      },
    });
    throw error;
  }
};
```

---

### Summary: Recommended Patterns for Zajel

Based on this research, here are the key patterns to implement:

#### 1. Error Type System
```typescript
// Structured error types with codes
type ZajelError =
  | CryptoError
  | SignalingError
  | WebRTCError
  | FileTransferError;

interface BaseError {
  code: string;        // Machine-readable code
  message: string;     // User-friendly message
  severity: 'fatal' | 'recoverable' | 'info';
  recoveryHint?: string;
  retryable: boolean;
  retryAfterMs?: number;
}
```

#### 2. Result Type Adoption
```typescript
// Use neverthrow for type-safe error handling
import { Result, ResultAsync } from 'neverthrow';

// All fallible operations return Result
function decrypt(data: string): Result<string, CryptoError>;
function send(message: string): ResultAsync<void, NetworkError>;
```

#### 3. Secure Logging
```typescript
// Never log sensitive data
const REDACTED_FIELDS = ['key', 'password', 'token', 'content'];
const safeLog = (entry: LogEntry) => sanitize(entry, REDACTED_FIELDS);
```

#### 4. Crash Reporting
```typescript
// Sentry integration with privacy-safe configuration
Sentry.init({
  beforeSend: scrubSensitiveData,
  ignoreErrors: NON_ACTIONABLE_ERRORS,
});
```

#### 5. Graceful Degradation
```typescript
// Circuit breaker + retry + fallback chain
const resilientSend = circuitBreaker.wrap(
  retryWithBackoff(sendViaWebRTC, 3),
  fallbackToSignaling
);
```

---

### References

- [Signal Desktop GitHub](https://github.com/signalapp/Signal-Desktop)
- [Signal Debug Logs Support](https://support.signal.org/hc/en-us/articles/360007318591-Debug-Logs-and-Crash-Reports)
- [libsignal Protocol Docs](https://docs.rs/libsignal-protocol/latest/libsignal_protocol/)
- [Telegram API Errors](https://core.telegram.org/api/errors)
- [Matrix JS SDK](https://github.com/matrix-org/matrix-js-sdk)
- [Matrix Web Docs](https://web-docs.element.dev/Matrix%20JS%20SDK/index.html)
- [neverthrow GitHub](https://github.com/supermacro/neverthrow)
- [fp-ts Either](https://gcanti.github.io/fp-ts/modules/Either.ts.html)
- [Flutter Result Pattern](https://docs.flutter.dev/app-architecture/design-patterns/result)
- [Flutter Error Handling](https://docs.flutter.dev/testing/errors)
- [Firebase Crashlytics](https://firebase.flutter.dev/docs/crashlytics/overview/)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [Sentry React Docs](https://docs.sentry.io/platforms/javascript/guides/react/)
- [AWS Graceful Degradation](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_graceful_degradation.html)
