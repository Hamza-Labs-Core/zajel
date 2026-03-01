import { randomInt } from 'node:crypto';

/**
 * Generate a cryptographically secure random integer in [0, max).
 * Uses Node.js crypto.randomInt which uses rejection sampling internally
 * to avoid modulo bias.
 * @param max - Exclusive upper bound (must be > 0)
 * @returns Random integer in [0, max)
 */
export function secureRandomInt(max: number): number {
  if (max <= 0) return 0;
  return randomInt(max);
}

/**
 * Cryptographically secure Fisher-Yates shuffle.
 * Mutates the array in place.
 * @param array - Array to shuffle
 * @returns The shuffled array (same reference)
 */
export function secureShuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [array[i], array[j]] = [array[j]!, array[i]!];
  }
  return array;
}
