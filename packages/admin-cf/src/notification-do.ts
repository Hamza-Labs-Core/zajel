/**
 * NotificationDO - Durable Object for real-time notification management (US-8.1, US-8.2, US-8.3)
 *
 * Uses the WebSocket Hibernation API for zero-cost idle connections.
 * Handles WebSocket broadcast, email dispatch, webhook dispatch, and retry via alarm().
 */

import type {
  Env,
  NotificationPayload,
  StoredNotification,
  NotificationWsMessage,
  NotificationClientMessage,
  WsSessionAttachment,
  WebhookRetry,
} from './types.js';
import { generateId, generateJwt, verifyJwt, decryptWebhookConfig } from './crypto.js';
import {
  buildEmailSubject,
  buildEmailHtml,
  buildRawMimeEmail,
  getSenderEmail,
  passesSeverityFilter,
  hashEmail,
} from './email.js';
import { buildWebhookPayload } from './webhook.js';

const MAX_STORED_NOTIFICATIONS = 200;
const WEBHOOK_TIMEOUT_MS = 5000;
const WEBHOOK_RETRY_DELAY_MS = 30_000;

/** Notification config row from D1 notification_config table */
interface NotificationConfigRow {
  id: number;
  channel_type: string;
  enabled: number;
  config: string;
  updated_at: number;
  updated_by: string;
}

export class NotificationDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    // Set up auto-response for ping/pong keepalive (does not wake DO from hibernation)
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === '/ws' && method === 'GET') {
        return this.handleWebSocketUpgrade(request);
      }

      if (path === '/notify' && method === 'POST') {
        return this.handleNotify(request);
      }

      if (path === '/notifications' && method === 'GET') {
        return this.handleGetNotifications(request);
      }

      return this.jsonResponse({ success: false, error: 'Not found' }, 404);
    } catch (error) {
      console.error('NotificationDO error:', error);
      return this.jsonResponse({ success: false, error: 'Internal server error' }, 500);
    }
  }

  // ─── WebSocket Upgrade ──────────────────────────

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    // Extract JWT from query param
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return this.jsonResponse({ success: false, error: 'Missing token' }, 401);
    }

    // Verify JWT
    const payload = await verifyJwt<{
      sub: string;
      username: string;
      role: 'admin' | 'super-admin';
    }>(token, this.env.ZAJEL_ADMIN_JWT_SECRET);

    if (!payload) {
      return this.jsonResponse({ success: false, error: 'Invalid or expired token' }, 401);
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept the WebSocket with user ID as tag for targeted notifications
    this.state.acceptWebSocket(server, [payload.sub]);

    // Attach session info for persistence across hibernation
    const attachment: WsSessionAttachment = {
      userId: payload.sub,
      username: payload.username,
      role: payload.role,
      connectedAt: Date.now(),
    };
    server.serializeAttachment(attachment);

    // Send initial notification list on connect
    const notifications = await this.getStoredNotifications(50);
    const unreadCount = notifications.filter(
      (n) => !n.readBy.includes(payload.sub)
    ).length;

    const initMessage: NotificationWsMessage = {
      type: 'notification_list',
      data: notifications,
      unreadCount,
    };
    server.send(JSON.stringify(initMessage));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // ─── Internal Notify ────────────────────────────

  private async handleNotify(request: Request): Promise<Response> {
    let payload: NotificationPayload;
    try {
      payload = (await request.json()) as NotificationPayload;
    } catch {
      return this.jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
    }

    if (!payload.severity || !payload.title || !payload.message) {
      return this.jsonResponse(
        { success: false, error: 'Missing required fields: severity, title, message' },
        400
      );
    }

    // Create stored notification
    const notification: StoredNotification = {
      id: generateId(),
      severity: payload.severity,
      title: payload.title,
      message: payload.message,
      category: payload.category || 'system',
      link: payload.link,
      timestamp: Date.now(),
      readBy: [],
    };

    // Store notification
    await this.storeNotification(notification);

    // Broadcast to all connected WebSockets
    const delivered = this.broadcastNotification(notification);

    // Store in D1 notifications table for REST API
    await this.storeNotificationInD1(notification, payload);

    // Dispatch to email and webhook channels (async, non-blocking)
    this.dispatchToChannels(payload, notification).catch((err) => {
      console.error('Channel dispatch error:', err);
    });

    return this.jsonResponse({
      success: true,
      data: { id: notification.id, delivered },
    });
  }

  // ─── Get Notifications ──────────────────────────

  private async handleGetNotifications(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 50, 200) : 50;

    const notifications = await this.getStoredNotifications(limit);

    return this.jsonResponse({
      success: true,
      data: {
        notifications,
        total: notifications.length,
      },
    });
  }

  // ─── WebSocket Hibernation Handlers ─────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
      const msg = JSON.parse(data) as NotificationClientMessage;

      const attachment = ws.deserializeAttachment() as WsSessionAttachment | null;
      if (!attachment) return;

      if (msg.type === 'mark_read' && msg.id) {
        await this.markNotificationRead(msg.id, attachment.userId);
        const ackMessage: NotificationWsMessage = { type: 'read_ack', id: msg.id };
        ws.send(JSON.stringify(ackMessage));
      } else if (msg.type === 'mark_all_read') {
        await this.markAllNotificationsRead(attachment.userId);
      }
    } catch (error) {
      console.error('webSocketMessage error:', error);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // WebSocket closed; the runtime handles cleanup.
    // If the DO has no other WebSockets, it will hibernate.
    try {
      ws.close(code, reason);
    } catch {
      // Already closed
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('WebSocket error:', error);
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // Already closed
    }
  }

  // ─── Alarm Handler (Webhook Retry) ──────────────

  async alarm(): Promise<void> {
    // Process webhook retries
    const retryKeys = await this.state.storage.list<WebhookRetry>({
      prefix: 'retry:',
    });

    if (retryKeys.size === 0) return;

    for (const [key, retry] of retryKeys) {
      try {
        const { body, contentType } = buildWebhookPayload(
          retry.payload,
          retry.format,
          this.getDashboardUrl()
        );

        const headers: Record<string, string> = {
          'Content-Type': contentType,
        };
        if (retry.authHeader) {
          headers['Authorization'] = retry.authHeader;
        }

        const response = await fetch(retry.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        });

        // Record result in alert_history
        await this.recordAlertHistory(
          retry.webhookConfigId,
          retry.payload,
          'webhook',
          response.ok ? 'sent' : 'failed',
          response.ok ? undefined : `HTTP ${response.status} on retry`
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await this.recordAlertHistory(
          retry.webhookConfigId,
          retry.payload,
          'webhook',
          'failed',
          `Retry failed: ${errorMsg}`
        );
      }

      // Delete retry key regardless of outcome (single retry only)
      await this.state.storage.delete(key);
    }
  }

  // ─── Storage Helpers ────────────────────────────

  private async storeNotification(notification: StoredNotification): Promise<void> {
    const key = `notification:${notification.timestamp}:${notification.id}`;
    await this.state.storage.put(key, notification);

    // Prune old notifications if over limit
    const allKeys = await this.state.storage.list<StoredNotification>({
      prefix: 'notification:',
    });

    if (allKeys.size > MAX_STORED_NOTIFICATIONS) {
      // Keys are sorted lexicographically, oldest first
      const keysArray = Array.from(allKeys.keys());
      const toDelete = keysArray.slice(0, keysArray.length - MAX_STORED_NOTIFICATIONS);
      for (const k of toDelete) {
        await this.state.storage.delete(k);
      }
    }
  }

  private async getStoredNotifications(limit: number): Promise<StoredNotification[]> {
    const allEntries = await this.state.storage.list<StoredNotification>({
      prefix: 'notification:',
      reverse: true,
      limit,
    });

    return Array.from(allEntries.values());
  }

  private async markNotificationRead(notificationId: string, userId: string): Promise<void> {
    // Find the notification
    const allEntries = await this.state.storage.list<StoredNotification>({
      prefix: 'notification:',
    });

    for (const [key, notification] of allEntries) {
      if (notification.id === notificationId) {
        if (!notification.readBy.includes(userId)) {
          notification.readBy.push(userId);
          await this.state.storage.put(key, notification);
        }
        break;
      }
    }
  }

  private async markAllNotificationsRead(userId: string): Promise<void> {
    const allEntries = await this.state.storage.list<StoredNotification>({
      prefix: 'notification:',
    });

    for (const [key, notification] of allEntries) {
      if (!notification.readBy.includes(userId)) {
        notification.readBy.push(userId);
        await this.state.storage.put(key, notification);
      }
    }
  }

  // ─── Broadcast ──────────────────────────────────

  private broadcastNotification(notification: StoredNotification): number {
    const sockets = this.state.getWebSockets();
    let delivered = 0;

    const message: NotificationWsMessage = {
      type: 'notification',
      data: notification,
    };
    const messageStr = JSON.stringify(message);

    for (const ws of sockets) {
      try {
        ws.send(messageStr);
        delivered++;
      } catch (error) {
        // Socket may be closed/errored; skip
        console.error('Failed to send to WebSocket:', error);
      }
    }

    return delivered;
  }

  // ─── D1 Persistence ─────────────────────────────

  private async storeNotificationInD1(
    notification: StoredNotification,
    payload: NotificationPayload
  ): Promise<void> {
    if (!this.env.DIAGNOSTICS_DB) return;

    try {
      await this.env.DIAGNOSTICS_DB.prepare(
        `INSERT INTO notifications (rule_id, severity, title, message, source, channels_notified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          payload.ruleId ?? null,
          notification.severity,
          notification.title,
          notification.message,
          payload.source ?? 'system',
          JSON.stringify(['dashboard']),
          notification.timestamp
        )
        .run();
    } catch (error) {
      console.error('Failed to store notification in D1:', error);
    }
  }

  // ─── Channel Dispatch ───────────────────────────

  private async dispatchToChannels(
    payload: NotificationPayload,
    notification: StoredNotification
  ): Promise<void> {
    if (!this.env.DIAGNOSTICS_DB) return;

    const [emailResults, webhookResults] = await Promise.allSettled([
      this.dispatchEmailNotifications(payload, notification),
      this.dispatchWebhookNotifications(payload, notification),
    ]);

    if (emailResults.status === 'rejected') {
      console.error('Email dispatch failed:', emailResults.reason);
    }
    if (webhookResults.status === 'rejected') {
      console.error('Webhook dispatch failed:', webhookResults.reason);
    }
  }

  // ─── Email Dispatch ─────────────────────────────

  private async dispatchEmailNotifications(
    payload: NotificationPayload,
    notification: StoredNotification
  ): Promise<void> {
    if (!this.env.DIAGNOSTICS_DB) return;

    // Check if SEND_EMAIL binding exists
    if (!this.env.SEND_EMAIL) {
      console.warn('SEND_EMAIL binding not configured; skipping email dispatch');
      return;
    }

    try {
      const result = await this.env.DIAGNOSTICS_DB.prepare(
        `SELECT id, channel_type, enabled, config, updated_at, updated_by
         FROM notification_config WHERE channel_type = 'email' AND enabled = 1`
      ).all<NotificationConfigRow>();

      if (!result.results || result.results.length === 0) return;

      for (const row of result.results) {
        let config: { addresses?: string[]; severityFilter?: string[]; cooldownMinutes?: number };
        try {
          config = JSON.parse(row.config);
        } catch {
          continue;
        }

        const addresses = config.addresses || [];
        const severityFilter = config.severityFilter || [];
        const cooldownMinutes = config.cooldownMinutes ?? 60;

        // Check severity filter: notification must match at least one configured severity
        // or if severityFilter contains 'info', all pass; 'warning' means warning+critical; 'critical' means critical only
        const minSeverity = this.getMinSeverityFromFilter(severityFilter);
        if (!passesSeverityFilter(payload.severity, minSeverity)) continue;

        for (const address of addresses) {
          // Hash email once per address for cooldown key
          const emailHash = this.env.ADMIN_KV ? await hashEmail(address) : '';
          const cooldownKey = `email_cooldown:${emailHash}`;

          // Check cooldown via KV
          if (this.env.ADMIN_KV) {
            const existing = await this.env.ADMIN_KV.get(cooldownKey);
            if (existing) {
              // Cooldown active, skip
              continue;
            }
          }

          try {
            // Build email
            const fromEmail = getSenderEmail(this.env.NOTIFICATION_FROM_EMAIL);
            const subject = buildEmailSubject(payload);

            // Generate unsubscribe JWT
            const unsubscribeToken = await generateJwt(
              { email: address, purpose: 'unsubscribe' },
              this.env.ZAJEL_ADMIN_JWT_SECRET,
              60 * 24 * 30 // 30 days
            );
            const dashboardUrl = this.getDashboardUrl();
            const unsubscribeUrl = `${dashboardUrl}/admin/api/notifications/unsubscribe?token=${unsubscribeToken}`;

            const htmlBody = buildEmailHtml(payload, dashboardUrl, unsubscribeUrl);
            const rawMime = buildRawMimeEmail(fromEmail, address, subject, htmlBody);

            // Send via CF Email Workers binding
            const emailMessage = {
              from: fromEmail,
              to: address,
              raw: rawMime,
            };
            await this.env.SEND_EMAIL.send(emailMessage);

            // Set cooldown in KV (reuse cached hash)
            if (this.env.ADMIN_KV) {
              await this.env.ADMIN_KV.put(cooldownKey, String(Date.now()), {
                expirationTtl: cooldownMinutes * 60,
              });
            }

            // Record success
            await this.recordAlertHistory(
              payload.ruleId ?? 0,
              payload,
              'email',
              'sent'
            );
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            console.error(`Failed to send email to ${address}:`, errorMsg);
            await this.recordAlertHistory(
              payload.ruleId ?? 0,
              payload,
              'email',
              'failed',
              errorMsg
            );
          }
        }
      }
    } catch (error) {
      console.error('Email dispatch query error:', error);
    }
  }

  // ─── Webhook Dispatch ───────────────────────────

  private async dispatchWebhookNotifications(
    payload: NotificationPayload,
    _notification: StoredNotification
  ): Promise<void> {
    if (!this.env.DIAGNOSTICS_DB) return;

    try {
      const result = await this.env.DIAGNOSTICS_DB.prepare(
        `SELECT id, channel_type, enabled, config, updated_at, updated_by
         FROM notification_config WHERE channel_type = 'webhook' AND enabled = 1`
      ).all<NotificationConfigRow>();

      if (!result.results || result.results.length === 0) return;

      const failedRetries: WebhookRetry[] = [];

      for (const row of result.results) {
        let config: {
          url?: string;
          authHeader?: string;
          severityFilter?: string[];
          format?: string;
          cooldownMinutes?: number;
        };
        try {
          let rawConfig = row.config;
          // Decrypt encrypted webhook configs
          if (rawConfig.startsWith('enc:') && this.env.ZAJEL_ADMIN_JWT_SECRET) {
            rawConfig = await decryptWebhookConfig(rawConfig.slice(4), this.env.ZAJEL_ADMIN_JWT_SECRET);
          }
          config = JSON.parse(rawConfig);
        } catch {
          continue;
        }

        const url = config.url;
        if (!url) continue;

        const severityFilter = config.severityFilter || [];
        const format = (config.format || 'generic') as 'generic' | 'slack' | 'discord';
        const cooldownMinutes = config.cooldownMinutes ?? 5;

        // Check severity filter
        const minSeverity = this.getMinSeverityFromFilter(severityFilter);
        if (!passesSeverityFilter(payload.severity, minSeverity)) continue;

        // Hash URL once for cooldown key
        const urlHash = this.env.ADMIN_KV ? await hashEmail(url) : '';
        const webhookCooldownKey = `webhook_cooldown:${urlHash}`;

        // Check cooldown via KV
        if (this.env.ADMIN_KV) {
          const existing = await this.env.ADMIN_KV.get(webhookCooldownKey);
          if (existing) continue;
        }

        const { body, contentType } = buildWebhookPayload(
          payload,
          format,
          this.getDashboardUrl()
        );

        const headers: Record<string, string> = {
          'Content-Type': contentType,
        };
        if (config.authHeader) {
          headers['Authorization'] = config.authHeader;
        }

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          });

          if (response.ok) {
            // Update cooldown in KV (reuse cached hash)
            if (this.env.ADMIN_KV) {
              await this.env.ADMIN_KV.put(webhookCooldownKey, String(Date.now()), {
                expirationTtl: cooldownMinutes * 60,
              });
            }

            await this.recordAlertHistory(row.id, payload, 'webhook', 'sent');
          } else {
            // Schedule retry
            failedRetries.push({
              webhookConfigId: row.id,
              url,
              authHeader: config.authHeader,
              format,
              payload,
              firstAttemptAt: Date.now(),
              httpStatus: response.status,
              errorMessage: `HTTP ${response.status}`,
            });

            await this.recordAlertHistory(
              row.id,
              payload,
              'webhook',
              'failed',
              `HTTP ${response.status}`
            );
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          failedRetries.push({
            webhookConfigId: row.id,
            url,
            authHeader: config.authHeader,
            format,
            payload,
            firstAttemptAt: Date.now(),
            errorMessage: errorMsg,
          });

          await this.recordAlertHistory(
            row.id,
            payload,
            'webhook',
            'failed',
            errorMsg
          );
        }
      }

      // Store retries and schedule alarm
      if (failedRetries.length > 0) {
        for (const retry of failedRetries) {
          const retryKey = `retry:${Date.now()}:${retry.webhookConfigId}`;
          await this.state.storage.put(retryKey, retry);
        }
        await this.state.storage.setAlarm(Date.now() + WEBHOOK_RETRY_DELAY_MS);
      }
    } catch (error) {
      console.error('Webhook dispatch query error:', error);
    }
  }

  // ─── Helpers ────────────────────────────────────

  private getMinSeverityFromFilter(severityFilter: string[]): string {
    // If the filter includes 'info', minimum is info (all pass)
    // If includes 'warning', minimum is warning (warning+critical pass)
    // If includes 'critical', minimum is critical (only critical passes)
    // If empty, default to 'info' (all pass)
    if (severityFilter.length === 0) return 'info';
    if (severityFilter.includes('info')) return 'info';
    if (severityFilter.includes('warning')) return 'warning';
    return 'critical';
  }

  private getDashboardUrl(): string {
    return 'https://admin.zajel.hamzalabs.dev';
  }

  private async recordAlertHistory(
    ruleId: number,
    payload: NotificationPayload,
    channel: string,
    status: string,
    errorMsg?: string
  ): Promise<void> {
    if (!this.env.DIAGNOSTICS_DB) return;

    try {
      await this.env.DIAGNOSTICS_DB.prepare(
        `INSERT INTO alert_history (rule_id, triggered_at, message, channels_notified, delivery_status, delivery_error)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          ruleId,
          Date.now(),
          `[${payload.severity.toUpperCase()}] ${payload.title}: ${payload.message}`,
          JSON.stringify([channel]),
          status,
          errorMsg ?? null
        )
        .run();
    } catch (error) {
      console.error('Failed to record alert history:', error);
    }
  }

  private jsonResponse<T>(data: T, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  }
}
