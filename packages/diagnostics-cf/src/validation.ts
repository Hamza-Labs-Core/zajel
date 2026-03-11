/**
 * Schema validation for diagnostic report payloads.
 *
 * Validates required fields, types, and value constraints.
 */

import type { DiagnosticReport, DiagnosticError, PerformanceMetrics, NetworkMetrics } from './types.js';
import { VALID_PLATFORMS, VALID_ERROR_CATEGORIES, VALID_CONNECTION_TYPES, VALID_ENVIRONMENTS } from './types.js';

/** Hex pattern for SHA-256 hash (64 hex characters). */
const SESSION_HASH_PATTERN = /^[0-9a-f]{64}$/i;

/** Semver pattern (major.minor.patch, optional pre-release). */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+/;

/** Numeric string pattern for buildNumber. */
const BUILD_NUMBER_PATTERN = /^\d+$/;

/**
 * Validation result.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  report?: DiagnosticReport;
}

/**
 * Validate a diagnostic report payload.
 *
 * @param body - Parsed JSON body
 * @returns Validation result with either the validated report or an error message
 */
export function validateReport(body: unknown): ValidationResult {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  // Required string fields
  const requiredStringFields = [
    'sessionHash',
    'appVersion',
    'buildNumber',
    'platform',
    'platformVersion',
    'locale',
  ] as const;

  for (const field of requiredStringFields) {
    if (obj[field] === undefined || obj[field] === null) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
    if (typeof obj[field] !== 'string') {
      return { valid: false, error: `Field '${field}' must be a string` };
    }
    if ((obj[field] as string).length === 0) {
      return { valid: false, error: `Field '${field}' must not be empty` };
    }
  }

  // timestamp is required and must be a number
  if (obj['timestamp'] === undefined || obj['timestamp'] === null) {
    return { valid: false, error: 'Missing required field: timestamp' };
  }
  if (typeof obj['timestamp'] !== 'number') {
    return { valid: false, error: "Field 'timestamp' must be a number" };
  }
  if (!Number.isFinite(obj['timestamp']) || obj['timestamp'] <= 0) {
    return { valid: false, error: "Field 'timestamp' must be a positive number" };
  }

  // Validate sessionHash format
  if (!SESSION_HASH_PATTERN.test(obj['sessionHash'] as string)) {
    return { valid: false, error: "Field 'sessionHash' must be a 64-character hex string (SHA-256)" };
  }

  // Validate appVersion format
  if (!SEMVER_PATTERN.test(obj['appVersion'] as string)) {
    return { valid: false, error: "Field 'appVersion' must be a valid semver string (e.g. '1.2.3')" };
  }

  // Validate buildNumber format
  if (!BUILD_NUMBER_PATTERN.test(obj['buildNumber'] as string)) {
    return { valid: false, error: "Field 'buildNumber' must be a numeric string" };
  }

  // Validate platform
  if (!VALID_PLATFORMS.includes(obj['platform'] as typeof VALID_PLATFORMS[number])) {
    return { valid: false, error: `Field 'platform' must be one of: ${VALID_PLATFORMS.join(', ')}` };
  }

  // Validate optional connectionType
  if (obj['connectionType'] !== undefined && obj['connectionType'] !== null) {
    if (typeof obj['connectionType'] !== 'string') {
      return { valid: false, error: "Field 'connectionType' must be a string" };
    }
    if (!VALID_CONNECTION_TYPES.includes(obj['connectionType'] as typeof VALID_CONNECTION_TYPES[number])) {
      return { valid: false, error: `Field 'connectionType' must be one of: ${VALID_CONNECTION_TYPES.join(', ')}` };
    }
  }

  // Validate optional environment
  if (obj['environment'] !== undefined && obj['environment'] !== null) {
    if (typeof obj['environment'] !== 'string') {
      return { valid: false, error: "Field 'environment' must be a string" };
    }
    if (!VALID_ENVIRONMENTS.includes(obj['environment'] as typeof VALID_ENVIRONMENTS[number])) {
      return { valid: false, error: `Field 'environment' must be one of: ${VALID_ENVIRONMENTS.join(', ')}` };
    }
  }

  // Validate optional errors array
  if (obj['errors'] !== undefined && obj['errors'] !== null) {
    if (!Array.isArray(obj['errors'])) {
      return { valid: false, error: "Field 'errors' must be an array" };
    }
    for (let i = 0; i < obj['errors'].length; i++) {
      const errorResult = validateDiagnosticError(obj['errors'][i] as unknown, i);
      if (!errorResult.valid) {
        return errorResult;
      }
    }
  }

  // Validate optional performance
  if (obj['performance'] !== undefined && obj['performance'] !== null) {
    const perfResult = validatePerformanceMetrics(obj['performance'] as unknown);
    if (!perfResult.valid) {
      return perfResult;
    }
  }

  // Validate optional network
  if (obj['network'] !== undefined && obj['network'] !== null) {
    const netResult = validateNetworkMetrics(obj['network'] as unknown);
    if (!netResult.valid) {
      return netResult;
    }
  }

  return {
    valid: true,
    report: obj as unknown as DiagnosticReport,
  };
}

/**
 * Validate a single error entry.
 */
function validateDiagnosticError(error: unknown, index: number): ValidationResult {
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return { valid: false, error: `errors[${index}] must be an object` };
  }

  const err = error as Record<string, unknown>;

  // Required fields
  if (typeof err['category'] !== 'string') {
    return { valid: false, error: `errors[${index}].category must be a string` };
  }
  if (!VALID_ERROR_CATEGORIES.includes(err['category'] as typeof VALID_ERROR_CATEGORIES[number])) {
    return { valid: false, error: `errors[${index}].category must be one of: ${VALID_ERROR_CATEGORIES.join(', ')}` };
  }

  if (typeof err['message'] !== 'string') {
    return { valid: false, error: `errors[${index}].message must be a string` };
  }

  if (typeof err['signature'] !== 'string') {
    return { valid: false, error: `errors[${index}].signature must be a string` };
  }

  if (typeof err['count'] !== 'number' || !Number.isFinite(err['count']) || err['count'] < 0) {
    return { valid: false, error: `errors[${index}].count must be a non-negative number` };
  }

  if (typeof err['firstOccurrence'] !== 'number' || !Number.isFinite(err['firstOccurrence'])) {
    return { valid: false, error: `errors[${index}].firstOccurrence must be a number` };
  }

  if (typeof err['lastOccurrence'] !== 'number' || !Number.isFinite(err['lastOccurrence'])) {
    return { valid: false, error: `errors[${index}].lastOccurrence must be a number` };
  }

  // Optional stackTrace
  if (err['stackTrace'] !== undefined && err['stackTrace'] !== null && typeof err['stackTrace'] !== 'string') {
    return { valid: false, error: `errors[${index}].stackTrace must be a string` };
  }

  return { valid: true };
}

/**
 * Validate performance metrics.
 */
function validatePerformanceMetrics(perf: unknown): ValidationResult {
  if (typeof perf !== 'object' || perf === null || Array.isArray(perf)) {
    return { valid: false, error: "Field 'performance' must be an object" };
  }

  const p = perf as Record<string, unknown>;
  const numericFields: Array<keyof PerformanceMetrics> = [
    'startupTimeMs',
    'frameRateAvg',
    'frameRateP95',
    'memoryUsageMb',
    'memoryPeakMb',
  ];

  for (const field of numericFields) {
    if (p[field] !== undefined && p[field] !== null) {
      if (typeof p[field] !== 'number' || !Number.isFinite(p[field] as number)) {
        return { valid: false, error: `performance.${field} must be a number` };
      }
      if ((p[field] as number) < 0) {
        return { valid: false, error: `performance.${field} must be non-negative` };
      }
    }
  }

  return { valid: true };
}

/**
 * Validate network metrics.
 */
function validateNetworkMetrics(net: unknown): ValidationResult {
  if (typeof net !== 'object' || net === null || Array.isArray(net)) {
    return { valid: false, error: "Field 'network' must be an object" };
  }

  const n = net as Record<string, unknown>;
  const numericFields: Array<keyof NetworkMetrics> = [
    'signalingConnectSuccessRate',
    'signalingConnectAttempts',
    'webrtcEstablishSuccessRate',
    'webrtcEstablishAttempts',
    'relayUsageRate',
    'avgLatencyMs',
  ];

  for (const field of numericFields) {
    if (n[field] !== undefined && n[field] !== null) {
      if (typeof n[field] !== 'number' || !Number.isFinite(n[field] as number)) {
        return { valid: false, error: `network.${field} must be a number` };
      }
      if ((n[field] as number) < 0) {
        return { valid: false, error: `network.${field} must be non-negative` };
      }
    }
  }

  // Rate fields should be between 0 and 1
  const rateFields: Array<keyof NetworkMetrics> = [
    'signalingConnectSuccessRate',
    'webrtcEstablishSuccessRate',
    'relayUsageRate',
  ];

  for (const field of rateFields) {
    if (n[field] !== undefined && n[field] !== null) {
      const val = n[field] as number;
      if (val < 0 || val > 1) {
        return { valid: false, error: `network.${field} must be between 0 and 1` };
      }
    }
  }

  return { valid: true };
}
