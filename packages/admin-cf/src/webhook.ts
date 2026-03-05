/**
 * Webhook payload construction for generic, Slack, and Discord formats (US-8.3)
 *
 * Builds properly formatted webhook payloads for different platforms.
 * Used by NotificationDO and notification-dispatch for sending webhook notifications.
 */

import type { NotificationPayload, WebhookFormat } from './types.js';

export interface WebhookPayloadResult {
  body: string;
  contentType: string;
}

/**
 * Build a webhook payload in the specified format.
 */
export function buildWebhookPayload(
  notification: NotificationPayload,
  format: WebhookFormat,
  dashboardUrl: string
): WebhookPayloadResult {
  switch (format) {
    case 'slack':
      return buildSlackPayload(notification, dashboardUrl);
    case 'discord':
      return buildDiscordPayload(notification, dashboardUrl);
    case 'generic':
    default:
      return buildGenericPayload(notification, dashboardUrl);
  }
}

/**
 * Generic JSON payload format.
 */
function buildGenericPayload(
  notification: NotificationPayload,
  dashboardUrl: string
): WebhookPayloadResult {
  return {
    contentType: 'application/json',
    body: JSON.stringify({
      severity: notification.severity,
      title: notification.title,
      message: notification.message,
      category: notification.category,
      timestamp: Date.now(),
      dashboardLink: dashboardUrl,
    }),
  };
}

/**
 * Slack incoming webhook format with blocks.
 */
function buildSlackPayload(
  notification: NotificationPayload,
  dashboardUrl: string
): WebhookPayloadResult {
  return {
    contentType: 'application/json',
    body: JSON.stringify({
      text: `[${notification.severity.toUpperCase()}] ${notification.title}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${notification.title}*\n${notification.message}`,
          },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `Severity: *${notification.severity}*` },
            { type: 'mrkdwn', text: `<${dashboardUrl}|View in Dashboard>` },
          ],
        },
      ],
    }),
  };
}

/**
 * Discord webhook format with embeds.
 */
function buildDiscordPayload(
  notification: NotificationPayload,
  dashboardUrl: string
): WebhookPayloadResult {
  return {
    contentType: 'application/json',
    body: JSON.stringify({
      embeds: [
        {
          title: notification.title,
          description: notification.message,
          color: severityToDiscordColor(notification.severity),
          fields: [
            { name: 'Severity', value: notification.severity, inline: true },
            { name: 'Category', value: notification.category, inline: true },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: 'Zajel Admin' },
          url: dashboardUrl,
        },
      ],
    }),
  };
}

/**
 * Map severity to Discord embed color (decimal integer).
 */
export function severityToDiscordColor(severity: string): number {
  switch (severity) {
    case 'critical':
      return 0xEF4444; // red
    case 'warning':
      return 0xEAB308; // yellow
    case 'info':
      return 0x3B82F6; // blue
    default:
      return 0x94A3B8; // gray
  }
}
