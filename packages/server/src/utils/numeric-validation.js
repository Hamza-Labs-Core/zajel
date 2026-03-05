/**
 * Numeric input validation utilities.
 *
 * Provides guards against JavaScript's NaN, Infinity, and type coercion
 * issues that can bypass naive bounds checks.
 */

/**
 * Validate that a value is a non-negative integer.
 *
 * Rejects:
 * - NaN (typeof === 'number' but not finite)
 * - Infinity and -Infinity
 * - Negative numbers
 * - Fractional numbers
 * - Non-number types (undefined, null, string, object, etc.)
 *
 * JavaScript gotchas this prevents:
 * - `NaN < 0` is false, so naive bounds checks pass
 * - `typeof NaN === 'number'` is true
 * - `null` coerces to 0 in numeric comparisons
 * - `undefined` coerces to NaN
 *
 * @param {any} value - The value to validate
 * @returns {boolean} True if the value is a non-negative integer
 *
 * @example
 * isNonNegativeInteger(0)        // true
 * isNonNegativeInteger(5)        // true
 * isNonNegativeInteger(-1)       // false
 * isNonNegativeInteger(1.5)      // false
 * isNonNegativeInteger(NaN)      // false
 * isNonNegativeInteger(Infinity) // false
 * isNonNegativeInteger(null)     // false
 * isNonNegativeInteger("5")      // false
 */
export function isNonNegativeInteger(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    Number.isInteger(value)
  );
}

/**
 * Validate that a value is a positive integer (> 0).
 *
 * Same as isNonNegativeInteger but rejects zero.
 *
 * @param {any} value - The value to validate
 * @returns {boolean} True if the value is a positive integer
 */
export function isPositiveInteger(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    Number.isInteger(value)
  );
}
