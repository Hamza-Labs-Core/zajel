/**
 * Notification dispatch utilities (US-8.2, US-8.3)
 *
 * Helper functions for sending notifications to webhook and email channels.
 * These are NOT route handlers -- they are used by notification-config.ts
 * and can be called by alert rule processors.
 */

import type { WebhookConfig, EmailConfig, Env } from '../types.js';
import { buildWebhookPayload } from '../webhook.js';
import {
  buildEmailSubject,
  buildEmailHtml,
  buildRawMimeEmail,
  getSenderEmail,
} from '../email.js';

// ─── Types ──────────────────────────────────────

export interface DispatchPayload {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  timestamp: number;
  dashboardUrl: string;
}

export interface DispatchResult {
  sent: boolean;
  statusCode?: number;
  error?: string;
}

// ─── Webhook Dispatch ───────────────────────────

/**
 * Send a notification to a configured webhook URL.
 *
 * Supports generic, Slack, and Discord payload formats.
 * Uses a 5-second timeout via AbortSignal.
 */
export async function dispatchWebhook(
  config: WebhookConfig,
  payload: DispatchPayload
): Promise<DispatchResult> {
  try {
    // Determine format from config or default to generic
    const format = (config as { format?: string }).format || 'generic';
    const { body, contentType } = buildWebhookPayload(
      {
        severity: payload.severity,
        title: payload.title,
        message: payload.message,
        category: 'system',
      },
      format as 'generic' | 'slack' | 'discord',
      payload.dashboardUrl
    );

    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };

    if (config.authHeader) {
      headers['Authorization'] = config.authHeader;
    }

    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });

    return {
      sent: response.ok,
      statusCode: response.status,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Webhook dispatch failed:', errorMsg);
    return {
      sent: false,
      error: `Failed to deliver webhook notification: ${errorMsg}`,
    };
  }
}

// ─── Email Dispatch ─────────────────────────────

/**
 * Construct and send an email notification.
 *
 * If env and SEND_EMAIL binding are provided, sends via CF Email Workers.
 * Otherwise logs the email payload for debugging.
 */
export async function dispatchEmail(
  config: EmailConfig,
  payload: DispatchPayload,
  env?: Env
): Promise<DispatchResult> {
  try {
    const fromEmail = getSenderEmail(env?.NOTIFICATION_FROM_EMAIL);
    const subject = buildEmailSubject({
      severity: payload.severity,
      title: payload.title,
      message: payload.message,
      category: 'system',
    });

    const dashboardUrl = payload.dashboardUrl;
    // For test emails, we don't include a real unsubscribe link
    const unsubscribeUrl = `${dashboardUrl}/admin/api/notifications/config`;

    const htmlBody = buildEmailHtml(
      {
        severity: payload.severity,
        title: payload.title,
        message: payload.message,
        category: 'system',
      },
      dashboardUrl,
      unsubscribeUrl
    );

    // Try to send via CF Email Workers binding
    if (env?.SEND_EMAIL) {
      for (const address of config.addresses) {
        const rawMime = buildRawMimeEmail(fromEmail, address, subject, htmlBody);
        await env.SEND_EMAIL.send({
          from: fromEmail,
          to: address,
          raw: rawMime,
        });
      }
      return { sent: true };
    }

    // Fallback: log the email payload
    console.log('Email notification payload:', JSON.stringify({
      to: config.addresses,
      subject,
      from: fromEmail,
    }));

    return {
      sent: true,
      error: undefined,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Email dispatch failed:', errorMsg);
    return {
      sent: false,
      error: `Failed to send email notification: ${errorMsg}`,
    };
  }
}
