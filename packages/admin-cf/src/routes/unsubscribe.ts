/**
 * Unsubscribe endpoint for email notifications (US-8.2)
 *
 * GET /admin/api/notifications/unsubscribe?token={jwt}
 *
 * Verifies the JWT (which contains the email address), disables the email
 * notification config in D1, and returns a simple HTML confirmation page.
 * No session auth required -- the JWT itself is the authorization.
 */

import type { Env } from '../types.js';
import { verifyJwt } from '../crypto.js';

interface UnsubscribePayload {
  email: string;
  purpose: string;
  exp?: number;
}

/**
 * Handle email unsubscribe request.
 */
export async function handleUnsubscribe(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return htmlResponse(
      'Invalid Request',
      'Missing unsubscribe token. Please use the link from your email.',
      400
    );
  }

  if (!env.ZAJEL_ADMIN_JWT_SECRET) {
    return htmlResponse(
      'Server Error',
      'Server is not properly configured.',
      500
    );
  }

  // Verify the JWT
  const payload = await verifyJwt<UnsubscribePayload>(
    token,
    env.ZAJEL_ADMIN_JWT_SECRET
  );

  if (!payload || payload.purpose !== 'unsubscribe' || !payload.email) {
    return htmlResponse(
      'Invalid Token',
      'The unsubscribe link is invalid or has expired. Please update your notification settings in the admin dashboard.',
      401
    );
  }

  // Disable the email notification config in D1
  if (env.DIAGNOSTICS_DB) {
    try {
      // Find and disable notification_config entries that contain this email
      const configs = await env.DIAGNOSTICS_DB.prepare(
        `SELECT id, config FROM notification_config WHERE channel_type = 'email' AND enabled = 1`
      ).all();

      let disabled = false;
      for (const row of configs.results || []) {
        try {
          const config = JSON.parse((row as Record<string, unknown>).config as string) as {
            addresses?: string[];
            [key: string]: unknown;
          };
          if (
            config.addresses &&
            config.addresses.some(
              (addr: string) => addr.toLowerCase() === payload.email.toLowerCase()
            )
          ) {
            // Remove only the specific email from the addresses array
            const filteredAddresses = config.addresses.filter(
              (addr: string) => addr.toLowerCase() !== payload.email.toLowerCase()
            );

            if (filteredAddresses.length === 0) {
              // No addresses left — disable the config
              await env.DIAGNOSTICS_DB.prepare(
                `UPDATE notification_config SET enabled = 0, updated_at = ?, updated_by = ? WHERE id = ?`
              )
                .bind(Date.now(), 'unsubscribe', (row as Record<string, unknown>).id)
                .run();
            } else {
              // Update config with the remaining addresses
              config.addresses = filteredAddresses;
              await env.DIAGNOSTICS_DB.prepare(
                `UPDATE notification_config SET config = ?, updated_at = ?, updated_by = ? WHERE id = ?`
              )
                .bind(JSON.stringify(config), Date.now(), 'unsubscribe', (row as Record<string, unknown>).id)
                .run();
            }
            disabled = true;
          }
        } catch {
          // Skip malformed config rows
        }
      }

      if (disabled) {
        return htmlResponse(
          'Unsubscribed',
          `Email notifications for <strong>${escapeHtml(payload.email)}</strong> have been disabled. You can re-enable them from the admin dashboard at any time.`,
          200
        );
      }

      return htmlResponse(
        'Already Unsubscribed',
        `Email notifications for <strong>${escapeHtml(payload.email)}</strong> are already disabled.`,
        200
      );
    } catch (error) {
      console.error('Unsubscribe D1 error:', error);
      return htmlResponse(
        'Error',
        'An error occurred while processing your unsubscribe request. Please try again later.',
        500
      );
    }
  }

  return htmlResponse(
    'Not Available',
    'The notification system is not configured on this server.',
    503
  );
}

/**
 * Build a simple HTML response page.
 */
function htmlResponse(title: string, message: string, status: number): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Zajel Admin</title>
  <style>
    body { margin: 0; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f4f5; color: #1e293b; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 8px; padding: 32px; max-width: 480px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { margin: 0; font-size: 14px; color: #475569; line-height: 1.6; }
    .footer { margin-top: 24px; font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${message}</p>
    <div class="footer">Zajel Admin Notifications</div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
