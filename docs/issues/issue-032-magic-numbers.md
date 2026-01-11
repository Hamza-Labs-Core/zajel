# Issue #32: Magic Numbers Analysis

## Overview

This document analyzes magic numbers and hardcoded constants scattered across the codebase and proposes a centralized constants structure.

---

## Inventory of Magic Numbers

### 1. packages/web-client/src/App.tsx

| Line | Constant | Value | Category | Description |
|------|----------|-------|----------|-------------|
| 23 | `CHUNK_SIZE` | `16 * 1024` (16KB) | Size | File chunk size for transfers |
| 24 | `MAX_MESSAGES` | `1000` | Limit | Maximum messages kept in memory |
| 25 | `MAX_TRANSFERS` | `100` | Limit | Maximum file transfers in memory |
| 26 | `MAX_FILE_SIZE` | `100 * 1024 * 1024` (100MB) | Size | Maximum incoming file size |
| 397 | (inline) | `10` | Timeout | Delay between chunk sends (ms) |

### 2. packages/web-client/src/lib/crypto.ts

| Line | Constant | Value | Category | Description |
|------|----------|-------|----------|-------------|
| 7 | `NONCE_SIZE` | `12` | Crypto | ChaCha20-Poly1305 nonce size |
| 23 | `SEQUENCE_WINDOW` | `64` | Crypto | Replay protection sliding window size |
| 32 | (inline) | `32` | Crypto | X25519 public key length validation |
| 92-93 | (inline) | `32` | Crypto | X25519 key length validation (multiple) |
| 124 | (inline) | `32` | Crypto | X25519 key length validation |
| 4 | (inline) | `4` | Protocol | Sequence number byte size (multiple occurrences) |

### 3. packages/web-client/src/lib/signaling.ts

| Line | Constant | Value | Category | Description |
|------|----------|-------|----------|-------------|
| 7 | `PING_INTERVAL` | `25000` (25s) | Timeout | Keepalive ping interval |
| 8 | `RECONNECT_DELAY_BASE` | `1000` (1s) | Timeout | Base reconnect delay |
| 9 | `RECONNECT_DELAY_MAX` | `30000` (30s) | Timeout | Max reconnect delay |
| 10 | `PAIRING_CODE_CHARS` | `'ABCDEF...'` | Protocol | Allowed pairing code characters |
| 11 | `PAIRING_CODE_LENGTH` | `6` | Protocol | Pairing code length |
| 13 | `MAX_MESSAGE_SIZE` | `1024 * 1024` (1MB) | Size | Maximum WebSocket message size |
| 54 | (inline) | `6` | Protocol | Random bytes for code generation |

### 4. packages/web-client/src/lib/webrtc.ts

| Line | Constant | Value | Category | Description |
|------|----------|-------|----------|-------------|
| 4-7 | `ICE_SERVERS` | STUN URLs | Network | WebRTC STUN server configuration |
| 9 | `MESSAGE_CHANNEL` | `'messages'` | Protocol | Data channel name for messages |
| 10 | `FILE_CHANNEL` | `'files'` | Protocol | Data channel name for files |
| 11 | `MAX_DATA_CHANNEL_MESSAGE_SIZE` | `1024 * 1024` (1MB) | Size | Max data channel message size |
| 12 | `MAX_PENDING_ICE_CANDIDATES` | `100` | Limit | Max queued ICE candidates |

### 5. packages/server-vps/src/client/handler.ts

| Line | Constant | Value | Category | Description |
|------|----------|-------|----------|-------------|
| 153 | `PAIR_REQUEST_TIMEOUT` | `60000` (60s) | Timeout | Pairing request expiration |
| 154 | `MAX_PENDING_REQUESTS_PER_TARGET` | `10` | Limit | DoS protection limit |
| 161 | `RATE_LIMIT_WINDOW_MS` | `60000` (1min) | Timeout | Rate limit window |
| 162 | `RATE_LIMIT_MAX_MESSAGES` | `100` | Limit | Max messages per window |
| 321 | (inline) | `20` | Limit | Default max connections |
| 351 | (inline) | `10` | Limit | Default relay count |
| 444 | (inline) | `10` | Limit | Default relay count for get_relays |
| 502-506 | (inline) | `32` | Crypto | X25519 public key length validation |
| 495 | (inline) | Base64 regex | Validation | Public key format validation |

---

## Categorized Summary

### Timeouts (ms)
| Constant | Value | File | Purpose |
|----------|-------|------|---------|
| `PING_INTERVAL` | 25,000 | signaling.ts | Keepalive |
| `RECONNECT_DELAY_BASE` | 1,000 | signaling.ts | Reconnect base |
| `RECONNECT_DELAY_MAX` | 30,000 | signaling.ts | Reconnect cap |
| `PAIR_REQUEST_TIMEOUT` | 60,000 | handler.ts | Pairing expiry |
| `RATE_LIMIT_WINDOW_MS` | 60,000 | handler.ts | Rate limit window |
| Chunk send delay | 10 | App.tsx | Throttling |

### Sizes (bytes)
| Constant | Value | File | Purpose |
|----------|-------|------|---------|
| `CHUNK_SIZE` | 16KB | App.tsx | File chunking |
| `MAX_FILE_SIZE` | 100MB | App.tsx | Incoming file limit |
| `MAX_MESSAGE_SIZE` | 1MB | signaling.ts | WebSocket message limit |
| `MAX_DATA_CHANNEL_MESSAGE_SIZE` | 1MB | webrtc.ts | DataChannel limit |
| `NONCE_SIZE` | 12 | crypto.ts | ChaCha20 nonce |

### Limits (counts)
| Constant | Value | File | Purpose |
|----------|-------|------|---------|
| `MAX_MESSAGES` | 1,000 | App.tsx | Memory management |
| `MAX_TRANSFERS` | 100 | App.tsx | Memory management |
| `MAX_PENDING_ICE_CANDIDATES` | 100 | webrtc.ts | Queue limit |
| `MAX_PENDING_REQUESTS_PER_TARGET` | 10 | handler.ts | DoS protection |
| `RATE_LIMIT_MAX_MESSAGES` | 100 | handler.ts | Rate limiting |
| `SEQUENCE_WINDOW` | 64 | crypto.ts | Replay protection |

### Crypto Constants
| Constant | Value | File | Purpose |
|----------|-------|------|---------|
| `NONCE_SIZE` | 12 | crypto.ts | ChaCha20-Poly1305 |
| `SEQUENCE_WINDOW` | 64 | crypto.ts | Replay protection |
| X25519 key length | 32 | multiple | Key validation |
| Sequence number bytes | 4 | crypto.ts | Protocol |

### Protocol Constants
| Constant | Value | File | Purpose |
|----------|-------|------|---------|
| `PAIRING_CODE_LENGTH` | 6 | signaling.ts | Code format |
| `PAIRING_CODE_CHARS` | charset | signaling.ts | Code format |
| `MESSAGE_CHANNEL` | 'messages' | webrtc.ts | Channel name |
| `FILE_CHANNEL` | 'files' | webrtc.ts | Channel name |

### Network Configuration
| Constant | Value | File | Purpose |
|----------|-------|------|---------|
| `ICE_SERVERS` | STUN URLs | webrtc.ts | WebRTC connectivity |

---

## Proposed Constants Structure

### packages/web-client/src/lib/constants.ts

```typescript
/**
 * Centralized constants for the Zajel web client
 */

// =============================================================================
// CRYPTO CONSTANTS
// =============================================================================

export const CRYPTO = {
  /** ChaCha20-Poly1305 nonce size in bytes */
  NONCE_SIZE: 12,

  /** X25519 public key size in bytes */
  X25519_KEY_SIZE: 32,

  /** Sequence number size for replay protection */
  SEQUENCE_NUMBER_SIZE: 4,

  /** Sliding window size for out-of-order message tolerance */
  SEQUENCE_WINDOW: 64,
} as const;

// =============================================================================
// FILE TRANSFER CONSTANTS
// =============================================================================

export const FILE_TRANSFER = {
  /** Chunk size for file transfers (16KB) */
  CHUNK_SIZE: 16 * 1024,

  /** Maximum file size for incoming files (100MB) */
  MAX_FILE_SIZE: 100 * 1024 * 1024,

  /** Maximum concurrent file transfers to track */
  MAX_TRANSFERS: 100,

  /** Delay between sending file chunks to prevent overwhelming (ms) */
  CHUNK_SEND_DELAY_MS: 10,
} as const;

// =============================================================================
// MESSAGE LIMITS
// =============================================================================

export const MESSAGE_LIMITS = {
  /** Maximum messages to keep in memory */
  MAX_MESSAGES: 1000,

  /** Maximum WebSocket message size (1MB) */
  MAX_WEBSOCKET_MESSAGE_SIZE: 1024 * 1024,

  /** Maximum data channel message size (1MB) */
  MAX_DATA_CHANNEL_MESSAGE_SIZE: 1024 * 1024,
} as const;

// =============================================================================
// SIGNALING TIMEOUTS
// =============================================================================

export const TIMEOUTS = {
  /** Ping interval for WebSocket keepalive (ms) */
  PING_INTERVAL_MS: 25000,

  /** Base delay for reconnection attempts (ms) */
  RECONNECT_DELAY_BASE_MS: 1000,

  /** Maximum delay for reconnection attempts (ms) */
  RECONNECT_DELAY_MAX_MS: 30000,
} as const;

// =============================================================================
// PAIRING CODE CONFIGURATION
// =============================================================================

export const PAIRING_CODE = {
  /** Allowed characters (excludes ambiguous: 0, 1, I, O) */
  CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',

  /** Length of pairing code */
  LENGTH: 6,

  /** Number of random bytes to generate */
  RANDOM_BYTES: 6,
} as const;

// Computed regex for pairing code validation
export const PAIRING_CODE_REGEX = new RegExp(
  `^[${PAIRING_CODE.CHARS}]{${PAIRING_CODE.LENGTH}}$`
);

// =============================================================================
// WEBRTC CONFIGURATION
// =============================================================================

export const WEBRTC = {
  /** STUN servers for NAT traversal */
  ICE_SERVERS: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun1.l.google.com:19302' },
  ] as RTCIceServer[],

  /** Maximum pending ICE candidates in queue */
  MAX_PENDING_ICE_CANDIDATES: 100,

  /** Data channel names */
  CHANNELS: {
    MESSAGES: 'messages',
    FILES: 'files',
  },
} as const;
```

### packages/server-vps/src/constants.ts

```typescript
/**
 * Centralized constants for the Zajel VPS server
 */

// =============================================================================
// RATE LIMITING
// =============================================================================

export const RATE_LIMIT = {
  /** Time window for rate limiting (ms) */
  WINDOW_MS: 60000,

  /** Maximum messages per rate limit window */
  MAX_MESSAGES: 100,
} as const;

// =============================================================================
// PAIRING
// =============================================================================

export const PAIRING = {
  /** Pairing request timeout (ms) */
  REQUEST_TIMEOUT_MS: 60000,

  /** Maximum pending pair requests per target (DoS protection) */
  MAX_PENDING_REQUESTS_PER_TARGET: 10,
} as const;

// =============================================================================
// CONNECTIONS
// =============================================================================

export const CONNECTIONS = {
  /** Default maximum connections per peer */
  DEFAULT_MAX_CONNECTIONS: 20,

  /** Default relay count for queries */
  DEFAULT_RELAY_COUNT: 10,
} as const;

// =============================================================================
// CRYPTO VALIDATION
// =============================================================================

export const CRYPTO = {
  /** X25519 public key size in bytes */
  X25519_KEY_SIZE: 32,

  /** Base64 validation regex */
  BASE64_REGEX: /^[A-Za-z0-9+/]+=*$/,
} as const;
```

---

## Implementation Recommendations

### 1. Create Shared Package (Optional)
If constants are shared between web-client and server-vps, consider:
```
packages/shared/src/constants.ts
```

### 2. Migration Strategy
1. Create constant files in each package
2. Update imports one file at a time
3. Add deprecation comments to inline constants during transition
4. Run tests after each file migration
5. Remove deprecated inline constants

### 3. Priority Order
1. **High**: Security-related constants (crypto, rate limits)
2. **Medium**: Size limits (file, message)
3. **Low**: Protocol constants (channel names, pairing code format)

### 4. Testing Considerations
- Ensure constants are immutable (`as const`)
- Add unit tests to verify constant values match expected behavior
- Consider environment-based overrides for certain values (e.g., timeouts for testing)

---

## Related Issues

- Consider adding environment variable support for configurable values
- Some timeouts may need tuning based on production metrics
- ICE_SERVERS could be configurable via environment for self-hosted deployments

---

## Research: How Other Apps Solve This

This section documents how well-architected messaging apps organize constants and configuration, based on research of Signal, Telegram, Matrix SDK, and industry best practices.

### 1. Signal Android/iOS

Signal uses a multi-layered approach to configuration management:

#### Build-Time Constants
- **`constants.gradle.kts`**: Centralized Gradle file containing SDK versions, build tools versions, and compile-time configuration
- **`BuildConfig`**: Auto-generated class with build-specific constants (debug flags, version info)

#### Feature Flags
- **`RemoteConfig.kt`** (formerly `FeatureFlags.kt`): Manages feature toggles that can be enabled/disabled
- Remote configuration allows server-driven feature rollouts without app updates

#### Crypto Constants
Signal's [libsignal](https://github.com/signalapp/libsignal) library organizes cryptographic primitives into dedicated modules:
- **`libsignal-protocol`**: Signal Protocol implementation (Double Ratchet algorithm)
- **`signal-crypto`**: Low-level crypto primitives (AES-GCM, etc.)
- Constants are defined within the context of their cryptographic algorithm

#### Secure Storage (iOS)
- **`SSKKeychainStorage.swift`**: Keychain wrapper for sensitive configuration
- Uses accessibility levels like `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly` for maximum security
- Property wrapper patterns (`@AppSecureStorage`) for declarative secure storage

**Key Patterns:**
- Separation of build-time vs runtime constants
- Crypto constants live with their algorithms
- Security-sensitive values stored in platform secure storage
- Remote configuration for feature flags

**Source:** [Signal Android Wiki - Code Style Guidelines](https://github.com/signalapp/Signal-Android/wiki/Code-Style-Guidelines)

---

### 2. Telegram

Telegram uses a hierarchical configuration approach:

#### BuildVars.java (Android)
Central configuration file organized by category:

```java
// Core Debug Flags
public static boolean DEBUG_VERSION = false;
public static boolean LOGS_ENABLED = false;

// Platform Identifiers
public static int APP_ID = 4;
public static String APP_HASH = "...";

// Service Integration
public static String SAFETYNET_KEY = "...";
public static String PLAYSTORE_APP_URL = "...";

// Billing Configuration
public static boolean IS_BILLING_UNAVAILABLE = false;
```

**Documentation Pattern:** Inline comments explain purpose, especially for fork-sensitive values: "works only on official app ids, disable on your forks"

#### Client Configuration API
Telegram's [help.getAppConfig](https://core.telegram.org/api/config) returns runtime configuration:

| Category | Examples |
|----------|----------|
| **Timeouts** | `online_update_period_ms`, `offline_blur_timeout_ms`, `notify_cloud_delay_ms` |
| **Size Limits** | Caption length (1024 default, 4096 premium), file parts (4000/8000) |
| **Count Limits** | Channels (500/1000), public channels (10/20) |
| **Feature Flags** | Boolean flags for conditional feature activation |
| **Domain Whitelists** | `url_auth_domains`, `autologin_domains`, `whitelisted_domains` |

**Tiered Limits Pattern:**
```
Default users: 500 channels, 10 public channels, 4000 file parts
Premium users: 1000 channels, 20 public channels, 8000 file parts
```

#### MTProto Configuration
- **`MTContext`**: Manages data center selection and connection policies
- Constants defined at protocol level with clear separation from app-level config
- Configuration includes fallback default values

**Key Patterns:**
- Centralized BuildVars for build-time config
- Server-driven runtime configuration via API
- Tiered limits based on subscription level
- Protocol-level constants separate from app config
- Explicit documentation for fork maintainers

**Source:** [Telegram API - Client Configuration](https://core.telegram.org/api/config), [DrKLO/Telegram GitHub](https://github.com/DrKLO/Telegram)

---

### 3. Matrix SDK (matrix-js-sdk)

The [Matrix JS SDK](https://github.com/matrix-org/matrix-js-sdk) organizes configuration by functional area:

#### Entry Points Architecture
- **Primary entry point**: High-level functionality
- **Crypto entry point**: Cryptography-specific exports
- **Low-level types**: Data structures matching Matrix spec
- **Test utilities**: Testing-specific configuration

#### Organization Approach
Originally followed Atomic Design pattern but evolved to functional grouping:
- **Structures**: Stateful components with business logic
- **Views**: Stateless presentation components
- Configuration constants defined within their functional context

#### Crypto Constants
- Algorithm-specific constants (MEGOLM_ALGORITHM, etc.)
- Key management constants defined in `src/crypto/` modules
- Device identity and session constants

**Key Patterns:**
- Functional grouping over atomic design
- Constants defined near their usage context
- Multiple entry points for different use cases
- Clear separation of crypto from general SDK

**Source:** [matrix-js-sdk GitHub](https://github.com/matrix-org/matrix-js-sdk)

---

### 4. TypeScript Best Practices

#### Const Assertions (`as const`)

```typescript
export const CRYPTO = {
  NONCE_SIZE: 12,
  X25519_KEY_SIZE: 32,
  SEQUENCE_WINDOW: 64,
} as const;
```

**Benefits:**
- Compile-time immutability
- Literal type inference (not just `number` but `12`)
- Zero runtime overhead
- Enables type narrowing

#### Const Enums vs Regular Enums

| Feature | `const enum` | Regular `enum` | `as const` Object |
|---------|--------------|----------------|-------------------|
| Runtime object | No | Yes | Yes |
| Bundle size | Smallest | Larger | Medium |
| Runtime validation | No | Yes | Yes |
| Iteration | No | Yes | Yes |
| Reverse mapping | No | Yes (numeric) | No |

**Recommendation:** Use `as const` objects for configuration, regular enums only when runtime iteration is needed.

#### Environment Variable Validation with Zod

```typescript
import { z } from 'zod';

const envSchema = z.object({
  API_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  DEBUG: z.coerce.boolean().default(false),
  SECRET_KEY: z.string().min(32),
});

export const env = envSchema.parse(process.env);
```

**Benefits:**
- Fail-fast on missing/invalid config
- Type-safe access throughout codebase
- Default values and coercion
- Clear error messages in CI/CD

#### Runtime vs Compile-Time Constants

| Type | Compile-Time | Runtime |
|------|--------------|---------|
| TypeScript `readonly` | Type-checked | Not enforced |
| `as const` | Type narrowing | Mutable at runtime |
| `Object.freeze()` | No effect | Truly immutable |
| Const enums | Inlined | N/A |

**Recommendation:** Use `Object.freeze()` for critical constants if runtime immutability is required:

```typescript
export const CRYPTO = Object.freeze({
  NONCE_SIZE: 12,
  X25519_KEY_SIZE: 32,
} as const);
```

**Sources:**
- [TypeScript Handbook - Enums](https://www.typescriptlang.org/docs/handbook/enums.html)
- [TypeScript Enum Patterns (2ality)](https://2ality.com/2025/01/typescript-enum-patterns.html)
- [Compile-time Immutability in TypeScript (SitePoint)](https://www.sitepoint.com/compile-time-immutability-in-typescript/)

---

### 5. Dart/Flutter Conventions

#### Naming Convention
Dart's [Effective Dart](https://dart.dev/effective-dart) guidelines recommend **lowerCamelCase** for constants:

```dart
// Preferred
const defaultTimeout = Duration(seconds: 30);
const maxRetries = 3;

// Legacy (still acceptable in existing codebases)
const DEFAULT_TIMEOUT = Duration(seconds: 30);
```

**Rationale:** Constants often change to final non-const variables; lowerCamelCase prevents name changes.

#### Organization Approaches

**1. Top-Level Constants File:**
```dart
// lib/constants.dart
const chunkSize = 16 * 1024;
const maxFileSize = 100 * 1024 * 1024;
const pingIntervalMs = 25000;
```

**2. Grouped in Classes:**
```dart
class CryptoConstants {
  static const nonceSize = 12;
  static const x25519KeySize = 32;
  static const sequenceWindow = 64;
}

class TimeoutConstants {
  static const pingInterval = Duration(seconds: 25);
  static const reconnectBase = Duration(seconds: 1);
  static const reconnectMax = Duration(seconds: 30);
}
```

**3. Modular Files (Large Projects):**
```
lib/constants/
  crypto_constants.dart
  timeout_constants.dart
  size_constants.dart
  protocol_constants.dart
```

#### Const Widgets for Performance

```dart
// Constant widgets are created once and reused
const MyWidget = Text('Hello');
```

**Key Patterns:**
- lowerCamelCase naming convention
- Top-level constants for simple cases
- Class grouping for related constants
- Modular files for large projects
- Const constructors for performance

**Sources:**
- [Effective Dart - Style](https://dart.dev/effective-dart/style)
- [Best Practices for Managing Constants in Flutter](https://www.repeato.app/best-practices-for-managing-constants-in-flutter/)

---

### 6. React Native / Mobile App Patterns

#### Environment-Specific Configuration

Using `react-native-config`:

```
.env.development
.env.staging
.env.production
```

```typescript
import Config from 'react-native-config';

const API_URL = Config.API_URL;
const DEBUG = Config.DEBUG === 'true';
```

**Benefits:**
- Native code access (AndroidManifest.xml, Info.plist)
- Build variant integration
- No sensitive data in source control

#### Configuration Validation

```typescript
// config/env.ts
import { z } from 'zod';
import Config from 'react-native-config';

const envSchema = z.object({
  API_URL: z.string().url(),
  STUN_SERVER: z.string(),
  MAX_FILE_SIZE_MB: z.coerce.number().positive(),
});

export const env = envSchema.parse(Config);
```

**Sources:**
- [react-native-config GitHub](https://github.com/lugg/react-native-config)
- [Expo Environment Variables](https://docs.expo.dev/guides/environment-variables/)

---

### 7. Centralized Configuration Anti-Patterns to Avoid

#### Over-Centralization

> "Magic numbers are not magic if used in a very narrow scope. Files with constants are like glue for independent features - code hotspots." - [Stop Creating Constants (Medium)](https://medium.com/codex/when-magic-numbers-are-not-magic-fcdf034295a5)

**When NOT to centralize:**
- Implementation details used in one place
- Values that never change and are self-documenting (e.g., `Math.PI`)
- Constants that create unnecessary coupling between modules

#### When Centralization IS Appropriate

| Centralize | Keep Local |
|------------|------------|
| Security constants (crypto params) | One-off magic numbers |
| Shared protocol values | Module-internal constants |
| Configurable values (env-based) | Self-documenting values |
| API contract constants | Implementation details |

---

### 8. Recommended Architecture for Zajel

Based on this research, here is the recommended constant organization:

#### Tier 1: Shared Constants (Protocol-Level)
```
packages/shared/src/
  constants/
    crypto.ts      # X25519_KEY_SIZE, NONCE_SIZE, etc.
    protocol.ts    # PAIRING_CODE_LENGTH, channel names
```

#### Tier 2: Package-Specific Constants
```
packages/web-client/src/lib/
  constants/
    index.ts       # Re-exports all
    timeouts.ts    # PING_INTERVAL, RECONNECT delays
    limits.ts      # MAX_MESSAGES, MAX_FILE_SIZE
    webrtc.ts      # ICE_SERVERS (environment-aware)

packages/server-vps/src/
  constants/
    index.ts
    rate-limit.ts
    connections.ts
```

#### Tier 3: Environment Configuration
```typescript
// packages/web-client/src/lib/config.ts
import { z } from 'zod';

const configSchema = z.object({
  SIGNALING_URL: z.string().url().default('wss://relay.zajel.io'),
  ICE_SERVERS: z.array(z.object({
    urls: z.string(),
  })).default([{ urls: 'stun:stun.l.google.com:19302' }]),
  MAX_FILE_SIZE_MB: z.coerce.number().positive().default(100),
});

export const config = configSchema.parse({
  SIGNALING_URL: import.meta.env.VITE_SIGNALING_URL,
  ICE_SERVERS: JSON.parse(import.meta.env.VITE_ICE_SERVERS || '[]'),
  MAX_FILE_SIZE_MB: import.meta.env.VITE_MAX_FILE_SIZE_MB,
});
```

#### Key Principles

1. **Crypto constants are non-negotiable**: Never make cryptographic parameters configurable via environment
2. **Protocol constants are shared**: Both client and server need the same values
3. **Operational constants are configurable**: Timeouts, limits, and URLs can vary by environment
4. **Document the "why"**: Every constant should have a JSDoc comment explaining its purpose
5. **Use `as const` + `Object.freeze()`**: For critical security constants
6. **Validate at startup**: Use Zod to fail fast on misconfiguration

---

### Summary Table

| App/Framework | Build-Time Config | Runtime Config | Crypto Constants | Documentation |
|---------------|-------------------|----------------|------------------|---------------|
| **Signal** | constants.gradle.kts, BuildConfig | RemoteConfig.kt | In libsignal modules | Code comments |
| **Telegram** | BuildVars.java | help.getAppConfig API | MTProto modules | Inline + fork notes |
| **Matrix SDK** | Package entry points | Client options | src/crypto/ modules | JSDoc + types |
| **TypeScript** | `as const` objects | Zod-validated env | Frozen objects | JSDoc |
| **Flutter/Dart** | const declarations | Platform config | Grouped classes | DartDoc |
| **React Native** | react-native-config | Build variants | Validated env | README |

This research confirms that the proposed constants structure in this document aligns with industry best practices, particularly the use of `as const` objects with JSDoc documentation, grouped by functional category.
