/**
 * Email notification construction and dispatch (US-8.2)
 *
 * Constructs raw MIME email messages for sending via CF Email Workers.
 * No external dependencies -- builds MIME manually since the emails are simple HTML.
 */

import type { NotificationPayload } from './types.js';

const DEFAULT_FROM_EMAIL = 'notifications@zajel.hamzalabs.dev';

/**
 * Severity badge colors for HTML email
 */
function severityBadgeStyle(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'background-color:#EF4444;color:#fff;';
    case 'warning':
      return 'background-color:#EAB308;color:#fff;';
    case 'info':
      return 'background-color:#3B82F6;color:#fff;';
    default:
      return 'background-color:#94A3B8;color:#fff;';
  }
}

/**
 * Build the email subject line.
 */
export function buildEmailSubject(notification: NotificationPayload): string {
  return `[Zajel Alert - ${notification.severity.toUpperCase()}] ${notification.title}`;
}

/**
 * Build the HTML email body.
 */
export function buildEmailHtml(
  notification: NotificationPayload,
  dashboardUrl: string,
  unsubscribeUrl: string
): string {
  const severityBadge = severityBadgeStyle(notification.severity);
  const timestamp = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(notification.title)}</title>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background-color:#f4f4f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background-color:#1e293b;padding:20px 24px;">
              <h1 style="margin:0;font-size:20px;color:#ffffff;">Zajel Admin Alert</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:24px;">
              <!-- Severity Badge -->
              <span style="${severityBadge}padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">
                ${escapeHtml(notification.severity)}
              </span>
              <!-- Title -->
              <h2 style="margin:16px 0 8px;font-size:18px;color:#1e293b;">
                ${escapeHtml(notification.title)}
              </h2>
              <!-- Message -->
              <p style="margin:0 0 16px;font-size:14px;color:#475569;line-height:1.6;">
                ${escapeHtml(notification.message)}
              </p>
              <!-- Timestamp -->
              <p style="margin:0 0 24px;font-size:12px;color:#94a3b8;">
                ${escapeHtml(timestamp)} UTC
              </p>
              <!-- CTA Button -->
              <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:10px 24px;background-color:#3b82f6;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">
                View in Dashboard
              </a>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:16px 24px;background-color:#f8fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#94a3b8;text-align:center;">
                You are receiving this because you are subscribed to Zajel admin alerts.
                <br>
                <a href="${escapeHtml(unsubscribeUrl)}" style="color:#64748b;text-decoration:underline;">Unsubscribe</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Build a raw MIME email string.
 * Constructs a multipart/alternative email with both text and HTML parts.
 */
export function buildRawMimeEmail(
  from: string,
  to: string,
  subject: string,
  htmlBody: string
): string {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const date = new Date().toUTCString();

  // Plain text fallback (strip HTML).
  //
  // The previous regex chain triggered three different CodeQL rules on a
  // single line:
  //   - js/polynomial-redos      (lazy quantifier on /<style>...</style>/)
  //   - js/incomplete-multi-character-sanitization (single-pass replace
  //     could leave a leftover `<style>` if tags were nested or
  //     reconstructed by an earlier rule's output)
  //   - js/double-escaping       (decoding `&amp;` last re-introduced
  //     other entities like `&amp;lt;` -> `&lt;`)
  //
  // Replacement strategy:
  //   1. `removeAll(...)` — loop replace on `<style>...</style>` so a
  //      pathological string with nested or re-formed tags can't
  //      smuggle markup through, and avoid the lazy-quantifier ReDoS
  //      pattern by anchoring on a non-`<` body via `[^<]*` (and
  //      tolerating any `<` that isn't `</style>` via a follow-up).
  //   2. Strip remaining tags with a non-greedy match that has no
  //      ambiguous backtracking.
  //   3. Decode entities in the order numeric → `&amp;` LAST is what
  //      causes double-escape; instead, decode `&amp;` FIRST so any
  //      following `&lt;` is left as-is.
  const stripStyleBlocks = (s: string): string => {
    let prev: string;
    let out = s;
    do {
      prev = out;
      out = out.replace(/<style\b[^>]*>[^<]*(?:<(?!\/style>)[^<]*)*<\/style\s*>/gi, '');
    } while (out !== prev);
    return out;
  };
  const decodeBasicEntities = (s: string): string =>
    s.replace(/&(amp|lt|gt|nbsp|#39|quot);/gi, (_m, name) => {
      switch (name.toLowerCase()) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'nbsp':
          return ' ';
        case '#39':
          return "'";
        case 'quot':
          return '"';
        default:
          return _m;
      }
    });
  // Loop the tag-strip to a fixed point so input like
  // `<scr<script>ipt>` (which would leave `<script>` after a single
  // `replace(/<[^>]*>/g, '')`) can't smuggle markup through. Without
  // the loop, CodeQL flags this as
  // `js/incomplete-multi-character-sanitization`.
  const stripAllTags = (s: string): string => {
    let prev: string;
    let out = s;
    do {
      prev = out;
      out = out.replace(/<[^>]*>/g, '');
    } while (out !== prev);
    return out;
  };
  const textBody = decodeBasicEntities(stripAllTags(stripStyleBlocks(htmlBody)))
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    textBody,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
  ];

  return lines.join('\r\n');
}

/**
 * Get the sender email address from environment or default.
 */
export function getSenderEmail(envFromEmail?: string): string {
  return envFromEmail || DEFAULT_FROM_EMAIL;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Severity level numeric values for comparison.
 * Higher number = higher severity.
 */
export function severityLevel(severity: string): number {
  switch (severity) {
    case 'critical':
      return 3;
    case 'warning':
      return 2;
    case 'info':
      return 1;
    default:
      return 0;
  }
}

/**
 * Check if a notification severity meets the minimum filter threshold.
 * For example, if filter is 'warning', then 'warning' and 'critical' pass, but 'info' does not.
 */
export function passesSeverityFilter(
  notificationSeverity: string,
  filterSeverity: string
): boolean {
  return severityLevel(notificationSeverity) >= severityLevel(filterSeverity);
}

/**
 * Hash an email address for use as a cooldown key.
 * Uses SHA-256 to avoid storing PII in KV keys.
 */
export async function hashEmail(email: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(email.toLowerCase());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
