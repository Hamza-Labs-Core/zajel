# Issue #37: Error Handling Research

## Executive Summary

This document provides an updated inventory of error handling patterns across the Zajel codebase, identifying remaining problematic catch blocks and providing risk assessments with recommended fixes.

---

## Current State Analysis

### Packages Analyzed
1. **packages/web-client/src/** - TypeScript React web client
2. **packages/app/lib/** - Dart Flutter mobile app
3. **packages/server-vps/src/** - TypeScript server

---

## Inventory of Catch Blocks

### Web Client (TypeScript)

| File | Line | Pattern | Current Handling | Risk Level | Notes |
|------|------|---------|------------------|------------|-------|
| `lib/errors.ts:192` | catch (e) | Handler error | console.error | LOW | Error in error handler - logged appropriately |
| `lib/fileTransferManager.ts:749` | catch (e) | Chunk processing | console.error + ACK | MEDIUM | Logs and sends failed ACK - should surface to UI |
| `lib/signaling.ts:264` | catch (error) | WebSocket send | console.error + onError | GOOD | Already fixed - notifies for critical types |
| `App.tsx:63` | catch (e) | Crypto init | handleError + setError | GOOD | Sets error state, prevents continuation |
| `App.tsx:178` | catch (e) | Message decrypt | handleError + setError | GOOD | Uses centralized error handling |
| `App.tsx:255` | catch (e) | Chunk decrypt | handleError + UI update | GOOD | Shows user message, updates transfer status |
| `lib/webrtc.ts:143` | catch (e) | ICE candidate | console.warn | LOW | Expected failures, logged as warning |
| `lib/webrtc.ts:156` | catch (e) | Pending ICE | console.warn | LOW | Expected during connection setup |
| `lib/webrtc.ts:306` | catch (e) | file_start send | console.error, return false | MEDIUM | Caller should handle false return |
| `lib/webrtc.ts:346` | catch (error) | Chunk send | console.error, return false | MEDIUM | Caller should handle false return |
| `lib/webrtc.ts:415` | catch (e) | file_start_ack | console.error, return false | MEDIUM | Caller should handle false return |
| `lib/webrtc.ts:434` | catch (e) | chunk_ack | console.error, return false | MEDIUM | Caller should handle false return |
| `lib/webrtc.ts:448` | catch (e) | chunk_retry | console.error, return false | MEDIUM | Caller should handle false return |
| `lib/webrtc.ts:473` | catch (e) | file_complete_ack | console.error, return false | MEDIUM | Caller should handle false return |
| `lib/webrtc.ts:490` | catch (e) | transfer_cancel | console.error, return false | MEDIUM | Caller should handle false return |
| `components/FingerprintDisplay.tsx:44` | catch (err) | Clipboard copy | console.error + setAnnouncement | GOOD | Shows failure to user |

### Flutter App (Dart)

| File | Line | Pattern | Current Handling | Risk Level | Notes |
|------|------|---------|------------------|------------|-------|
| `features/chat/chat_screen.dart:187` | catch (e) | File share | SnackBar | GOOD | Shows error to user |
| `features/chat/chat_screen.dart:298` | catch (e) | Send message | Update status to failed | GOOD | Proper state update |
| `features/chat/chat_screen.dart:343` | catch (e) | Send file | Update status to failed | GOOD | Proper state update |
| `features/chat/chat_screen.dart:684` | catch (e) | Pick files | setState, SnackBar | GOOD | Shows error, updates state |
| `features/connection/connect_screen.dart:58` | catch (e) | Enable connections | setState error | GOOD | Shows error to user |
| `features/connection/connect_screen.dart:312` | catch (e) | Connect | SnackBar | GOOD | Shows error to user |
| `features/home/home_screen.dart:382` | catch (e) | Connect external | SnackBar | GOOD | Shows error to user |
| `features/home/home_screen.dart:398` | catch (e) | Cancel connection | Silent (documented) | LOW | Best-effort, documented |
| `features/settings/settings_screen.dart:379` | catch (e) | Enable external | SnackBar | GOOD | Shows error to user |
| `features/settings/settings_screen.dart:509` | catch (e) | Export logs | logger.error + SnackBar | GOOD | Logs and shows error |
| `main.dart:70` | catch (e) | Shutdown | logger.error | LOW | Shutdown errors expected |
| `main.dart:91` | catch (e, stack) | Init | logger.error | MEDIUM | Should surface to user |
| `core/network/connection_manager.dart:281` | catch (e) | Connect | Update state + rethrow | GOOD | Proper error propagation |
| `core/network/signaling_client.dart:134` | catch (e) | Connect | Cleanup + state update | GOOD | Proper cleanup |
| `core/network/signaling_client.dart:311` | catch (e) | Message parse | debugPrint (documented) | LOW | Non-fatal, documented |
| `core/network/server_discovery_service.dart:120` | catch (e) | Discovery | debugPrint + return cache | GOOD | Graceful degradation |
| `core/network/rendezvous_service.dart:91` | catch (e) | Registration | logger.error + continue | GOOD | Continues with other peers |
| `core/network/rendezvous_service.dart:135` | catch (e) | Decrypt | Throws custom exception | GOOD | Proper error wrapping |
| `core/crypto/crypto_service.dart:88` | catch (e) | Base64 decode | Throws CryptoException | GOOD | Proper error wrapping |
| `core/crypto/crypto_service.dart:329` | catch (_) | Key load | Generate new (documented) | LOW | Expected on first run |
| `core/crypto/crypto_service.dart:374` | catch (_) | Session key | Return null (documented) | LOW | Caller handles null |
| `core/network/peer_reconnection_service.dart:245` | catch (e) | Create dead drop | logger.error + return null | GOOD | Caller handles null |
| `core/network/peer_reconnection_service.dart:256` | catch (e) | Decrypt dead drop | logger.error + return null | GOOD | Caller handles null |
| `core/network/peer_reconnection_service.dart:301` | catch (e) | Primary relay | logger.warning + fallback | GOOD | Fallback logic |
| `core/network/peer_reconnection_service.dart:316` | catch (e) | Fallback relay | logger.warning + continue | GOOD | Try next fallback |
| `core/network/peer_reconnection_service.dart:340` | catch (e) | Process dead drop | logger.error | MEDIUM | Should notify caller |
| `core/network/webrtc_service.dart:414` | catch (_) | JSON parse | Pass to message handler | LOW | Intentional for mixed format |
| `core/network/webrtc_service.dart:431` | catch (e) | Decrypt | logger.error | MEDIUM | Should surface to UI |

### Server VPS (TypeScript)

| File | Line | Pattern | Current Handling | Risk Level | Notes |
|------|------|---------|------------------|------------|-------|
| `index.ts:266` | catch (error) | Bootstrap reg | console.warn + continue | LOW | Non-critical startup |
| `index.ts:291` | catch (error) | Cleanup | console.error | MEDIUM | Cleanup errors should be monitored |
| `index.ts:371` | .catch((error) | Start fail | console.error + exit | GOOD | Fatal error, exits properly |
| `client/handler.ts:293` | catch (e) | JSON parse | sendError | GOOD | Informs client |
| `client/handler.ts:352` | catch (error) | Message handler | emit + sendError | GOOD | Emits event, informs client |
| `client/handler.ts:549` | catch (error) | Public key decode | console.warn + sendError | GOOD | Logs and informs client |
| `client/handler.ts:1022` | catch (e) | Send message | console.error, return false | MEDIUM | Caller should handle |
| `federation/federation-manager.ts:236` | catch (error) | Bootstrap connect | console.warn | MEDIUM | Should track failures |
| `federation/federation-manager.ts:276` | catch (error) | Handshake error | clearTimeout + reject | GOOD | Promise rejected |
| `federation/federation-manager.ts:299` | .catch(() => {}) | Connect member | Empty | LOW | Fire-and-forget bootstrap |
| `federation/federation-manager.ts:307` | catch (error) | Message error | reject | GOOD | Promise rejected |
| `federation/federation-manager.ts:340` | .catch(() => {}) | Connect entry | Empty (commented) | LOW | Will retry later |
| `federation/federation-manager.ts:434` | catch (error) | Load servers | console.error | MEDIUM | Should have fallback |
| `federation/federation-manager.ts:459` | catch (error) | Persist servers | console.error | MEDIUM | Data loss possible |
| `federation/bootstrap-client.ts:61` | catch (error) | Register | console.error + throw | GOOD | Re-throws |
| `federation/bootstrap-client.ts:80` | catch (error) | Unregister | console.error | LOW | Best-effort |
| `federation/bootstrap-client.ts:97` | catch (error) | Get servers | console.error, return [] | MEDIUM | Empty array hides failure |
| `federation/bootstrap-client.ts:125` | catch (error) | Heartbeat | console.error, return [] | MEDIUM | Empty array hides failure |
| `federation/gossip/protocol.ts:393` | catch (error) | Verify sig | console.debug, return false | LOW | Security - returns false |
| `federation/transport/server-connection.ts:117` | catch (error) | Connect | Delete + throw | GOOD | Cleanup and re-throw |
| `federation/transport/server-connection.ts:147` | catch (error) | Send message | logger.error, return false | MEDIUM | Caller should handle |
| `federation/transport/server-connection.ts:229` | catch (error) | Handshake | cleanup + reject | GOOD | Promise rejected |
| `federation/transport/server-connection.ts:278` | catch (error) | Verify handshake | cleanup + reject | GOOD | Promise rejected |
| `federation/transport/server-connection.ts:375` | catch (error) | Handle message | console.error | MEDIUM | Should emit error event |
| `federation/transport/server-connection.ts:437` | catch (error) | Parse message | console.error | MEDIUM | Should emit error event |
| `federation/transport/server-connection.ts:489` | catch (error) | Reconnect | logger.error | LOW | Reconnect will retry |

---

## Risk Assessment Summary

### HIGH RISK (Require Immediate Attention)
None identified - previous fixes have addressed critical issues.

### MEDIUM RISK (Should Address)

1. **webrtc.ts file operations** - Multiple send methods return `false` on error but callers may not handle the return value properly.

2. **bootstrap-client.ts getServers/heartbeat** - Returning empty arrays hides failures from callers.

3. **server-connection.ts message handling** - Errors logged but not emitted as events for monitoring.

4. **fileTransferManager.ts:749** - Chunk processing errors should surface to UI.

5. **main.dart:91** - Initialization failure should show user a clear error state.

6. **webrtc_service.dart:431** - Decryption failures should be surfaced to UI layer.

### LOW RISK (Acceptable or Documented)

- ICE candidate failures (expected during connection)
- Silent catches with documentation
- Best-effort operations (cancel, unregister)
- Fire-and-forget operations with retry logic
- Intentional fallback patterns (mixed-format channels)

---

## Error Handling Best Practices

### TypeScript Best Practices

Based on research from [TypeScript Error Handling Guide](https://www.dhiwise.com/post/typescript-error-handling-pitfalls-and-how-to-avoid-them) and [JavaScript/TypeScript Error Handling](https://betacraft.com/2025-01-15-js-ts-error-handling/):

1. **Use `unknown` type in catch blocks** - TypeScript 4.0+ defaults to `unknown`, requiring type narrowing:
   ```typescript
   catch (error: unknown) {
     if (error instanceof Error) {
       console.error(error.message);
     }
   }
   ```

2. **Preserve stack traces when rethrowing** - Use the `cause` property:
   ```typescript
   catch (err) {
     throw new Error("Operation failed", { cause: err });
   }
   ```

3. **Consider the Result pattern** for critical operations - Forces caller to handle both success and failure at compile time.

4. **Never leave catch blocks empty** - Always log with context or document why silent failure is acceptable.

### Dart Best Practices

Based on [Dart Error Handling](https://dart.dev/language/error-handling) and [Flutter Exception Handling](https://codewithandrea.com/articles/flutter-exception-handling-try-catch-result-type/):

1. **Use `rethrow` to preserve stack traces**:
   ```dart
   } catch (e) {
     logger.error('Operation failed', e);
     rethrow;
   }
   ```

2. **Use `on` for specific exception types**:
   ```dart
   } on FormatException catch (e) {
     // Handle format errors specifically
   } catch (e) {
     // Handle other errors
   }
   ```

3. **Consider sealed Result types** for complex error handling:
   ```dart
   sealed class Result<T> {}
   class Ok<T> extends Result<T> { final T value; }
   class Err<T> extends Result<T> { final Exception error; }
   ```

4. **Use `runZonedGuarded` for global error handling** in Flutter apps.

---

## Error Reporting Strategy

Based on research from [Sentry Best Practices 2025](https://www.baytechconsulting.com/blog/sentry-io-comprehensive-guide-2025) and [Efficient Error Tracking](https://medium.com/@AndrzejSala/efficient-error-tracking-with-sentry-e975c186947c):

### Recommended Approach

1. **Structured Logging**
   - Use consistent log format with timestamp, level, service, correlation_id
   - Include error type, message, and stack trace
   - Add contextual data (peer code masked, operation type)

2. **Error Levels**
   - ERROR: Operation failed, requires attention
   - WARN: Potential issue, system recovered
   - INFO: Normal operation milestones
   - DEBUG: Detailed troubleshooting

3. **Error Escalation Pattern**
   - Track consecutive failures
   - Escalate to user notification after threshold (e.g., 3 failures)
   - Reset counter on success

4. **Production Monitoring Recommendations**
   - Integrate Sentry or similar for web client
   - Use Firebase Crashlytics for Flutter app
   - Set up alerts for new error types and rate spikes
   - Use source maps for readable stack traces

---

## Recommended Fixes by Priority

### P1 - File Transfer Reliability

**File:** `/home/meywd/zajel/packages/web-client/src/lib/fileTransferManager.ts:749`

```typescript
// Current
} catch (e) {
  console.error('Failed to process chunk:', e);
  this.events.sendChunkAck(fileId, chunkIndex, 'failed');
}

// Recommended
} catch (e) {
  console.error('Failed to process chunk:', e);
  this.events.sendChunkAck(fileId, chunkIndex, 'failed');
  // Surface error to UI
  this.emitError(fileId, `Chunk ${chunkIndex} processing failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
}
```

### P2 - WebRTC Send Error Handling

**Issue:** Multiple WebRTC send methods return `false` but callers may ignore this.

**Recommendation:** Create a wrapper that throws or uses Result pattern:

```typescript
async sendFileStartOrThrow(file: File, chunkCount: number): Promise<string> {
  const result = await this.sendFileStart(file, chunkCount);
  if (!result) {
    throw new FileTransferError('Failed to initiate file transfer');
  }
  return result;
}
```

### P3 - Bootstrap Client Error Visibility

**Files:** `/home/meywd/zajel/packages/server-vps/src/federation/bootstrap-client.ts:97,125`

```typescript
// Current - hides failure
} catch (error) {
  console.error(`[Bootstrap] Get servers error:`, error);
  return [];
}

// Recommended - use Result type
} catch (error) {
  console.error(`[Bootstrap] Get servers error:`, error);
  return { success: false, error, servers: [] };
}
```

### P4 - Server Connection Event Emission

**Files:** `/home/meywd/zajel/packages/server-vps/src/federation/transport/server-connection.ts:375,437`

```typescript
// Current
} catch (error) {
  console.error('[Transport] Error handling message:', error);
}

// Recommended
} catch (error) {
  console.error('[Transport] Error handling message:', error);
  this.emit('message-error', serverId, error as Error);
}
```

---

## When Silent Failure is Acceptable

Based on research from [Error Handling with Grace](https://www.freecodecamp.org/news/how-to-handle-errors-with-grace-failing-silently-is-not-an-option-de6ce8f897d7/) and [Fail-Silent Patterns](https://medium.com/@jusuftopic/designing-for-the-inevitable-fail-silent-and-fail-operational-patterns-explained-621db0232070):

### Acceptable Scenarios

1. **Optional features** - Analytics, telemetry, non-critical UI enhancements
2. **Best-effort operations** - Cancel requests, cleanup on shutdown
3. **Expected fallback paths** - JSON parse failure for encrypted data in mixed channels
4. **Graceful degradation** - Use cached data when network fails

### Always Document

Any intentionally silent catch should include a comment explaining:
- Why silent failure is acceptable
- What triggers the catch
- How the system continues

Example:
```dart
} catch (_) {
  // Intentionally silent: Session key loading failure is handled by returning null.
  // Caller will establish a new session with fresh key exchange if no key is found.
}
```

---

## Sources

- [TypeScript Error Handling Guide](https://www.dhiwise.com/post/typescript-error-handling-pitfalls-and-how-to-avoid-them)
- [JavaScript/TypeScript Error Handling 2025](https://betacraft.com/2025-01-15-js-ts-error-handling/)
- [Dart Error Handling](https://dart.dev/language/error-handling)
- [Flutter Exception Handling](https://codewithandrea.com/articles/flutter-exception-handling-try-catch-result-type/)
- [Sentry Comprehensive Guide 2025](https://www.baytechconsulting.com/blog/sentry-io-comprehensive-guide-2025)
- [Efficient Error Tracking with Sentry](https://medium.com/@AndrzejSala/efficient-error-tracking-with-sentry-e975c186947c)
- [Error Handling with Grace](https://www.freecodecamp.org/news/how-to-handle-errors-with-grace-failing-silently-is-not-an-option-de6ce8f897d7/)
- [Fail-Silent and Fail-Operational Patterns](https://medium.com/@jusuftopic/designing-for-the-inevitable-fail-silent-and-fail-operational-patterns-explained-621db0232070)
- [Get a Catch Block Error Message with TypeScript](https://kentcdodds.com/blog/get-a-catch-block-error-message-with-typescript)
- [TypeScript Try Catch Rethrow Best Practices](https://www.webdevtutor.net/blog/typescript-try-catch-rethrow)

---

## Related Issues

- Issue #33: Error Handling (general error handling improvements)
- Issue #12: Callback Race Conditions
- Issue #19: Null Assertions
- Issue #24: File Transfer Errors
