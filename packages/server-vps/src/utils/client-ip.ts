/**
 * Client IP extraction utility.
 *
 * When the Node.js server runs behind a reverse proxy (e.g., nginx),
 * `req.socket.remoteAddress` is always the proxy's loopback address
 * (127.0.0.1). The real client IP is forwarded via HTTP headers.
 *
 * Header priority:
 *   1. X-Real-IP       -- set by nginx's `proxy_set_header X-Real-IP $remote_addr`
 *   2. X-Forwarded-For -- first entry is the original client IP
 *   3. req.socket.remoteAddress -- fallback for direct connections
 */

import type { IncomingMessage } from 'http';

/**
 * Extract the real client IP address from an HTTP request.
 *
 * When behind a trusted reverse proxy (nginx on localhost), this reads
 * the X-Real-IP or X-Forwarded-For headers to determine the original
 * client IP. Falls back to socket.remoteAddress for direct connections.
 */
export function getClientIp(req: IncomingMessage): string {
  // X-Real-IP is the preferred header (single IP, set by nginx)
  const xRealIp = req.headers['x-real-ip'];
  if (typeof xRealIp === 'string' && xRealIp.trim()) {
    return xRealIp.trim();
  }

  // X-Forwarded-For may contain multiple IPs: "client, proxy1, proxy2"
  // The first entry is the original client IP.
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
    const firstIp = xForwardedFor.split(',')[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }

  // Fallback: direct connection (no proxy)
  return req.socket.remoteAddress || 'unknown';
}
