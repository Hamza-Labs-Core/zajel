/**
 * R2 storage logic for raw diagnostic reports.
 *
 * Stores raw JSON reports at a path derived from the timestamp
 * and session hash for later analysis (e.g., by AI in Epic 6).
 */

import type { DiagnosticReport } from './types.js';

/**
 * Build the R2 storage key for a diagnostic report.
 *
 * Format: diagnostics/{YYYY}/{MM}/{DD}/{HH}/{sessionHash}_{timestamp}.json
 *
 * @param report - The validated diagnostic report
 * @returns The R2 object key
 */
export function buildReportKey(report: DiagnosticReport): string {
  const date = new Date(report.timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');

  return `diagnostics/${year}/${month}/${day}/${hour}/${report.sessionHash}_${report.timestamp}.json`;
}

/**
 * Store a raw diagnostic report in R2.
 *
 * @param bucket - The R2 bucket binding
 * @param report - The validated diagnostic report
 * @returns The storage key used
 */
export async function storeReport(
  bucket: R2Bucket,
  report: DiagnosticReport,
): Promise<string> {
  const key = buildReportKey(report);
  await bucket.put(key, JSON.stringify(report), {
    httpMetadata: {
      contentType: 'application/json',
    },
  });
  return key;
}
