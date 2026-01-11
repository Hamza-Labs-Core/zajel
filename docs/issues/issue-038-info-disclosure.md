# Issue #38: Information Disclosure in Logs

## Summary

This document analyzes console logging statements across the Zajel codebase to identify potential information disclosure vulnerabilities where sensitive data such as pairing codes, server identifiers, and connection metadata may be logged to the console.

## Severity

**Medium** - Information disclosure through logs can expose sensitive identifiers that could be used for:
- User tracking and correlation
- Session hijacking if logs are accessible
- Facilitating targeted attacks against specific pairing sessions
- Compliance violations (GDPR, privacy regulations)

---

## Inventory of Console Logging Statements

### Server-VPS Package (`packages/server-vps/src/`)

#### Critical: Sensitive Data Logged

| File | Line | Statement | Sensitive Data | Risk Level |
|------|------|-----------|----------------|------------|
| `client/handler.ts` | 517 | `console.log(\`[ClientHandler] Registered pairing code: ${pairingCode}\`)` | **Pairing code** | HIGH |
| `client/handler.ts` | 618 | `console.log(\`[ClientHandler] Pair request: ${requesterCode} -> ${targetCode}\`)` | **Two pairing codes** | HIGH |
| `client/handler.ts` | 700 | `console.log(\`[ClientHandler] Pair matched: ${targetCode} <-> ${responderCode}\`)` | **Two pairing codes** | HIGH |
| `client/handler.ts` | 710 | `console.log(\`[ClientHandler] Pair rejected: ${targetCode} <- ${responderCode}\`)` | **Two pairing codes** | HIGH |
| `client/handler.ts` | 739 | `console.log(\`[ClientHandler] Pair request expired: ${requesterCode} -> ${targetCode}\`)` | **Two pairing codes** | HIGH |
| `client/handler.ts` | 767 | `console.log(\`[ClientHandler] Target not found for ${type}: ${target}\`)` | **Target pairing code** | HIGH |
| `client/handler.ts` | 783 | `console.log(\`[ClientHandler] Forwarded ${type} from ${senderPairingCode} to ${target}\`)` | **Two pairing codes** | HIGH |
| `client/handler.ts` | 839 | `console.log(\`[ClientHandler] Pairing code disconnected: ${pairingCode}\`)` | **Pairing code** | HIGH |

#### Medium Risk: Server Identifiers and Metadata

| File | Line | Statement | Data Type | Risk Level |
|------|------|-----------|-----------|------------|
| `index.ts` | 55-56 | `console.log(\`[Zajel] Server ID: ${identity.serverId}\`)` | Server ID, Node ID | MEDIUM |
| `index.ts` | 191 | `console.log(\`[Zajel] Client connected from ${clientIp}\`)` | Client IP address | MEDIUM |
| `index.ts` | 204 | `console.log(\`[Zajel] Client disconnected from ${clientIp}\`)` | Client IP address | MEDIUM |
| `index.ts` | 298 | `console.log(\`[Zajel] Public endpoint: ${config.network.publicEndpoint}\`)` | Public endpoint URL | LOW |
| `federation/federation-manager.ts` | 388 | `console.log(\`[Federation] Connected to ${entry.serverId}\`)` | Server ID | MEDIUM |
| `federation/federation-manager.ts` | 392 | `console.log(\`[Federation] Disconnected from ${serverId}...\`)` | Server ID | MEDIUM |
| `federation/bootstrap-client.ts` | 60 | `console.log(\`[Bootstrap] Registered successfully:\`, result)` | Registration result object | MEDIUM |

#### Low Risk: Operational Logs (Non-Sensitive)

| File | Line | Statement | Description |
|------|------|-----------|-------------|
| `index.ts` | 42-43 | Server startup messages | Region info |
| `index.ts` | 48 | Storage initialization | Status only |
| `index.ts` | 217, 231, 257-258 | Federation status | Peer counts |
| `index.ts` | 242, 248 | Cleanup operations | Counts only |
| `index.ts` | 262, 266 | Server join/fail events | Server IDs |
| `index.ts` | 271, 291, 324 | Shutdown messages | Status only |
| Various | Multiple | Error messages | Technical errors |

### Web-Client Package (`packages/web-client/src/`)

#### Low Risk: Error Handling Only

| File | Line | Statement | Data Type | Risk Level |
|------|------|-----------|-----------|------------|
| `lib/signaling.ts` | 95 | Size limit rejection | No sensitive data | LOW |
| `lib/signaling.ts` | 105 | Parse failure | Error object | LOW |
| `lib/signaling.ts` | 110 | WebSocket error | Error object | LOW |
| `lib/webrtc.ts` | 113 | ICE candidate queue warning | No sensitive data | LOW |
| `lib/webrtc.ts` | 123 | ICE candidate failure | Error object | LOW |
| `lib/webrtc.ts` | 129 | Channel open | Status only | LOW |
| `lib/webrtc.ts` | 139, 170 | Data size rejections | No sensitive data | LOW |
| `lib/webrtc.ts` | 158 | Channel error | Error object | LOW |
| `lib/webrtc.ts` | 195 | Parse failure | Error object | LOW |
| `App.tsx` | 147 | Decrypt failure | Error object | LOW |
| `App.tsx` | 153 | File rejection | File name, size | LOW |
| `App.tsx` | 201 | Chunk decrypt failure | Error object | LOW |

---

## Detailed Analysis of High-Risk Logging

### 1. Pairing Code Exposure (`client/handler.ts`)

**What pairing codes are**: 6-character alphanumeric codes used to establish peer-to-peer connections between clients.

**Why this is problematic**:
- Pairing codes are session identifiers that can be used to correlate users
- Log aggregation services may store these indefinitely
- Server administrators or anyone with log access can see who is connecting to whom
- Could be used to track user communication patterns

**Specific vulnerable logging statements**:

```typescript
// Line 517 - Logs when a client registers
console.log(`[ClientHandler] Registered pairing code: ${pairingCode}`);

// Line 618 - Logs pair requests showing both parties
console.log(`[ClientHandler] Pair request: ${requesterCode} -> ${targetCode}`);

// Line 700 - Logs successful pairings
console.log(`[ClientHandler] Pair matched: ${targetCode} <-> ${responderCode}`);

// Line 783 - Logs all signaling forwards (offer, answer, ICE)
console.log(`[ClientHandler] Forwarded ${type} from ${senderPairingCode} to ${target}`);
```

### 2. Client IP Address Logging (`index.ts`)

**Lines 191 and 204** log client IP addresses on connect/disconnect:

```typescript
console.log(`[Zajel] Client connected from ${clientIp}`);
console.log(`[Zajel] Client disconnected from ${clientIp}`);
```

This can be used to:
- Track user locations
- Correlate with pairing codes to deanonymize users
- Identify patterns of usage

---

## Recommendations

### Immediate Actions (High Priority)

#### 1. Implement a Structured Logger with Log Levels

Create a centralized logging service that supports log levels and can be configured per environment:

```typescript
// packages/server-vps/src/utils/logger.ts
import { randomBytes } from 'crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerConfig {
  level: LogLevel;
  redactSensitive: boolean;
  environment: 'development' | 'production';
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private config: LoggerConfig;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: (process.env.LOG_LEVEL as LogLevel) || 'info',
      redactSensitive: process.env.NODE_ENV === 'production',
      environment: (process.env.NODE_ENV as 'development' | 'production') || 'development',
      ...config,
    };
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  private redactPairingCode(code: string): string {
    if (!this.config.redactSensitive) return code;
    if (!code || code.length < 3) return '***';
    // Show first character and last character only
    return `${code[0]}****${code[code.length - 1]}`;
  }

  private redactIp(ip: string): string {
    if (!this.config.redactSensitive) return ip;
    // For IPv4: show first octet only
    if (ip.includes('.')) {
      const parts = ip.split('.');
      return `${parts[0]}.***.***`;
    }
    // For IPv6: show first segment only
    if (ip.includes(':')) {
      const parts = ip.split(':');
      return `${parts[0]}:****:****`;
    }
    return '***';
  }

  private redactServerId(id: string): string {
    if (!this.config.redactSensitive) return id;
    if (!id || id.length < 8) return '***';
    return `${id.substring(0, 4)}...${id.substring(id.length - 4)}`;
  }

  // Generate a request ID for correlation without exposing pairing codes
  generateRequestId(): string {
    return randomBytes(4).toString('hex');
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('debug')) {
      console.debug(`[DEBUG] ${message}`, meta ? JSON.stringify(meta) : '');
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('info')) {
      console.log(`[INFO] ${message}`, meta ? JSON.stringify(meta) : '');
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.shouldLog('warn')) {
      console.warn(`[WARN] ${message}`, meta ? JSON.stringify(meta) : '');
    }
  }

  error(message: string, error?: unknown, meta?: Record<string, unknown>): void {
    if (this.shouldLog('error')) {
      console.error(`[ERROR] ${message}`, error, meta ? JSON.stringify(meta) : '');
    }
  }

  // Specialized methods for common sensitive data
  pairingEvent(event: string, codes: { requester?: string; target?: string; code?: string }): void {
    const redacted = {
      requester: codes.requester ? this.redactPairingCode(codes.requester) : undefined,
      target: codes.target ? this.redactPairingCode(codes.target) : undefined,
      code: codes.code ? this.redactPairingCode(codes.code) : undefined,
    };
    this.debug(`[Pairing] ${event}`, redacted);
  }

  clientConnection(event: 'connected' | 'disconnected', ip: string): void {
    this.info(`[Client] ${event}`, { ip: this.redactIp(ip) });
  }

  federationEvent(event: string, serverId: string): void {
    this.info(`[Federation] ${event}`, { serverId: this.redactServerId(serverId) });
  }
}

export const logger = new Logger();
```

#### 2. Replace Direct Console Logging in `client/handler.ts`

**Before**:
```typescript
console.log(`[ClientHandler] Registered pairing code: ${pairingCode}`);
```

**After**:
```typescript
logger.pairingEvent('registered', { code: pairingCode });
// In production: outputs "[DEBUG] [Pairing] registered {"code":"A****Z"}"
// In development: outputs full code for debugging
```

#### 3. Environment-Based Log Configuration

Add to server configuration:

```typescript
// config.ts
export interface LogConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  redactSensitive: boolean;
  format: 'json' | 'text';
}

export const defaultLogConfig: LogConfig = {
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  redactSensitive: process.env.NODE_ENV === 'production',
  format: process.env.NODE_ENV === 'production' ? 'json' : 'text',
};
```

### Medium Priority Actions

#### 4. Use Request IDs Instead of Pairing Codes

For log correlation, generate ephemeral request IDs that don't expose pairing codes:

```typescript
// Instead of logging pairing codes for correlation
const requestId = logger.generateRequestId();
logger.debug(`[Pairing] request initiated`, { requestId });
// ... later in the flow
logger.debug(`[Pairing] request completed`, { requestId });
```

#### 5. Implement Audit Logging Separately

For security audit purposes, create a separate audit log that:
- Is stored securely with access controls
- Has configurable retention policies
- Does not go to stdout/stderr (use file or secure logging service)

```typescript
// audit-logger.ts
class AuditLogger {
  private async writeAuditEvent(event: AuditEvent): Promise<void> {
    // Write to secure storage only, not console
    await this.storage.writeAuditLog(event);
  }

  async logPairingAttempt(requesterId: string, targetId: string): Promise<void> {
    await this.writeAuditEvent({
      type: 'pairing_attempt',
      timestamp: Date.now(),
      // Store hashes, not plaintext codes
      requesterHash: this.hashCode(requesterId),
      targetHash: this.hashCode(targetId),
    });
  }
}
```

### Low Priority Actions

#### 6. Client-Side Logging Review

The web client logging is already relatively safe, but consider:
- Removing file names from rejection logs in production
- Adding a build-time strip of `console.log` for production builds

```typescript
// In production builds, replace console.log with no-op
// webpack/vite config:
if (process.env.NODE_ENV === 'production') {
  config.plugins.push(
    new webpack.DefinePlugin({
      'console.log': '(() => {})',
    })
  );
}
```

---

## Implementation Checklist

- [x] Create `packages/server-vps/src/utils/logger.ts` with structured logger
- [x] Add log configuration to server config (via NODE_ENV, LOG_LEVEL, REDACT_LOGS env vars)
- [x] Replace all `console.log` in `client/handler.ts` with structured logger
- [x] Replace IP address logging in `index.ts` with redacted versions
- [x] Replace server ID logging in federation modules with redacted versions
- [x] Add `LOG_LEVEL` environment variable support
- [x] Create logger for Cloudflare Workers (`packages/server/src/logger.js`)
- [x] Update `packages/server/src/signaling-room.js` to use logger
- [ ] Update deployment documentation with logging configuration
- [ ] Consider separate audit log for compliance requirements
- [ ] Add production build step to strip verbose client-side logging

---

## Files Requiring Changes

### High Priority
1. `/home/meywd/zajel/packages/server-vps/src/client/handler.ts` - 8 logging statements exposing pairing codes

### Medium Priority
2. `/home/meywd/zajel/packages/server-vps/src/index.ts` - IP address and server identity logging
3. `/home/meywd/zajel/packages/server-vps/src/federation/federation-manager.ts` - Server ID logging
4. `/home/meywd/zajel/packages/server-vps/src/federation/bootstrap-client.ts` - Registration result logging

### Low Priority (Optional)
5. `/home/meywd/zajel/packages/web-client/src/App.tsx` - File name in rejection logs
6. Other federation transport and gossip files - Error logging review

---

## Summary Statistics

| Category | Count |
|----------|-------|
| **Total console statements found** | 54 |
| **High risk (pairing codes exposed)** | 8 |
| **Medium risk (IPs, server IDs)** | 9 |
| **Low risk (operational/errors)** | 37 |

---

## Research: How Other Apps Solve This

This section documents logging practices from secure messaging applications and industry standards to inform our implementation.

### Signal: The Gold Standard

Signal is widely considered the gold standard for secure messaging privacy. Their approach to logging is fundamentally minimalist:

**What Signal Does NOT Log:**
- Message content (end-to-end encrypted, never accessible to servers)
- Metadata about communications (who talks to whom)
- Display names or profile pictures
- Contact lists or social graphs
- Message timestamps beyond delivery

**What Minimal Data Signal Retains:**
- Phone number (required for registration)
- Account creation date
- Last connection timestamp (only this is provided to law enforcement with valid warrants)

**Key Design Principles:**
- Messages are stored only on user devices, not servers
- Messages queued for offline delivery are encrypted and deleted after delivery
- "If you show up with a warrant or a subpoena (to Signal), they have almost nothing about you that they can hand over" - Eva Galperin, EFF

**Technical Implementation:**
- Signal's libsignal library allows debug-level logs only when explicitly enabled via `-P debugLevelLogs` flag
- Production builds filter out debug and verbose-level Rust logs by default
- Intel SGX provides remote attestation that server code is trusted and unmodified

Sources: [Signal Privacy Policy](https://signal.org/legal/), [Signal GDPR Support](https://support.signal.org/hc/en-us/articles/360007059412-Signal-and-the-General-Data-Protection-Regulation-GDPR), [Mozilla Signal Review](https://www.mozillafoundation.org/en/nothing-personal/signal-privacy-review/), [Signal GitHub](https://github.com/signalapp)

---

### Telegram: What NOT to Do

Telegram serves as a cautionary example of how closed-source servers and metadata logging create privacy risks:

**What Telegram Logs (and Retains up to 12 months):**
- IP addresses
- Message timestamps
- Device and connection metadata
- Login timestamps
- Associated sessions and activity footprints
- Usernames

**Privacy Concerns:**
- Server-side code is closed source - no independent verification of logging practices
- Regular "cloud chats" are NOT end-to-end encrypted (server holds keys)
- In 2024, ~900 US law enforcement requests fulfilled affecting 2,253 users
- Metadata can be provided to authorities: phone numbers, IP addresses, device info

**The Lesson for Zajel:**
- Open-source server code allows security verification
- End-to-end encryption alone is not enough if metadata is logged
- Avoid storing any data that could be used for user correlation

Sources: [Telegram Privacy Policy](https://telegram.org/privacy), [ESET Telegram Privacy](https://www.eset.com/blog/en/home-topics/privacy-and-identity-protection/telegram-privacy-explained/), [IEEE Spectrum Telegram Security](https://spectrum.ieee.org/telegram-security)

---

### WhatsApp: Metadata is the Problem

WhatsApp demonstrates that even with end-to-end encryption, extensive metadata logging undermines privacy:

**What WhatsApp Logs:**
- Time, frequency, and duration of activities
- Network details, browser, ISP, device identifiers
- IP addresses (can estimate location)
- Profile information (name, photo, "about")
- Usage patterns and interaction data

**Retention:** Log and troubleshooting data normally deleted after 90 days, but can be retained longer for investigations.

**Law Enforcement:** In 2024, Meta disclosed data in response to over 78% of law enforcement requests involving WhatsApp.

**Key Takeaway:** "WhatsApp encryption isn't the problem, metadata is" - The extensive metadata collection allows user tracking despite message encryption.

Sources: [WhatsApp Privacy Policy](https://www.whatsapp.com/legal/privacy-policy), [TechRadar WhatsApp Metadata](https://www.techradar.com/computing/cyber-security/whatsapp-encryption-isnt-the-problem-metadata-is)

---

### Element/Matrix: Federated Logging Challenges

Matrix-based systems like Element face unique logging challenges due to federation:

**Current Practices:**
- IP addresses logged for all service access
- Username, user IP, and user agent logged
- Logs retained for up to 180 days
- "Users should have no expectation of absolute privacy on the public Matrix Network"

**Federated Risks:**
- Malicious actors can spin up rogue homeservers
- Metadata harvesting across federation
- Structural metadata leaks even with E2EE content

**Mitigation:** Self-hosted and air-gapped deployments recommended for sensitive use cases.

Sources: [Matrix Privacy Notice](https://matrix.org/legal/privacy-notice/), [Wire on Matrix Privacy](https://wire.com/en/blog/matrix-not-safe-eu-data-privacy)

---

### OWASP Guidelines

The OWASP Logging Cheat Sheet provides authoritative guidance on what to log securely:

**Data That Should NEVER Be Logged:**
- Passwords (even hashed versions in debug logs)
- Session IDs and authentication tokens
- Credit card numbers and financial data
- Social Security Numbers and government IDs
- Health records and medical information
- Biometric data
- Private cryptographic keys
- Data users have opted out of collection

**Sensitive Data Requiring Careful Handling:**
- Personal names, email addresses, phone numbers
- IP addresses (considered PII under GDPR/ECJ ruling)
- Location data and GPS coordinates
- User preferences and behavior patterns

**Recommended Techniques:**
- Data de-identification: deletion, scrambling, pseudonymization
- Sanitization post-collection, prior to display
- Encode data correctly for the output format
- Sanitize all event data to prevent log injection attacks

**Log Protection Requirements:**
- Protect from tampering in transit
- Control unauthorized access, modification, deletion
- Forward to central, secure logging service
- Implement access controls and audit logging

**OWASP Top 10:2025 - A09 Security Logging Failures:**
- CWE-117: Improper Output Neutralization for Logs
- CWE-532: Insertion of Sensitive Information into Log File
- CWE-778: Insufficient Logging

Sources: [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), [OWASP Top 10:2025](https://owasp.org/Top10/2025/A09_2025-Security_Logging_and_Alerting_Failures/)

---

### GDPR/Privacy Requirements

European privacy law has specific implications for logging:

**IP Addresses Are Personal Data:**
- European Court of Justice ruled that IP addresses qualify as personal data when an organization can link them to individuals
- Dynamic IP addresses count when combinable with other information

**Data That Should NOT Be Logged:**
- Interpersonal communication content
- Special categories: racial/ethnic origin, political opinions, health data
- Data users have opted out of or not consented to

**Key Principles:**
1. **Data Minimization:** Collect only what's necessary
2. **Purpose Limitation:** Use log data only for stated purposes
3. **Storage Limitation:** Define and enforce retention periods
4. **Security:** Implement encryption and access controls
5. **Accountability:** Document who accessed logs and when

**Anonymization vs Pseudonymization:**
- **Anonymization:** Permanently transforms data so individuals cannot be identified; falls outside GDPR scope
- **Pseudonymization:** Replaces identifiers with aliases (reversible); still subject to GDPR but with reduced obligations

**Penalties:** Up to 4% of global annual turnover or EUR 20 million for violations.

Sources: [Last9 GDPR Log Management](https://last9.io/blog/gdpr-log-management/), [Sematext GDPR Logging](https://sematext.com/blog/gdpr-top-5-logging-best-practices/)

---

### Production Log Sanitization Patterns

Industry best practices for keeping sensitive data out of logs:

**Pattern 1: Domain Primitives (Secure by Design)**
```typescript
class SensitiveString {
  private value: string;

  constructor(value: string) {
    this.value = value;
  }

  // Prevent accidental logging
  toString(): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  // Explicit access required
  unsafeGetValue(): string {
    return this.value;
  }
}
```

**Pattern 2: Read-Once Objects**
```typescript
class SecretValue {
  private value: string | null;
  private consumed = false;

  read(): string {
    if (this.consumed) throw new Error('Secret already consumed');
    this.consumed = true;
    const val = this.value!;
    this.value = null; // Clear from memory
    return val;
  }
}
```

**Pattern 3: Log Formatters (Last Line of Defense)**
```typescript
const sensitivePatterns = [
  { pattern: /\b[A-Z0-9]{6}\b/g, label: 'PAIRING_CODE' },  // 6-char codes
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, label: 'IP' },
  { pattern: /Bearer [A-Za-z0-9\-._~+\/]+=*/g, label: 'TOKEN' },
];

function sanitizeLogMessage(message: string): string {
  let result = message;
  for (const { pattern, label } of sensitivePatterns) {
    result = result.replace(pattern, `[${label}_REDACTED]`);
  }
  return result;
}
```

**Pattern 4: Hashing for Cardinality**
When you need to preserve grouping/analysis without exposing values:
```typescript
import { createHash } from 'crypto';

function hashForLogging(value: string): string {
  return createHash('sha256')
    .update(value + process.env.LOG_SALT)
    .digest('hex')
    .substring(0, 8);
}

// Usage: logger.info('Pairing', { codeHash: hashForLogging(pairingCode) });
```

**Pattern 5: Partial Redaction**
```typescript
function partialRedact(value: string, visibleChars: number = 2): string {
  if (value.length <= visibleChars * 2) return '***';
  return `${value.slice(0, visibleChars)}***${value.slice(-visibleChars)}`;
}
// "ABC123" -> "AB***23"
```

Sources: [GitGuardian Secrets in Logs](https://blog.gitguardian.com/keeping-secrets-out-of-logs/), [Skyflow Sensitive Data](https://www.skyflow.com/post/how-to-keep-sensitive-data-out-of-your-logs-nine-best-practices), [BetterStack Logging Guide](https://betterstack.com/community/guides/logging/sensitive-data/)

---

### Log Levels: Debug vs Production

Standard hierarchy and security implications:

| Level | Purpose | Production Use | Sensitive Data Risk |
|-------|---------|----------------|---------------------|
| TRACE | Finest execution details | NEVER | CRITICAL |
| DEBUG | Development diagnostics | NEVER | HIGH |
| INFO | Normal operations | Selective | MEDIUM |
| WARN | Potential issues | Yes | LOW |
| ERROR | Operation failures | Yes | LOW |
| FATAL | Critical failures | Yes | LOW |

**Key Guidelines:**
- **Production default:** INFO or WARN level only
- **DEBUG/TRACE:** Development only, never in production builds
- **Sensitive data:** Should never appear at ANY log level
- **Error messages:** Include error types, not sensitive context

**Build-Time Stripping:**
```typescript
// Production builds should strip debug logs entirely
if (process.env.NODE_ENV === 'production') {
  console.debug = () => {};
  console.trace = () => {};
}
```

Sources: [Edge Delta Log Levels](https://edgedelta.com/company/blog/log-debug-vs-info-vs-warn-vs-error-and-fatal), [BetterStack Log Levels](https://betterstack.com/community/guides/logging/log-levels-explained/)

---

### CWE-532: Prevention Strategies

The Common Weakness Enumeration specifically addresses sensitive information in logs:

**Definition:** "The product writes sensitive information to a log file."

**What Gets Exposed:**
- Return values of password functions (getpw, getpwnam)
- Input values to authentication functions
- Full path names and system information
- Session tokens and authentication credentials

**Prevention Checklist:**
1. Never log secrets, tokens, or passwords
2. Never log full request/response bodies
3. Remove debug logs before production deployment
4. Set restrictive file permissions on log files
5. Obfuscate sensitive data if logging is required
6. Implement RBAC for log access
7. Use structured logging to control field exposure
8. Audit log contents regularly

Sources: [CWE-532 Official](https://cwe.mitre.org/data/definitions/532.html)

---

### Recommended Implementation for Zajel

Based on this research, here's a prioritized approach:

**1. Immediate (Signal-like minimalism):**
- Remove ALL pairing code logging in production
- Hash pairing codes if correlation is needed: `hash(code + salt).substring(0,8)`
- Redact IP addresses to first octet only: `192.***.***.***`
- Use request IDs instead of user identifiers for correlation

**2. Short-term (OWASP compliance):**
- Implement structured logger with automatic sanitization
- Set production log level to INFO/WARN only
- Strip DEBUG/TRACE from production builds
- Add log injection prevention (sanitize newlines, delimiters)

**3. Medium-term (GDPR compliance):**
- Define retention policy (recommend 30-90 days max)
- Implement pseudonymization for any logged identifiers
- Add audit logging for log access
- Document legitimate interest for any logged data

**4. Long-term (Defense in depth):**
- Domain primitives for sensitive values
- CI/CD secret scanning for log statements
- Regular log content audits
- Consider differential privacy for analytics

---

## References

- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- CWE-532: Insertion of Sensitive Information into Log File: https://cwe.mitre.org/data/definitions/532.html
- GDPR Article 25: Data Protection by Design and by Default
- Signal Privacy Policy: https://signal.org/legal/
- GitGuardian - Keeping Secrets Out of Logs: https://blog.gitguardian.com/keeping-secrets-out-of-logs/
- OWASP Top 10:2025 A09: https://owasp.org/Top10/2025/A09_2025-Security_Logging_and_Alerting_Failures/
