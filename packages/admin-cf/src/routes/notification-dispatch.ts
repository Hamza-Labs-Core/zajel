/**
 * Notification dispatch utilities (US-8.2, US-8.3)
 *
 * Helper functions for sending notifications to webhook and email channels.
 * These are NOT route handlers -- they are used by notification-config.ts
 * and can be called by alert rule processors.
 */

import type { WebhookConfig, EmailConfig } from '../types.js';

// ─── Types ──────────────────────────────────────

export interface NotificationPayload {
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
 * Makes an HTTP POST with the notification payload as JSON.
 * Includes optional Authorization header from config.
 */
export async function dispatchWebhook(
  config: WebhookConfig,
  payload: NotificationPayload
): Promise<DispatchResult> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.authHeader) {
      headers['Authorization'] = config.authHeader;
    }

    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        severity: payload.severity,
        title: payload.title,
        message: payload.message,
        timestamp: payload.timestamp,
        dashboardUrl: payload.dashboardUrl,
      }),
    });

    return {
      sent: response.ok,
      statusCode: response.status,
    };
  } catch (error) {
    console.error('Webhook dispatch failed:', error);
    return {
      sent: false,
      error: 'Failed to deliver webhook notification',
    };
  }
}

// ─── Email Dispatch ─────────────────────────────

/**
 * Construct and log an email notification payload.
 *
 * For now, this formats the payload for MailChannels API or similar
 * service and logs it. Actual send requires secrets configuration.
 */
export async function dispatchEmail(
  config: EmailConfig,
  payload: NotificationPayload
): Promise<DispatchResult> {
  try {
    const severityLabel = payload.severity.charAt(0).toUpperCase() + payload.severity.slice(1);
    const subject = `[Zajel Alert] ${severityLabel}: ${payload.title}`;
    const body = [
      `Severity: ${severityLabel}`,
      `Title: ${payload.title}`,
      '',
      payload.message,
      '',
      `Timestamp: ${new Date(payload.timestamp).toISOString()}`,
      `Dashboard: ${payload.dashboardUrl}`,
      '',
      '---',
      'To unsubscribe, update your notification settings in the Zajel admin dashboard.',
    ].join('\n');

    const emailPayload = {
      to: config.addresses,
      subject,
      body,
    };

    // Log the email payload (actual send requires mail service integration)
    console.log('Email notification payload:', JSON.stringify(emailPayload));

    return {
      sent: false,
      error: 'Email delivery not configured — payload logged only',
    };
  } catch (error) {
    console.error('Email dispatch failed:', error);
    return {
      sent: false,
      error: 'Failed to format email notification',
    };
  }
}
