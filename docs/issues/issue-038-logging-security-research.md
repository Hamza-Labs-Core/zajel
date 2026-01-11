# Issue #38: Logging Security Research - Pairing Codes in Logs

## Executive Summary

This document provides a comprehensive security audit of logging practices in the Zajel codebase, identifying sensitive data exposure in logs and recommending mitigation strategies based on industry best practices.

**Status**: Partially Remediated - A secure logger has been implemented but not yet fully integrated.

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Sensitive Data Logging Locations](#sensitive-data-logging-locations)
3. [Classification of Sensitive Data](#classification-of-sensitive-data)
4. [Industry Research](#industry-research)
5. [Existing Remediation](#existing-remediation)
6. [Remaining Work](#remaining-work)
7. [Recommendations](#recommendations)

---

## Current State Analysis

### Summary Statistics

| Category | Count | Status |
|----------|-------|--------|
| **Total console statements** | ~60 | Audited |
| **High risk (pairing codes)** | 0 in handler.ts | FIXED |
| **Medium risk (IPs, server IDs)** | 8 | Mostly FIXED |
| **Low risk (operational)** | ~40 | Acceptable |
| **Remaining unmitigated** | ~10 | Needs work |

### Secure Logger Implementation Status

The codebase now includes TWO secure logger implementations:

1. **`/packages/server-vps/src/utils/logger.ts`** - TypeScript logger for Node.js VPS server
2. **`/packages/server/src/logger.js`** - JavaScript logger for Cloudflare Workers

Both loggers implement:
- Environment-aware redaction (production vs development)
- Pairing code masking (`A****Z` format)
- IP address redaction (`192.*.*.*` format)
- Server ID truncation (`abcd...wxyz` format)
- Log level filtering (debug, info, warn, error)

---

## Sensitive Data Logging Locations

### 1. Server VPS Package (`packages/server-vps/src/`)

#### FIXED: Client Handler (`client/handler.ts`)

All 8 high-risk pairing code logging statements have been replaced with the secure logger:

| Line | Original | Current | Status |
|------|----------|---------|--------|
| ~593 | `console.log(...pairing code...)` | `logger.pairingEvent('registered', ...)` | FIXED |
| ~695 | `console.log(...pair request...)` | `logger.pairingEvent('request', ...)` | FIXED |
| ~830 | `console.log(...pair matched...)` | `logger.pairingEvent('matched', ...)` | FIXED |
| ~840 | `console.log(...pair rejected...)` | `logger.pairingEvent('rejected', ...)` | FIXED |
| ~869 | `console.log(...pair expired...)` | `logger.pairingEvent('expired', ...)` | FIXED |
| ~897 | `console.log(...target not found...)` | `logger.pairingEvent('not_found', ...)` | FIXED |
| ~913 | `console.log(...forwarded...)` | `logger.pairingEvent('forwarded', ...)` | FIXED |
| ~971 | `console.log(...disconnected...)` | `logger.pairingEvent('disconnected', ...)` | FIXED |

#### FIXED: Main Server (`index.ts`)

| Line | Description | Status |
|------|-------------|--------|
| 57-58 | Server/Node ID logging | FIXED - Uses `logger.serverId()` |
| 232 | Client connected | FIXED - Uses `logger.clientConnection()` |
| 245 | Client disconnected | FIXED - Uses `logger.clientConnection()` |
| 303-307 | Federation events | FIXED - Uses `logger.federationEvent()` |

#### FIXED: Federation Manager (`federation/federation-manager.ts`)

| Line | Description | Status |
|------|-------------|--------|
| 389 | Connected to server | FIXED - Uses `logger.federationEvent()` |
| 393 | Disconnected from server | FIXED - Uses `logger.federationEvent()` |
| 406 | Transport error | FIXED - Uses `logger.serverId()` |

#### REMAINING: Bootstrap Client (`federation/bootstrap-client.ts`)

This file still uses raw `console.log` statements:

| Line | Statement | Risk | Recommendation |
|------|-----------|------|----------------|
| 45 | `console.log(\`[Bootstrap] Registering with ${baseUrl}...\`)` | LOW | Replace with logger.info |
| 60 | `console.log(\`[Bootstrap] Registered successfully:\`, result)` | MEDIUM | Redact result object |
| 62 | `console.error(\`[Bootstrap] Registration error:\`, error)` | LOW | Replace with logger.error |
| 70 | `console.log(\`[Bootstrap] Unregistering...\`)` | LOW | Replace with logger.info |
| 76-78 | Unregister status logging | LOW | Replace with logger |
| 81 | `console.error(\`[Bootstrap] Unregister error:\`, error)` | LOW | Replace with logger.error |
| 98 | `console.error(\`[Bootstrap] Get servers error:\`, error)` | LOW | Replace with logger.error |
| 116 | Re-registration notice | LOW | Replace with logger.info |
| 126 | `console.error(\`[Bootstrap] Heartbeat error:\`, error)` | LOW | Replace with logger.error |
| 137 | Heartbeat peer count | LOW | Replace with logger.debug |
| 141 | Heartbeat started | LOW | Replace with logger.info |
| 148 | Heartbeat stopped | LOW | Replace with logger.info |

### 2. Server (Cloudflare Workers) Package (`packages/server/src/`)

#### FIXED: Signaling Room (`signaling-room.js`)

All pairing code logging now uses the secure logger:

| Location | Status |
|----------|--------|
| `handleRegister` | FIXED - Uses `logger.pairingEvent('registered', ...)` |
| `webSocketClose` | FIXED - Uses `logger.pairingEvent('disconnected', ...)` |
| `handleSignaling` | FIXED - Uses `logger.pairingEvent('signaling', ...)` |

### 3. Web Client Package (`packages/web-client/src/`)

#### LOW RISK: Error Handling Logs

The web client logging is relatively safe - mostly error handling:

| File | Risk | Details |
|------|------|---------|
| `lib/errors.ts` | LOW | Error logging with recoverable flag |
| `lib/fileTransferManager.ts` | LOW | Chunk retry/timeout warnings, file info |
| `lib/pwa.ts` | LOW | Service worker registration errors |
| `lib/signaling.ts` | LOW | WebSocket parse/size errors |
| `lib/webrtc.ts` | LOW | ICE candidate and channel errors |
| `App.tsx` | MEDIUM | Handshake verification failures, file rejection |
| `components/FingerprintDisplay.tsx` | LOW | Copy to clipboard errors |

**Notable concerns:**
- `App.tsx:206`: Logs rejected file names and sizes - could leak user data
- `App.tsx:147`: Logs "key mismatch - possible MITM attack" - useful for security but should not expose key details

### 4. Flutter App Package (`packages/app/lib/`)

#### LOW RISK: Dart Logging

The Dart logger service (`core/logging/logger_service.dart`) has proper log level support but lacks sensitive data redaction:

| File | Risk | Details |
|------|------|---------|
| `logger_service.dart` | LOW | File-based logging with rotation, no redaction |
| `signaling_client.dart` | LOW | Invalid message format logging |
| `server_discovery_service.dart` | LOW | Discovery failure caching |
| `crypto_service.dart` | MEDIUM | Fingerprint generation (should not log raw keys) |

---

## Classification of Sensitive Data

### HIGH Risk - Must NEVER appear in logs

| Data Type | Examples | Current Status |
|-----------|----------|----------------|
| Pairing codes | `ABC123` | FIXED - Redacted to `A****3` |
| Private keys | X25519 keys, signing keys | N/A - Not logged |
| Session tokens | Authentication tokens | N/A - Not logged |
| Message content | Chat messages | N/A - E2E encrypted, not logged |

### MEDIUM Risk - Should be redacted in production

| Data Type | Examples | Current Status |
|-----------|----------|----------------|
| IP addresses | `192.168.1.1` | FIXED - Redacted to `192.*.*.*` |
| Server IDs | Full 64-char hex IDs | FIXED - Truncated to `abcd...wxyz` |
| Public keys | X25519 public keys | Should validate, not log |
| File names | User file names | REMAINING - Still logged in App.tsx |
| Registration results | Bootstrap response objects | REMAINING - Still logged fully |

### LOW Risk - Acceptable in production logs

| Data Type | Examples | Status |
|-----------|----------|--------|
| Error types | "Parse error", "Connection failed" | OK |
| Counts | "5 peers connected" | OK |
| Status messages | "Server started", "Cleanup complete" | OK |
| Technical errors | Stack traces (development only) | OK with log levels |

---

## Industry Research

### Signal: The Gold Standard

Signal sets the industry standard for privacy-preserving logging:

**What Signal Does NOT Log:**
- Message content or metadata
- Display names, profile pictures
- Contact lists or social graphs
- Message timestamps beyond delivery confirmation

**Key Design Principles:**
- Messages stored only on user devices
- Queued messages encrypted and deleted after delivery
- Debug logs only enabled with explicit flag (`-P debugLevelLogs`)
- Production builds filter debug/verbose logs by default

**Zajel Alignment:** The current implementation follows Signal's approach by:
- Using environment-based log level filtering
- Implementing automatic redaction in production
- Keeping sensitive data redaction at the logger level, not call sites

### OWASP Guidelines

OWASP Logging Cheat Sheet recommendations:

**Data That Should NEVER Be Logged:**
- Passwords (even hashed)
- Session IDs and auth tokens
- Credit card numbers
- Private cryptographic keys

**Recommended Techniques:**
- Data de-identification: deletion, scrambling, pseudonymization
- Sanitization post-collection
- Encode data correctly for output format
- Sanitize event data to prevent log injection

**Zajel Implementation Status:**
- [x] Pairing code redaction (partial show: `A****Z`)
- [x] IP address redaction (`192.*.*.*`)
- [x] Server ID truncation
- [x] Environment-based filtering
- [ ] Log injection prevention (newlines, delimiters)
- [ ] Structured JSON logging in production

### CWE-532: Prevention Strategies

The Common Weakness Enumeration CWE-532 specifically addresses sensitive information in logs:

**Prevention Checklist:**
1. [x] Never log secrets, tokens, or passwords
2. [x] Remove debug logs before production deployment (via log levels)
3. [x] Obfuscate sensitive data if logging is required
4. [ ] Set restrictive file permissions on log files
5. [ ] Implement RBAC for log access
6. [x] Use structured logging to control field exposure

### GDPR Compliance Considerations

**IP Addresses Are Personal Data:**
- ECJ ruled IP addresses qualify as personal data when linkable to individuals
- Dynamic IPs count when combinable with other information

**Key Principles:**
1. **Data Minimization:** Collect only what's necessary - IMPLEMENTED
2. **Purpose Limitation:** Use log data only for stated purposes - IMPLEMENTED
3. **Storage Limitation:** Define and enforce retention periods - Dart logger has 7-day rotation
4. **Security:** Implement encryption and access controls - NEEDS WORK
5. **Accountability:** Document who accessed logs - NEEDS WORK

---

## Existing Remediation

### Implemented Solutions

#### 1. VPS Server Logger (`/packages/server-vps/src/utils/logger.ts`)

```typescript
export function redactPairingCode(code: string): string {
  if (!code || code.length < 3) return '****';
  return `${code[0]}****${code[code.length - 1]}`;
}

export function redactIp(ip: string): string {
  if (!ip) return '****';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    return `${parts[0]}.*.*.*`;
  }
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts[0]}:****:****`;
  }
  return '****';
}

export function redactServerId(id: string): string {
  if (!id || id.length < 12) return '****';
  return `${id.substring(0, 4)}...${id.substring(id.length - 4)}`;
}
```

**Features:**
- Environment detection via `NODE_ENV`
- Configurable log levels via `LOG_LEVEL`
- Automatic redaction toggle via `REDACT_LOGS`
- Specialized methods: `pairingEvent()`, `clientConnection()`, `federationEvent()`

#### 2. Cloudflare Workers Logger (`/packages/server/src/logger.js`)

```javascript
export function createLogger(env = {}) {
  const production = isProduction(env);
  return {
    pairingCode(code) {
      return production ? redactPairingCode(code) : code;
    },
    pairingEvent(event, code, target) {
      const redactedCode = this.pairingCode(code);
      const redactedTarget = target ? this.pairingCode(target) : undefined;
      this.debug(`[Pairing] ${event}`, { code: redactedCode, ...});
    },
    // ...
  };
}
```

**Features:**
- Worker environment binding awareness (`env.ENVIRONMENT`)
- Factory pattern for request-scoped loggers
- Automatic redaction in production

---

## Remaining Work

### Priority 1: Complete Bootstrap Client Migration

File: `/packages/server-vps/src/federation/bootstrap-client.ts`

Replace all `console.log/error` with structured logger calls:

```typescript
import { logger } from '../utils/logger.js';

// Before:
console.log(`[Bootstrap] Registering with ${baseUrl}...`);
console.log(`[Bootstrap] Registered successfully:`, result);

// After:
logger.info(`[Bootstrap] Registering with ${baseUrl}`);
logger.debug(`[Bootstrap] Registered`, {
  serverId: logger.serverId(result.serverId),
  endpoint: result.endpoint,
});
```

### Priority 2: Add File Name Redaction

File: `/packages/web-client/src/App.tsx` line 206

```typescript
// Before:
console.warn(`Rejected file transfer: ${fileName} (${totalSize} bytes...)`);

// After:
// Remove or redact file name
console.warn(`Rejected file transfer: <redacted> (exceeds size limit)`);
```

### Priority 3: Dart Logger Sensitive Data Support

File: `/packages/app/lib/core/logging/logger_service.dart`

Add redaction methods similar to the TypeScript logger:

```dart
class LoggerService {
  // Add these methods
  String redactPairingCode(String code) {
    if (code.length < 3) return '****';
    return '${code[0]}****${code[code.length - 1]}';
  }

  String redactIp(String ip) {
    if (ip.contains('.')) {
      return '${ip.split('.')[0]}.*.*.*';
    }
    return '****';
  }
}
```

### Priority 4: Production Build Log Stripping

For web client, add build-time log removal:

```javascript
// vite.config.ts
export default defineConfig({
  esbuild: {
    drop: process.env.NODE_ENV === 'production' ? ['console', 'debugger'] : [],
  },
});
```

---

## Recommendations

### Immediate Actions (Before Release)

1. **Migrate bootstrap-client.ts** to use structured logger
2. **Remove or redact file names** from App.tsx rejection logs
3. **Verify production environment** detection works correctly
4. **Test log output** in both development and production modes

### Short-term (Next Sprint)

1. **Add Dart logger redaction** for mobile app
2. **Implement log injection prevention** (sanitize newlines, special characters)
3. **Add structured JSON output** option for production logs
4. **Create monitoring dashboard** for entropy metrics

### Medium-term (Next Quarter)

1. **Implement audit logging** for security events (separate from operational logs)
2. **Add log retention policies** with automatic cleanup
3. **Set up centralized log aggregation** with access controls
4. **Add CI/CD secret scanning** for log statements

### Long-term (Future Releases)

1. **Domain primitives** for sensitive values that auto-redact
2. **Differential privacy** for aggregate metrics
3. **Hardware security modules** for audit log signing
4. **Regular security audits** of log contents

---

## Environment Configuration Reference

### VPS Server

```bash
# Production
NODE_ENV=production    # Enables automatic redaction
LOG_LEVEL=info         # Filters out debug logs
REDACT_LOGS=true       # Explicit redaction toggle (default: true in production)

# Development
NODE_ENV=development   # Shows full values for debugging
LOG_LEVEL=debug        # Shows all log levels
```

### Cloudflare Workers

```toml
# wrangler.toml
[vars]
ENVIRONMENT = "production"  # Enables automatic redaction
LOG_LEVEL = "info"          # Filters out debug logs
```

### Flutter App

```dart
// In main.dart or during initialization
LoggerService.instance.minLevel = kReleaseMode ? LogLevel.info : LogLevel.debug;
```

---

## References

- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- CWE-532: Insertion of Sensitive Information into Log File: https://cwe.mitre.org/data/definitions/532.html
- GDPR Article 25: Data Protection by Design and by Default
- Signal Privacy Policy: https://signal.org/legal/
- GitGuardian - Keeping Secrets Out of Logs: https://blog.gitguardian.com/keeping-secrets-out-of-logs/
- OWASP Top 10:2025 A09: https://owasp.org/Top10/2025/A09_2025-Security_Logging_and_Alerting_Failures/

---

## Document History

| Date | Author | Changes |
|------|--------|---------|
| 2026-01-11 | Claude | Initial research document |
