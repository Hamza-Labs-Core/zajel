/**
 * Shared Test Constants
 *
 * Centralized timeout values, sizes, and configuration for all integration tests.
 * These constants ensure consistency across test files and make CI/local differences explicit.
 */

// Detect CI environment
export const isCI = process.env.CI === 'true' || !!process.env.GITHUB_ACTIONS;

/**
 * Timeout multiplier for CI environments.
 * CI runners are typically slower, so we increase timeouts.
 */
export const CI_MULTIPLIER = 2;

/**
 * Apply CI multiplier to a timeout value
 */
export const ciTimeout = (baseMs: number): number => isCI ? baseMs * CI_MULTIPLIER : baseMs;

/**
 * Standard timeout categories for different operation types.
 * All values in milliseconds.
 */
export const TIMEOUTS = {
  /** Very short operations (UI interactions, simple checks) */
  SHORT: ciTimeout(5_000),

  /** Medium operations (WebSocket messages, API calls) */
  MEDIUM: ciTimeout(10_000),

  /** Long operations (connection establishment, pairing flows) */
  LONG: ciTimeout(20_000),

  /** Very long operations (full E2E flows, multi-step processes) */
  VERY_LONG: ciTimeout(45_000),

  /** Server/service startup time */
  STARTUP: ciTimeout(30_000),

  /** Test suite level timeout */
  SUITE: ciTimeout(60_000),

  /** Hook (beforeAll/afterAll) timeout */
  HOOK: ciTimeout(30_000),
} as const;

/**
 * Polling intervals for wait operations
 */
export const POLL_INTERVALS = {
  /** Fast polling for quick operations */
  FAST: 50,

  /** Standard polling interval */
  STANDARD: 100,

  /** Slow polling for resource-intensive checks */
  SLOW: 500,

  /** Health check polling */
  HEALTH_CHECK: 200,
} as const;

/**
 * Network-related constants
 */
export const NETWORK = {
  /** Base port for test servers (random offset added) */
  BASE_PORT: 15000,

  /** Port range for random allocation */
  PORT_RANGE: 5000,

  /** WebSocket connection timeout */
  WS_CONNECT_TIMEOUT: ciTimeout(10_000),

  /** WebSocket message timeout */
  WS_MESSAGE_TIMEOUT: ciTimeout(10_000),

  /** HTTP request timeout */
  HTTP_TIMEOUT: ciTimeout(5_000),

  /** Server shutdown timeout */
  SHUTDOWN_TIMEOUT: ciTimeout(10_000),
} as const;

/**
 * Pairing/signaling protocol timeouts
 * These should match production values in server config
 */
export const PROTOCOL = {
  /** Time before pair request expires */
  PAIR_REQUEST_TIMEOUT: 120_000, // 2 minutes

  /** Warning time before pair request expires */
  PAIR_REQUEST_WARNING: 30_000,

  /** Heartbeat interval for connected clients */
  HEARTBEAT_INTERVAL: 30_000,

  /** Heartbeat timeout (time to consider client dead) */
  HEARTBEAT_TIMEOUT: 60_000,

  /** Bootstrap heartbeat interval */
  BOOTSTRAP_HEARTBEAT: 5_000,

  /** Server TTL in bootstrap registry */
  SERVER_TTL: 5 * 60 * 1000, // 5 minutes

  /** Gossip protocol interval */
  GOSSIP_INTERVAL: 2_000,

  /** State exchange interval */
  STATE_EXCHANGE_INTERVAL: 5_000,

  /** Retry interval for failed operations */
  RETRY_INTERVAL: 1_000,
} as const;

/**
 * Size limits
 */
export const LIMITS = {
  /** Maximum message size in bytes */
  MAX_MESSAGE_SIZE: 64 * 1024, // 64KB

  /** Maximum file chunk size */
  MAX_CHUNK_SIZE: 16 * 1024, // 16KB

  /** Maximum display name length */
  MAX_DISPLAY_NAME: 50,

  /** Pairing code length */
  PAIRING_CODE_LENGTH: 6,
} as const;

/**
 * Delay helper - use sparingly, prefer event-driven waits
 */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Event-driven wait helper with timeout
 * Waits for a condition to become true, checking at specified intervals
 *
 * @param condition - Function that returns true when condition is met
 * @param timeout - Maximum time to wait (default: TIMEOUTS.MEDIUM)
 * @param interval - Polling interval (default: POLL_INTERVALS.STANDARD)
 * @param message - Error message if timeout occurs
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = TIMEOUTS.MEDIUM,
  interval: number = POLL_INTERVALS.STANDARD,
  message: string = 'Condition not met within timeout'
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      if (await condition()) {
        return;
      }
    } catch {
      // Condition threw, continue waiting
    }
    await delay(interval);
  }

  throw new Error(`${message} (waited ${timeout}ms)`);
}

/**
 * Create an event emitter-based waiter for WebSocket messages
 * This is more efficient than polling as it reacts immediately to events
 */
export function createMessageWaiter<T>(
  onMessage: (handler: (msg: T) => void) => void,
  offMessage: (handler: (msg: T) => void) => void
) {
  return (
    predicate: (msg: T) => boolean,
    timeout: number = TIMEOUTS.MEDIUM
  ): Promise<T> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        offMessage(handler);
        reject(new Error(`Message not received within ${timeout}ms`));
      }, timeout);

      const handler = (msg: T) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          offMessage(handler);
          resolve(msg);
        }
      };

      onMessage(handler);
    });
  };
}

/**
 * Cleanup helper that ensures cleanup runs even on failure
 * Use in afterEach/afterAll hooks
 */
export async function safeCleanup(
  cleanupFn: () => Promise<void>,
  resourceName: string = 'resource'
): Promise<void> {
  try {
    await cleanupFn();
  } catch (error) {
    console.warn(`Warning: Failed to cleanup ${resourceName}:`, error);
    // Don't rethrow - cleanup failures shouldn't fail tests
  }
}

/**
 * Run multiple cleanup operations, collecting errors
 */
export async function cleanupAll(
  cleanups: Array<{ name: string; fn: () => Promise<void> }>
): Promise<void> {
  const errors: Array<{ name: string; error: unknown }> = [];

  for (const { name, fn } of cleanups) {
    try {
      await fn();
    } catch (error) {
      errors.push({ name, error });
    }
  }

  if (errors.length > 0) {
    console.warn('Cleanup errors:', errors.map(e => `${e.name}: ${e.error}`).join(', '));
  }
}
