/**
 * Unit tests for numeric validation utilities.
 *
 * Tests the isNonNegativeInteger and isPositiveInteger functions
 * against JavaScript's type coercion edge cases.
 */

import { describe, it, expect } from 'vitest';
import { isNonNegativeInteger, isPositiveInteger } from '../../src/utils/numeric-validation.js';

describe('isNonNegativeInteger', () => {
  it('should accept valid non-negative integers', () => {
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(1)).toBe(true);
    expect(isNonNegativeInteger(5)).toBe(true);
    expect(isNonNegativeInteger(100)).toBe(true);
    expect(isNonNegativeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('should reject negative integers', () => {
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(-5)).toBe(false);
    expect(isNonNegativeInteger(Number.MIN_SAFE_INTEGER)).toBe(false);
  });

  it('should reject fractional numbers', () => {
    expect(isNonNegativeInteger(0.5)).toBe(false);
    expect(isNonNegativeInteger(1.1)).toBe(false);
    expect(isNonNegativeInteger(1.9999)).toBe(false);
    expect(isNonNegativeInteger(Math.PI)).toBe(false);
  });

  it('should reject NaN', () => {
    expect(isNonNegativeInteger(NaN)).toBe(false);
    expect(isNonNegativeInteger(0 / 0)).toBe(false);
    expect(isNonNegativeInteger(Math.sqrt(-1))).toBe(false);
  });

  it('should reject Infinity and -Infinity', () => {
    expect(isNonNegativeInteger(Infinity)).toBe(false);
    expect(isNonNegativeInteger(-Infinity)).toBe(false);
    expect(isNonNegativeInteger(1 / 0)).toBe(false);
  });

  it('should reject null', () => {
    expect(isNonNegativeInteger(null)).toBe(false);
  });

  it('should reject undefined', () => {
    expect(isNonNegativeInteger(undefined)).toBe(false);
  });

  it('should reject numeric strings', () => {
    expect(isNonNegativeInteger('0')).toBe(false);
    expect(isNonNegativeInteger('5')).toBe(false);
    expect(isNonNegativeInteger('123')).toBe(false);
  });

  it('should reject non-numeric strings', () => {
    expect(isNonNegativeInteger('abc')).toBe(false);
    expect(isNonNegativeInteger('NaN')).toBe(false);
    expect(isNonNegativeInteger('')).toBe(false);
  });

  it('should reject objects and arrays', () => {
    expect(isNonNegativeInteger({})).toBe(false);
    expect(isNonNegativeInteger([])).toBe(false);
    expect(isNonNegativeInteger([5])).toBe(false);
    expect(isNonNegativeInteger({ value: 5 })).toBe(false);
  });

  it('should reject booleans', () => {
    expect(isNonNegativeInteger(true)).toBe(false);
    expect(isNonNegativeInteger(false)).toBe(false);
  });
});

describe('isPositiveInteger', () => {
  it('should accept valid positive integers', () => {
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(5)).toBe(true);
    expect(isPositiveInteger(100)).toBe(true);
    expect(isPositiveInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('should reject zero', () => {
    expect(isPositiveInteger(0)).toBe(false);
  });

  it('should reject negative integers', () => {
    expect(isPositiveInteger(-1)).toBe(false);
    expect(isPositiveInteger(-5)).toBe(false);
  });

  it('should reject NaN, Infinity, null, undefined', () => {
    expect(isPositiveInteger(NaN)).toBe(false);
    expect(isPositiveInteger(Infinity)).toBe(false);
    expect(isPositiveInteger(-Infinity)).toBe(false);
    expect(isPositiveInteger(null)).toBe(false);
    expect(isPositiveInteger(undefined)).toBe(false);
  });
});
