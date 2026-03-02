/**
 * Request body validation utilities.
 *
 * Provides safe JSON body parsing with size limits to prevent
 * memory exhaustion from oversized payloads.
 */

const DEFAULT_MAX_BODY_SIZE = 65536; // 64KB

/**
 * Parse a JSON request body with size limits.
 *
 * Checks Content-Length header first (fast reject), then verifies
 * actual body size (handles spoofed/missing Content-Length).
 *
 * @param {Request} request - The incoming request
 * @param {number} [maxSize=65536] - Maximum body size in bytes
 * @returns {Promise<any>} Parsed JSON body
 * @throws {BodyTooLargeError} If the body exceeds the size limit
 * @throws {SyntaxError} If the body is not valid JSON
 */
export async function parseJsonBody(request, maxSize = DEFAULT_MAX_BODY_SIZE) {
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > maxSize) {
    throw new BodyTooLargeError(
      `Request body too large: ${contentLength} bytes exceeds ${maxSize} byte limit`
    );
  }

  // Also check actual body size (Content-Length can be spoofed or missing)
  const bodyText = await request.text();
  if (bodyText.length > maxSize) {
    throw new BodyTooLargeError(
      `Request body too large: ${bodyText.length} bytes exceeds ${maxSize} byte limit`
    );
  }

  return JSON.parse(bodyText);
}

/**
 * Custom error for oversized request bodies.
 */
export class BodyTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BodyTooLargeError';
  }
}
