# Issue #37: Error Swallowing

## Summary

Empty or minimal catch blocks throughout the web-client codebase hide failures, making debugging difficult and potentially masking serious issues. This document inventories all problematic error handling patterns and proposes proper fixes.

---

## Inventory of Empty/Minimal Catch Blocks

### Category 1: HIGH SEVERITY - Silent Failures with No Recovery

#### 1.1 SignalingClient.send() - Silent WebSocket Send Failures

**File**: `/home/meywd/zajel/packages/web-client/src/lib/signaling.ts`
**Lines**: 176-186

```typescript
private send(message: ClientMessage): boolean {
  if (this.ws?.readyState === WebSocket.OPEN) {
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
```

**Problem**: WebSocket send failures are silently swallowed. The caller receives `false` but has no information about what went wrong. Critical messages like `pair_request`, `offer`, `answer`, and `ice_candidate` could fail without any logging or user notification.

**Impact**:
- Connection attempts may silently fail
- Users have no idea why pairing doesn't work
- Debugging production issues is nearly impossible

**Proposed Fix**:
```typescript
private send(message: ClientMessage): boolean {
  if (this.ws?.readyState === WebSocket.OPEN) {
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`Failed to send ${message.type} message:`, error);
      // Notify error handler for critical message types
      if (['pair_request', 'pair_response', 'offer', 'answer'].includes(message.type)) {
        this.events.onError(`Failed to send ${message.type}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return false;
    }
  }
  return false;
}
```

---

#### 1.2 App.tsx onMessage - Silent Message Decryption Failures

**File**: `/home/meywd/zajel/packages/web-client/src/App.tsx`
**Lines**: 127-149

```typescript
onMessage: (encryptedData) => {
  try {
    const currentPeerCode = peerCodeRef.current;
    if (!currentPeerCode) return;
    const content = cryptoService.decrypt(currentPeerCode, encryptedData);
    // ... process message
  } catch (e) {
    console.error('Failed to decrypt message:', e);
  }
},
```

**Problem**: Decryption failures only log to console. The user never knows a message was lost. Could indicate:
- Replay attack (sequence number violation)
- Session key mismatch
- Corrupted data
- MITM attack attempt

**Impact**:
- Messages silently disappear
- Security attacks go unnoticed
- Users think messages were received when they weren't

**Proposed Fix**:
```typescript
onMessage: (encryptedData) => {
  try {
    const currentPeerCode = peerCodeRef.current;
    if (!currentPeerCode) return;
    const content = cryptoService.decrypt(currentPeerCode, encryptedData);
    // ... process message
  } catch (e) {
    console.error('Failed to decrypt message:', e);

    // Distinguish between security errors and general failures
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';
    if (errorMessage.includes('Replay attack')) {
      setError('Security alert: Possible replay attack detected. Message dropped.');
    } else {
      // Add a system message to the chat
      setMessages((prev) => {
        const systemMsg: ChatMessage = {
          id: crypto.randomUUID(),
          content: '[Message could not be decrypted]',
          sender: 'peer',
          timestamp: new Date(),
        };
        return [...prev, systemMsg];
      });
    }
  }
},
```

---

### Category 2: MEDIUM SEVERITY - Logged but Not Surfaced

#### 2.1 SignalingClient WebSocket Message Parsing

**File**: `/home/meywd/zajel/packages/web-client/src/lib/signaling.ts`
**Lines**: 88-107

```typescript
this.ws.onmessage = (event) => {
  try {
    // ... size check and parsing
    const message = JSON.parse(event.data) as ServerMessage;
    this.handleMessage(message);
  } catch (e) {
    console.error('Failed to parse message:', e);
  }
};
```

**Problem**: Invalid server messages are logged but not surfaced. Could indicate:
- Server bugs
- Protocol version mismatch
- Network corruption
- Attack attempts

**Impact**:
- Debugging requires console access
- Production issues are harder to diagnose

**Proposed Fix**:
```typescript
this.ws.onmessage = (event) => {
  try {
    // ... size check and parsing
    const message = JSON.parse(event.data) as ServerMessage;
    this.handleMessage(message);
  } catch (e) {
    console.error('Failed to parse message:', e);
    // Count consecutive parse failures
    this.parseFailures = (this.parseFailures || 0) + 1;
    if (this.parseFailures >= 3) {
      this.events.onError('Multiple malformed messages received. Connection may be corrupted.');
      this.parseFailures = 0;
    }
  }
};
```

---

#### 2.2 WebRTCService ICE Candidate Handling

**File**: `/home/meywd/zajel/packages/web-client/src/lib/webrtc.ts`
**Lines**: 120-125

```typescript
try {
  await this.pc.addIceCandidate(candidate);
} catch (e) {
  console.warn('Failed to add ICE candidate:', e);
}
```

**Problem**: ICE candidate failures are only warned. While some ICE failures are expected (e.g., candidates arriving before remote description), repeated failures could indicate connectivity issues.

**Impact**:
- Connection quality issues go unnoticed
- Network problems are harder to diagnose

**Proposed Fix**:
```typescript
try {
  await this.pc.addIceCandidate(candidate);
} catch (e) {
  console.warn('Failed to add ICE candidate:', e);
  this.iceCandidateFailures = (this.iceCandidateFailures || 0) + 1;
  // Only surface if we're getting many failures
  if (this.iceCandidateFailures >= 5 && this.pc?.connectionState !== 'connected') {
    console.error('Multiple ICE candidate failures may indicate connectivity issues');
  }
}
```

---

#### 2.3 WebRTCService File Channel Message Parsing

**File**: `/home/meywd/zajel/packages/web-client/src/lib/webrtc.ts`
**Lines**: 162-197

```typescript
channel.onmessage = (event) => {
  try {
    // ... size check and parsing
    const data = JSON.parse(event.data);
    switch (data.type) {
      // ... handle file messages
    }
  } catch (e) {
    console.error('Failed to parse file message:', e);
  }
};
```

**Problem**: File transfer protocol errors are logged but not propagated. Could cause:
- Incomplete file transfers without user notification
- Silent data corruption

**Impact**:
- Users may think transfers completed when they failed
- File corruption goes unnoticed

**Proposed Fix**:
```typescript
channel.onmessage = (event) => {
  try {
    // ... size check and parsing
    const data = JSON.parse(event.data);
    switch (data.type) {
      // ... handle file messages
    }
  } catch (e) {
    console.error('Failed to parse file message:', e);
    // Attempt to extract fileId from malformed message
    try {
      const partial = JSON.parse(event.data);
      if (partial.fileId) {
        this.events.onFileError(partial.fileId, 'Protocol error: malformed message');
      }
    } catch {
      // Can't recover fileId, log additional context
      console.error('Unrecoverable file message parse error, data length:', event.data?.length);
    }
  }
};
```

---

### Category 3: LOW SEVERITY - Intentional Silent Handling

#### 3.1 WebRTCService Message Channel JSON Parse

**File**: `/home/meywd/zajel/packages/web-client/src/lib/webrtc.ts`
**Lines**: 132-155

```typescript
channel.onmessage = (event) => {
  try {
    // ... size check
    const data = JSON.parse(event.data);
    if (data.type === 'handshake') {
      this.events.onHandshake(data.publicKey);
    } else {
      this.events.onMessage(event.data);
    }
  } catch {
    // Not JSON, treat as encrypted message
    this.events.onMessage(event.data);
  }
};
```

**Assessment**: This is **intentional** behavior. Messages that aren't valid JSON are assumed to be encrypted data and passed to the message handler. This is a valid design pattern for mixed-format channels.

**Recommendation**: Add a comment explaining the intentional design:
```typescript
} catch {
  // Intentionally silent: non-JSON data is expected for encrypted messages
  // The decrypt step will validate the message format
  this.events.onMessage(event.data);
}
```

---

#### 3.2 CryptoService Base64 Decoding

**File**: `/home/meywd/zajel/packages/web-client/src/lib/crypto.ts`
**Lines**: 84-90, 115-121

```typescript
try {
  peerPublicKey = Uint8Array.from(atob(peerPublicKeyBase64), (c) =>
    c.charCodeAt(0)
  );
} catch {
  throw new Error('Invalid peer public key: malformed base64');
}
```

**Assessment**: This is **proper** error handling. The catch block transforms a generic base64 decoding error into a domain-specific error message. The error is re-thrown with context, not swallowed.

**Status**: No changes needed.

---

### Category 4: MEDIUM-HIGH SEVERITY - Partial Recovery

#### 4.1 App.tsx File Chunk Decryption

**File**: `/home/meywd/zajel/packages/web-client/src/App.tsx`
**Lines**: 180-211

```typescript
try {
  const decrypted = cryptoService.decrypt(currentPeerCode, encryptedData);
  const bytes = Uint8Array.from(atob(decrypted), (c) => c.charCodeAt(0));
  data[chunkIndex] = bytes;
  return {
    ...t,
    receivedChunks: t.receivedChunks + 1,
    data,
  };
} catch (e) {
  console.error('Failed to decrypt chunk:', e);
  // Mark transfer as failed and notify peer
  webrtcRef.current?.sendFileError(fileId, 'Chunk decryption failed');
  return {
    ...t,
    status: 'failed',
    error: `Failed to decrypt chunk ${chunkIndex + 1}`,
  };
}
```

**Assessment**: This is **partially good** error handling. The error is logged, the transfer is marked as failed, and the peer is notified. However, the specific error type is not preserved.

**Recommendation**: Include the error type in the failure message:
```typescript
} catch (e) {
  console.error('Failed to decrypt chunk:', e);
  const errorMsg = e instanceof Error ? e.message : 'Decryption failed';
  const userMessage = errorMsg.includes('Replay attack')
    ? 'Security error: replay attack detected'
    : `Failed to decrypt chunk ${chunkIndex + 1}`;

  webrtcRef.current?.sendFileError(fileId, userMessage);
  return {
    ...t,
    status: 'failed',
    error: userMessage,
  };
}
```

---

## Summary Table

| Location | Severity | Current Behavior | Issue | Fix Priority |
|----------|----------|------------------|-------|--------------|
| signaling.ts:181 | HIGH | Silent return false | Send failures invisible | P1 |
| App.tsx:146 | HIGH | Console.error only | Messages silently lost | P1 |
| signaling.ts:104 | MEDIUM | Console.error only | Parse failures hidden | P2 |
| webrtc.ts:122 | MEDIUM | Console.warn only | ICE issues hidden | P2 |
| webrtc.ts:194 | MEDIUM | Console.error only | File protocol errors hidden | P2 |
| App.tsx:200 | MEDIUM | Partial recovery | Error type lost | P3 |
| webrtc.ts:151 | LOW | Intentional fallback | N/A (correct behavior) | None |
| crypto.ts:88,119 | LOW | Error re-thrown | N/A (correct behavior) | None |

---

## Implementation Recommendations

### Phase 1: Critical Fixes (P1)

1. **Add error propagation to SignalingClient.send()**
   - Log errors with message type context
   - Surface critical failures to user via `onError` callback

2. **Surface decryption failures in App.tsx**
   - Distinguish security errors from general failures
   - Show user-visible indication when messages can't be decrypted

### Phase 2: Observability Improvements (P2)

1. **Add failure counters for repeated errors**
   - Track consecutive parse failures in signaling
   - Track ICE candidate failure patterns

2. **Improve file protocol error handling**
   - Attempt to extract fileId from malformed messages
   - Surface protocol errors as file transfer failures

### Phase 3: Polish (P3)

1. **Preserve error context in file chunk failures**
   - Include specific error types in user-facing messages
   - Differentiate security errors from data corruption

### Phase 4: Documentation

1. **Add comments to intentional silent catches**
   - webrtc.ts line 151: Document mixed-format channel design

---

## Testing Considerations

After implementing fixes, test the following scenarios:

1. **WebSocket failures**: Disconnect network during send, verify error surfaces
2. **Malformed messages**: Send invalid JSON, verify user notification after threshold
3. **Decryption failures**: Corrupt encrypted data, verify user sees indication
4. **ICE failures**: Test restricted network, verify warnings appear
5. **File transfer corruption**: Corrupt chunk data, verify transfer fails gracefully

---

## References

- PR Review Issue #37
- Related: Issue #12 (Callback Race Conditions)
- Related: Issue #19 (Null Assertions)

---

## Research: How Other Apps Solve This

This section documents error handling strategies from Signal, Telegram, and industry best practices for error tracking, functional error handling patterns, and when silent failure is acceptable.

### 1. Signal: Error Logging and Reporting Strategies

Signal takes a privacy-first approach to logging while still maintaining the ability to diagnose issues.

#### Debug Logging Architecture
- Signal creates debug log files in the app's `Library/Caches/Logs` folder with timestamps for each session
- Logs are stripped of personal information before submission - only the last two digits of phone numbers are visible (e.g., `+*********09`) to help differentiate contacts
- The `Logger` class provides structured logging with levels like `Logger.info()`, `Logger.warn()`, `Logger.error()`
- Log files use `NSFileProtectionCompleteUntilFirstUserAuthentication` data protection class

#### Privacy-Conscious Error Reporting
- Signal servers do not keep logs about who called whom and when
- The only metadata stored is the last connection time, reduced to day precision (not hour/minute/second)
- Users can voluntarily submit debug logs for troubleshooting via the app's Help menu
- Raw `adb` logs may expose private information - Signal warns users to review before sharing

**Key Takeaway**: Signal demonstrates that you can have detailed error logging for debugging while still respecting user privacy by stripping sensitive data before it's logged.

**Sources**:
- [Signal Debug Logs and Crash Reports](https://support.signal.org/hc/en-us/articles/360007318591-Debug-Logs-and-Crash-Reports)
- [Signal-Android GitHub Repository](https://github.com/signalapp/Signal-Android)

---

### 2. Telegram: How They Surface Errors to Users

Telegram's [official API error handling documentation](https://core.telegram.org/api/errors) provides a structured approach to error classification.

#### Error Structure
Every Telegram API error includes:
1. **Error Code**: Numerical HTTP-like status code
2. **Error Type**: String literal matching `/[A-Z_0-9]+/` (e.g., `AUTH_KEY_UNREGISTERED`)
3. **Error Description**: Human-readable explanation

#### Error Categories and Recovery Strategies

| Code | Category | Handling Strategy |
|------|----------|-------------------|
| 303 | SEE_OTHER | Redirect to different data center (e.g., `FILE_MIGRATE_X`) |
| 400 | BAD_REQUEST | User-provided data validation failed - show error to user |
| 401 | UNAUTHORIZED | Session invalidated - require re-authentication |
| 403 | FORBIDDEN | Privacy violation - inform user of restriction |
| 404 | NOT_FOUND | Object/method doesn't exist - show appropriate message |
| 406 | NOT_ACCEPTABLE | Display via `updateServiceNotification` popup |
| 420 | FLOOD | Rate limit exceeded - wait X seconds or suggest Premium |
| 500 | INTERNAL | Server error - collect info and report to developers |

#### Special Error Handling
- `AUTH_KEY_DUPLICATED`: Indicates parallel connections from same session on different TCP connections - requires new auth key and re-login
- `FLOOD_WAIT_%d`: Contains printf placeholder indicating wait duration in seconds
- 500 errors: Telegram explicitly recommends collecting as much information as possible about the query and reporting to developers

**Key Takeaway**: Telegram uses structured, machine-parsable error codes with clear recovery actions. They don't silently swallow errors - each error type has a defined user-facing response.

**Sources**:
- [Telegram API Error Handling](https://core.telegram.org/api/errors)
- [gotd/td Go Implementation](https://github.com/gotd/td)

---

### 3. Sentry/Crashlytics: Error Tracking Best Practices

#### Key Differences Between Tools

| Feature | Sentry | Crashlytics |
|---------|--------|-------------|
| Platform Support | 30+ languages, web/mobile/IoT | iOS, Android, Flutter, Unity |
| Tracking Scope | Crashes, exceptions, logs, performance | Primarily crash reporting |
| Alerting | Slack, PagerDuty, email, webhooks | Email alerts only |
| Context | Breadcrumbs, device data, stack traces | Basic crash info |

#### Essential Practices from Sentry

1. **Breadcrumbs**: Capture a trail of events leading up to an error - critical for understanding user journey before crash

2. **Custom Alerts**: Configure alerts based on:
   - New error types (never seen before)
   - Error rate thresholds
   - Specific error patterns

3. **Source Maps**: Enable unminified stack traces for React/React Native apps

4. **Sample Rate Control**: Use `tracesSampleRate: 1.0` in development (100% of transactions), lower in production

5. **Performance Monitoring**: Track latency and throughput alongside errors

#### Mobile-Specific Considerations

- **Offline storage**: Store crash reports locally and send when connectivity is restored
- **Version tracking**: Distinguish crash rates between app versions - old versions may still be in use
- **Device context**: Capture model, OS version, memory usage, battery state

**Key Takeaway**: Error monitoring should be proactive (alerts before users complain), contextual (breadcrumbs showing what happened before the error), and prioritized (group similar issues, rank by impact).

**Sources**:
- [Sentry vs Crashlytics Comparison 2025](https://uxcam.com/blog/sentry-vs-crashlytics/)
- [Sentry Mobile Solutions](https://sentry.io/solutions/mobile-developers/)
- [Firebase Crashlytics vs Sentry](https://www.zipy.ai/blog/firebase-crashlytics-vs-sentry)

---

### 4. TypeScript/Dart Patterns: Forced Error Handling

The problem with traditional `try/catch` in TypeScript is that the compiler doesn't track which functions can throw - errors are only discoverable through documentation or runtime testing.

#### The Result/Either Pattern

Instead of throwing exceptions, functions return a type that explicitly represents success or failure:

```typescript
type Result<T, E> = Ok<T> | Err<E>;
```

This forces callers to handle both cases at compile time.

#### neverthrow (TypeScript)

```typescript
import { ok, err, Result } from 'neverthrow';

const divide = (n: number, d: number): Result<number, string> =>
  d === 0 ? err('Division by zero') : ok(n / d);

// Compiler forces you to handle both cases
const result = divide(10, 0)
  .map(val => val * 2)           // Only runs on success
  .mapErr(e => `Error: ${e}`)    // Only runs on failure
  .unwrapOr(0);                  // Extract with default
```

**ESLint Integration**: The `eslint-plugin-neverthrow` enforces that Results must be consumed - you cannot accidentally ignore an error.

#### fpdart (Dart/Flutter)

```dart
Either<FormatException, double> parseNumber(String value) {
  try {
    return Either.right(double.parse(value));
  } on FormatException catch (e) {
    return Either.left(e);
  }
}

// Compiler error if you don't handle both cases
final result = parseNumber("invalid")
  .map((value) => value * 2)
  .fold(
    (error) => "Parse failed: $error",
    (value) => "Result: $value"
  );
```

#### Effect-TS vs neverthrow

| Aspect | neverthrow | Effect-TS |
|--------|------------|-----------|
| Complexity | Low - just Result type | High - full functional framework |
| Learning Curve | Minimal paradigm shift | Requires FP knowledge |
| Use Case | Library APIs, error-prone functions | Large-scale systems |
| Team Fit | Mixed FP familiarity | Full FP commitment |

**Key Takeaway**: Result types make errors part of the type system, preventing silent swallowing. Choose neverthrow for gradual adoption, Effect-TS for comprehensive functional programming.

**Sources**:
- [neverthrow GitHub](https://github.com/supermacro/neverthrow)
- [Error Handling in TypeScript: Neverthrow, Try-Catch, and EffectTS](https://devalade.me/blog/error-handling-in-typescript-neverthrow-try-catch-and-alternative-like-effec-ts.mdx)
- [Functional Error Handling with Either and fpdart](https://codewithandrea.com/articles/functional-error-handling-either-fpdart/)
- [Effect vs neverthrow Documentation](https://effect.website/docs/additional-resources/effect-vs-neverthrow/)

---

### 5. When Silent Failure IS Acceptable

The general rule is: **Failing silently is not an option** - it causes debugging nightmares and user confusion.

However, there is a legitimate pattern called **Fail-Silent** used in specific contexts:

#### Acceptable Silent Failure Scenarios

1. **Safety-Critical Systems**: When incorrect data is more dangerous than no data
   - Medical monitoring: Better to stop reporting than show false heart rate
   - Aviation: Airspeed indicators go silent on internal faults rather than mislead pilots
   - Air traffic control: Missing data is safer than wrong data

2. **Intentional Fallback Behavior**: When non-error paths handle the "failure"
   - Example from zajel: JSON parse failure in mixed-format channel - non-JSON data is valid encrypted content
   - Key: The "catch" path is actually a valid execution path, not an error

3. **Optional Enhancements**: Features that shouldn't break core functionality
   - Analytics tracking failures
   - Non-critical UI animations
   - Prefetch optimizations

#### The Fail-Silent Decision Framework

Ask: **Is it safer to stop completely, or continue in degraded mode?**

| Scenario | Recommendation |
|----------|----------------|
| Incorrect data could harm users | Fail-Silent (stop) |
| Feature is optional/non-critical | Fail-Silent with logging |
| Data loss is unacceptable | Fail-Loud (surface error) |
| User action required for recovery | Fail-Loud (notify user) |

**Key Takeaway**: Silent failure is a deliberate design choice for safety-critical systems, not a shortcut for avoiding error handling. In typical applications, always log, often notify.

**Sources**:
- [How to Handle Errors with Grace (freeCodeCamp)](https://www.freecodecamp.org/news/how-to-handle-errors-with-grace-failing-silently-is-not-an-option-de6ce8f897d7/)
- [Fail-Silent and Fail-Operational Patterns Explained](https://medium.com/@jusuftopic/designing-for-the-inevitable-fail-silent-and-fail-operational-patterns-explained-621db0232070)
- [Error Handling in Distributed Systems (Temporal)](https://temporal.io/blog/error-handling-in-distributed-systems)

---

### 6. Structured Logging Patterns

#### Essential Fields for Every Log Entry

```json
{
  "timestamp": "2025-01-11T10:30:00.000Z",
  "level": "ERROR",
  "service": "web-client",
  "correlation_id": "abc-123-def",
  "message": "Failed to decrypt message",
  "error": {
    "type": "DecryptionError",
    "message": "Invalid sequence number",
    "stack": "..."
  },
  "context": {
    "peer_code": "****5309",
    "message_type": "chat"
  }
}
```

#### Log Level Guidelines

| Level | When to Use | Example |
|-------|-------------|---------|
| ERROR | Operation failed, requires attention | Decryption failure, WebSocket disconnect |
| WARN | Potential issue, system recovered | ICE candidate failure (some expected) |
| INFO | Normal operation milestones | Connection established, file transfer complete |
| DEBUG | Detailed troubleshooting info | Message parsing details, state transitions |

#### Correlation IDs for Distributed Tracing

Generate a correlation ID at the entry point (e.g., when user initiates pairing) and propagate it through all related operations:

```typescript
const correlationId = crypto.randomUUID();
logger.info('Pairing initiated', { correlationId, peerCode: '****5309' });
// Pass correlationId to signaling, WebRTC, crypto operations
```

#### Error Escalation Pattern

```typescript
class ErrorTracker {
  private consecutiveFailures = 0;
  private readonly threshold = 3;

  recordFailure(error: Error): void {
    this.consecutiveFailures++;
    console.warn('Operation failed', { error, count: this.consecutiveFailures });

    if (this.consecutiveFailures >= this.threshold) {
      this.escalate(error);
      this.consecutiveFailures = 0;
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  private escalate(error: Error): void {
    // Surface to user, send to monitoring service, etc.
    console.error('Multiple consecutive failures', { error });
    this.onError?.(`Connection issues detected: ${error.message}`);
  }
}
```

**Sources**:
- [Structured Logging - A Developer's Guide (SigNoz)](https://signoz.io/blog/structured-logs/)
- [Logging Best Practices: 12 Dos and Don'ts (Better Stack)](https://betterstack.com/community/guides/logging/logging-best-practices/)
- [Why Structured Logging is Fundamental to Observability](https://betterstack.com/community/guides/logging/structured-logging/)

---

### 7. React Error Boundaries

React Error Boundaries provide a standardized way to catch rendering errors and display fallback UI.

#### Key Concepts

```typescript
class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Log to error reporting service
    logErrorToService(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return <FallbackUI error={this.state.error} />;
    }
    return this.props.children;
  }
}
```

#### Best Practices

1. **Granular boundaries**: Wrap individual features, not just the app root
   - Sidebar, info panel, message log, input field - each in separate boundary
   - One component crash doesn't take down the entire app

2. **Integration with monitoring**: Use `componentDidCatch` to send errors to Sentry/similar

3. **Use react-error-boundary library**: Provides hooks API and retry mechanisms

#### Limitations
Error boundaries do NOT catch:
- Event handler errors (use try/catch)
- Async code (setTimeout, API calls)
- Server-side rendering errors
- Errors in the boundary itself

**Sources**:
- [React Error Boundaries Documentation](https://legacy.reactjs.org/docs/error-boundaries.html)
- [React Error Handling with react-error-boundary (LogRocket)](https://blog.logrocket.com/react-error-handling-react-error-boundary/)
- [Use react-error-boundary (Kent C. Dodds)](https://kentcdodds.com/blog/use-react-error-boundary-to-handle-errors-in-react)

---

### 8. Monitoring and Alerting Best Practices

#### Alert Configuration Recommendations

1. **New Error Types**: Alert immediately when a never-seen-before error occurs
2. **Error Rate Spikes**: Alert when error rate exceeds baseline by X%
3. **Crash-Free Rate Drop**: Alert when crash-free sessions drops below threshold
4. **Version Comparison**: Alert when new version has higher error rate than previous

#### Notification Channels

- **Slack/Teams Integration**: Real-time visibility for the team
- **PagerDuty/Opsgenie**: On-call escalation for critical issues
- **Email Digests**: Daily/weekly summaries for non-urgent patterns

#### Dashboard Essentials

- 30,000-foot view: Are errors trending up or down?
- Per-version breakdown: Which versions are problematic?
- User impact: How many users affected by each error?
- Time-based patterns: Do errors cluster at specific times?

#### Prioritization Framework

Not all errors deserve equal attention:

| Factor | Weight |
|--------|--------|
| User impact (how many affected) | High |
| Frequency (how often occurs) | High |
| Severity (crash vs warning) | Medium |
| Recoverability (can user retry) | Medium |
| Business impact (core vs optional feature) | High |

**Sources**:
- [The Complete Guide to Error Monitoring and Crash Reporting (Raygun)](https://raygun.com/learn/the-complete-guide-to-error-monitoring-and-crash-reporting)
- [Mobile App Error Handling Guide (Dogtown Media)](https://www.dogtownmedia.com/how-to-implement-effective-error-handling-and-crash-reporting-in-your-mobile-app/)
- [Top 10 Mobile App Crash Reporting Tools 2025 (UXCam)](https://uxcam.com/blog/mobile-app-crash-reporting-tools/)

---

### 9. Summary: Alternatives to Empty Catch Blocks

| Current Pattern | Better Alternative |
|-----------------|-------------------|
| `catch { }` (empty) | Log with context, consider escalation |
| `catch { return false }` | Log, return Result type, or callback with error |
| `catch { console.log() }` | Structured logging with levels, consider user notification |
| `catch { /* expected */ }` | Add explicit comment explaining why silent is correct |

#### Decision Tree for Error Handling

```
Error Occurs
    |
    v
Is this an expected/valid code path?
    |
    +-- Yes --> Handle gracefully, maybe log at DEBUG level
    |           Add comment explaining the design
    |
    +-- No --> Is user action required to recover?
                  |
                  +-- Yes --> Surface to user (toast, inline error, etc.)
                  |
                  +-- No --> Can system recover automatically?
                              |
                              +-- Yes --> Log at WARN, implement retry/fallback
                              |
                              +-- No --> Log at ERROR, alert monitoring
```

---

### 10. Recommendations for zajel

Based on this research, here are specific recommendations:

1. **Adopt Structured Logging**: Create a logging utility that adds correlation IDs, timestamps, and structured context

2. **Consider neverthrow for Critical Paths**: WebSocket sends, decryption, and file transfers could benefit from Result types

3. **Implement Error Escalation**: Track consecutive failures and surface to users when threshold exceeded

4. **Add React Error Boundaries**: Wrap ChatWindow, FileTransfer, and other major components

5. **Document Intentional Silent Catches**: Add explicit comments for valid use cases like the mixed-format channel

6. **Integrate Error Monitoring**: Consider Sentry for production error tracking with source maps

7. **Create Error Notification Patterns**: Standardize how errors are shown to users (toast, inline, modal based on severity)

---

## Implementation Status

### Completed Fixes (2026-01-11)

#### Web Client (TypeScript)

1. **SignalingClient.send()** - `/packages/web-client/src/lib/signaling.ts`
   - Added error logging with message type context
   - Critical message types (pair_request, pair_response, offer, answer) now surface errors via onError callback

2. **App.tsx message decryption** - `/packages/web-client/src/App.tsx`
   - Now distinguishes security errors (replay attacks) from general decryption failures
   - Shows user-visible indication when messages cannot be decrypted
   - File chunk decryption preserves error context for security-related failures

3. **validation.ts safeJsonParse** - `/packages/web-client/src/lib/validation.ts`
   - Added explicit comment documenting intentional silent catch (design pattern)

#### Server VPS (TypeScript)

4. **ClientHandler public key validation** - `/packages/server-vps/src/client/handler.ts`
   - Base64 decoding errors now logged before sending error response to client

5. **ClientHandler shutdown** - `/packages/server-vps/src/client/handler.ts`
   - Added explicit documentation for intentional silent catches during shutdown

6. **SQLite storage stats** - `/packages/server-vps/src/storage/sqlite.ts`
   - Added explicit documentation for optional file stats operation

7. **Gossip protocol signature verification** - `/packages/server-vps/src/federation/gossip/protocol.ts`
   - Added debug logging for signature verification failures

8. **Server identity verify functions** - `/packages/server-vps/src/identity/server-identity.ts`
   - Added explicit documentation explaining cryptographic API design (return false vs throw)

9. **Server connection handshake verification** - `/packages/server-vps/src/federation/transport/server-connection.ts`
   - Added explicit documentation for verification failure handling

#### Flutter App (Dart)

10. **HomeScreen cancel connection** - `/packages/app/lib/features/home/home_screen.dart`
    - Added documentation explaining best-effort operation pattern

11. **SignalingClient message parsing** - `/packages/app/lib/core/network/signaling_client.dart`
    - Added debugPrint for malformed message detection (non-fatal, connection continues)
    - Added flutter/foundation.dart import for debugPrint

12. **ServerDiscoveryService** - `/packages/app/lib/core/network/server_discovery_service.dart`
    - Added debugPrint for discovery failures with graceful degradation to cached servers
    - Added flutter/foundation.dart import for debugPrint

13. **WebRTCService message handling** - `/packages/app/lib/core/network/webrtc_service.dart`
    - JSON parse catch documented as intentional for mixed-format channels
    - Decryption failures now logged via logger service

14. **CryptoService key loading** - `/packages/app/lib/core/crypto/crypto_service.dart`
    - Both identity key and session key loading catches now documented
    - Explains expected behavior on first run or after storage clear

15. **LoggerService rotation** - `/packages/app/lib/core/logging/logger_service.dart`
    - Rotation errors now logged with debugPrint (prevents app crash)

### Patterns Applied

1. **Explicit Documentation**: All intentionally silent catches now have comments explaining:
   - Why silent failure is acceptable
   - What conditions trigger the catch
   - How the system continues operating

2. **Contextual Logging**: Critical failures now include:
   - Message type or operation context
   - Error details for debugging
   - User-facing messages where appropriate

3. **Security Error Differentiation**: Replay attacks and other security errors are distinguished from general failures and surfaced appropriately

4. **Graceful Degradation**: Network operations fail gracefully to cached data or continue operation where safe
