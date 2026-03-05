/**
 * Rate limiting logic for diagnostic report submissions.
 *
 * Two layers:
 * 1. Global rate limit via native Cloudflare Rate Limiting binding (167/60s ~ 10,000/hour)
 * 2. Per-session rate limit via KV (10 per hour per sessionHash)
 *
 * The native binding has sub-millisecond latency (in-process counter).
 * KV is eventually consistent (up to 60s) which is acceptable for session limits.
 */

import type { Env } from './types.js';
import { SESSION_RATE_LIMIT, SESSION_RATE_LIMIT_WINDOW } from './types.js';

/**
 * Rate limit result.
 */
export interface RateLimitResult {
  allowed: boolean;
  error?: string;
}

/**
 * Check the global rate limit (DDoS protection).
 * Uses the native Cloudflare Rate Limiting binding.
 *
 * @param env - Worker environment bindings
 * @returns Whether the request is allowed
 */
export async function checkGlobalRateLimit(env: Env): Promise<RateLimitResult> {
  try {
    const { success } = await env.GLOBAL_RATE_LIMITER.limit({ key: 'global' });
    if (!success) {
      return {
        allowed: false,
        error: 'Service is experiencing high traffic. Please try again later.',
      };
    }
    return { allowed: true };
  } catch {
    // If the rate limiter fails, allow the request through
    // (fail open for availability)
    console.error('Global rate limiter error');
    return { allowed: true };
  }
}

/**
 * Check the per-session rate limit.
 * Uses KV with TTL for accurate hourly windowing.
 *
 * KV key format: "rl:{sessionHash}"
 * Value: JSON { count: number, windowStart: number }
 *
 * @param env - Worker environment bindings
 * @param sessionHash - The session hash from the report
 * @returns Whether the request is allowed
 */
export async function checkSessionRateLimit(
  env: Env,
  sessionHash: string,
): Promise<RateLimitResult> {
  const key = `rl:${sessionHash}`;

  try {
    const existing = await env.RATE_LIMIT_KV.get(key, 'json') as {
      count: number;
      windowStart: number;
    } | null;

    const now = Date.now();

    if (!existing || now - existing.windowStart > SESSION_RATE_LIMIT_WINDOW * 1000) {
      // New window
      await env.RATE_LIMIT_KV.put(
        key,
        JSON.stringify({ count: 1, windowStart: now }),
        { expirationTtl: SESSION_RATE_LIMIT_WINDOW },
      );
      return { allowed: true };
    }

    if (existing.count >= SESSION_RATE_LIMIT) {
      return {
        allowed: false,
        error: `Rate limit exceeded. Maximum ${SESSION_RATE_LIMIT} reports per session per hour.`,
      };
    }

    // Increment count
    await env.RATE_LIMIT_KV.put(
      key,
      JSON.stringify({ count: existing.count + 1, windowStart: existing.windowStart }),
      { expirationTtl: SESSION_RATE_LIMIT_WINDOW },
    );
    return { allowed: true };
  } catch {
    // Fail open for availability
    console.error('Session rate limiter error');
    return { allowed: true };
  }
}
