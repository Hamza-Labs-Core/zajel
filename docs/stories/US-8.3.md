# US-8.3: Webhook Notifications

## Story
As an admin, I want webhook URLs for Slack/Discord integration, so that alert notifications are delivered to team communication channels automatically.

## Acceptance Criteria
- Admins can configure one or more webhook URLs in the Notifications settings tab, each with:
  - A target URL (HTTPS required).
  - An optional authentication header (e.g., `Authorization: Bearer <token>` for custom webhook receivers).
  - A severity filter: receive only `critical`, `critical + warning`, or `all`.
  - A cooldown period (default: 5 minutes) to prevent flooding the webhook endpoint.
  - An optional description/label (e.g., "Slack #ops-alerts").
- When an alert fires, an HTTP POST is sent to each matching webhook URL with a JSON payload that includes: severity, title, message, category, timestamp, and a dashboard link.
- The webhook payload format is compatible with Slack's incoming webhook format (top-level `text` field) and Discord's webhook format (embeds array with color-coded severity). A `format` field in the config selects between `generic`, `slack`, and `discord` payload formats.
- Webhook delivery uses a 5-second timeout. If the target does not respond with a 2xx status within 5 seconds, the delivery is marked as `failed` in `alert_history`.
- Failed webhook deliveries are retried once after a 30-second delay (via a scheduled alarm on the NotificationDO).
- The Notifications settings tab shows configured webhooks with their label, URL (partially masked), severity filter, last delivery status, and enable/disable toggle.
- A "Test" button next to each webhook sends a test notification and shows the delivery result (success/failure with HTTP status code).
- Webhook URLs are stored encrypted in D1 (using the `ZAJEL_ADMIN_JWT_SECRET` as the encryption key via AES-GCM) since they may contain sensitive authentication tokens.
- Adding or editing a webhook requires the `super-admin` role.

## Technical Design

### Architecture
Webhook notifications are dispatched by the `NotificationDO` alongside email (US-8.2) and WebSocket (US-8.1) notifications. The dispatch flow is identical: when a notification arrives at the DO, it queries D1 for webhook channel configs, checks severity and cooldown, and sends HTTP POST requests to matching URLs.

Unlike email (which uses a CF binding), webhooks use the standard `fetch()` API to POST to external URLs. This is straightforward in CF Workers since outbound HTTP is fully supported.

For retry handling, the `NotificationDO` uses the Durable Object `alarm()` API. When a webhook delivery fails, the DO sets an alarm for 30 seconds later and stores the failed delivery in DO storage. When the alarm fires, the DO retries the failed deliveries and updates `alert_history`.

### Implementation Details

**Webhook dispatch in NotificationDO (`src/notification-do.ts` extension):**
- After WebSocket broadcast and email dispatch, query D1 for webhook configs: `SELECT * FROM notification_channels WHERE channel_type = 'webhook' AND enabled = 1`.
- For each config:
  1. Parse config JSON to extract URL, auth header, severity filter, cooldown, format.
  2. Check severity threshold (same logic as email).
  3. Check cooldown via KV: `webhook_cooldown:{sha256(url)}`.
  4. Construct the payload based on the `format` field.
  5. Send `fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) })`.
  6. If response is 2xx: record success in `alert_history`, update KV cooldown.
  7. If response is non-2xx or fetch throws: record failure, store retry info in DO storage, schedule alarm.

**Payload format construction (`src/webhook.ts`):**

```typescript
function buildWebhookPayload(
  notification: NotificationPayload,
  format: 'generic' | 'slack' | 'discord',
  dashboardUrl: string
): { body: string; contentType: string } {
  switch (format) {
    case 'slack':
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

    case 'discord':
      return {
        contentType: 'application/json',
        body: JSON.stringify({
          embeds: [{
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
          }],
        }),
      };

    case 'generic':
    default:
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
}

function severityToDiscordColor(severity: string): number {
  switch (severity) {
    case 'critical': return 0xEF4444; // red
    case 'warning':  return 0xEAB308; // yellow
    case 'info':     return 0x3B82F6; // blue
    default:         return 0x94A3B8; // gray
  }
}
```

**Retry via DO alarm (`src/notification-do.ts`):**
- On failed delivery, store the retry payload in DO storage: `retry:{timestamp}:{webhookConfigId}`.
- Call `this.ctx.storage.setAlarm(Date.now() + 30_000)` to schedule retry.
- In the `alarm()` handler: read all `retry:*` keys from storage, attempt redelivery, update `alert_history` in D1, delete the retry keys regardless of outcome (single retry only).

**Webhook URL encryption (`src/crypto.ts` extension):**
- Before storing a webhook config in D1, encrypt the URL and auth header using AES-256-GCM with a key derived from `ZAJEL_ADMIN_JWT_SECRET` via HKDF.
- `encryptWebhookConfig(config, secret)` -> returns base64-encoded ciphertext with IV prepended.
- `decryptWebhookConfig(ciphertext, secret)` -> returns the original config JSON.
- This prevents webhook URLs (which may contain tokens in query params) from being exposed if the D1 database is compromised.

**Webhook config API (`src/routes/notifications.ts` extension):**
- The same `POST /admin/api/notifications/config` endpoint handles both email and webhook channel types, differentiated by `channelType` in the request body.
- `POST /admin/api/notifications/config/test` -- sends a test notification to a specific webhook URL without saving the config. Returns the HTTP status code and response body from the target.

**Frontend (Notifications settings tab extension):**
- Below the email config table, add a "Webhooks" section.
- Form fields: URL (text input, required), Auth Header (text input, optional, type=password), Label (text input, optional), Format (select: generic/slack/discord), Severity Filter (select), Cooldown (number input, default 5).
- Table columns: Label, URL (masked: `https://hooks.slack.com/***`), Format, Severity, Cooldown, Last Status (green check / red X), Enabled toggle, Test button, Delete button.
- "Test" button calls `POST /admin/api/notifications/config/test` and shows a toast with the result.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/webhook.ts` | Create | Webhook payload construction for generic, Slack, and Discord formats |
| `packages/admin-cf/src/notification-do.ts` | Modify | Add webhook dispatch logic, retry via alarm(), encrypted config read |
| `packages/admin-cf/src/crypto.ts` | Modify | Add `encryptWebhookConfig` and `decryptWebhookConfig` using AES-256-GCM |
| `packages/admin-cf/src/routes/notifications.ts` | Modify | Add webhook config CRUD and test endpoint |
| `packages/admin-cf/src/index.ts` | Modify | Register test endpoint route; extend Notifications tab UI with webhook section |
| `packages/admin-cf/src/types.ts` | Modify | Add `WebhookChannelConfig`, `WebhookFormat` types |
| `packages/admin-cf/tests/unit/webhook.test.ts` | Create | Unit tests for payload construction and encryption |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Modify | Add webhook config CRUD E2E tests |

### Data Models / Schemas

**D1 (extends `notification_channels` from US-8.2):**

The same `notification_channels` table is used. The `config` JSON column contains webhook-specific fields:

```typescript
/** Webhook notification channel config (stored encrypted in notification_channels.config) */
interface WebhookChannelConfig {
  url: string;                                      // Target URL (HTTPS)
  authHeader?: string;                              // Optional auth header value
  label?: string;                                   // Human-readable label
  format: 'generic' | 'slack' | 'discord';          // Payload format
  severityFilter: 'critical' | 'warning' | 'info';  // Minimum severity
  cooldownMinutes: number;                           // Default 5
}

/** Webhook retry entry stored in DO storage */
interface WebhookRetry {
  webhookConfigId: number;
  url: string;           // Decrypted for retry
  authHeader?: string;
  format: 'generic' | 'slack' | 'discord';
  payload: NotificationPayload;
  firstAttemptAt: number;
  httpStatus?: number;
  errorMessage?: string;
}
```

### API Endpoints

**POST /admin/api/notifications/config** (same endpoint as US-8.2, supports webhook type)
- Auth: Bearer JWT required (super-admin only)
- Request body (webhook):
  ```json
  {
    "channelType": "webhook",
    "config": {
      "url": "https://hooks.slack.com/services/T00/B00/xxxxx",
      "authHeader": "Bearer slack-token-here",
      "label": "Slack #ops-alerts",
      "format": "slack",
      "severityFilter": "warning",
      "cooldownMinutes": 5
    }
  }
  ```
- Response: `{ "success": true, "data": { "id": 3 } }`
- Validation errors: 400 if URL is not HTTPS, if format is invalid, if cooldown < 1.

**POST /admin/api/notifications/config/test**
- Auth: Bearer JWT required (super-admin only)
- Request body:
  ```json
  {
    "channelType": "webhook",
    "config": {
      "url": "https://hooks.slack.com/services/T00/B00/xxxxx",
      "format": "slack"
    }
  }
  ```
- Response (success): `{ "success": true, "data": { "httpStatus": 200, "responseTime": 342 } }`
- Response (failure): `{ "success": false, "error": "Webhook returned HTTP 403", "data": { "httpStatus": 403, "responseTime": 1200 } }`

**PATCH /admin/api/notifications/config/:id/toggle**
- Auth: Bearer JWT required (super-admin only)
- Request body: `{ "enabled": false }`
- Response: `{ "success": true }`

## Dependencies
- **US-8.1 (Real-Time Dashboard Notifications):** The `NotificationDO` is the dispatch hub. Webhook dispatch is added alongside WebSocket broadcast.
- **US-8.2 (Email Notifications):** The `notification_channels` D1 table and the `notifications.ts` route handler are created in US-8.2. This story extends them.
- **US-8.4 (Alert Rule Management):** Alert rules trigger the notifications. Webhook dispatch works independently once `POST /admin/internal/notify` is called.
- **No external packages required.** Payload construction uses built-in `JSON.stringify`. Encryption uses the Web Crypto API (`crypto.subtle`).

## Testing Strategy

- **Unit tests:**
  - Test `buildWebhookPayload` for each format:
    - `generic`: verify JSON has severity, title, message, category, timestamp, dashboardLink.
    - `slack`: verify JSON has `text` field and `blocks` array with `mrkdwn` section.
    - `discord`: verify JSON has `embeds` array with color matching severity, title, description, fields.
  - Test `severityToDiscordColor` mapping.
  - Test `encryptWebhookConfig` / `decryptWebhookConfig` round-trip: encrypt then decrypt returns original config.
  - Test webhook URL validation: reject non-HTTPS URLs, reject URLs without a host.
  - Test cooldown logic: same pattern as email (KV-based).
  - Test retry storage: verify retry key format and alarm scheduling.

- **Integration tests:**
  - Seed D1 with a webhook channel config, send a notification to the DO, and verify `fetch()` is called with the correct URL, headers, and body.
  - Test retry: mock `fetch()` to fail on first call, verify alarm is set, fire the alarm, verify `fetch()` is called again.
  - Test cooldown: send two notifications in quick succession, verify only the first triggers a webhook call.

- **E2E tests:**
  - `POST /admin/api/notifications/config` with a webhook channel returns 200.
  - `POST /admin/api/notifications/config/test` with a valid webhook URL returns the HTTP status from the target.
  - `GET /admin/api/notifications/config` lists both email and webhook channels.
  - `PATCH /admin/api/notifications/config/:id/toggle` with `enabled: false` disables the channel.
  - Webhook config CRUD requires super-admin role.

## Technical Notes

**Codebase patterns to follow:**
- The existing `fetchFromBootstrap` in `routes/servers.ts` shows the pattern for outbound `fetch()` from CF Workers with error handling. Follow the same try/catch approach for webhook delivery.
- The existing `crypto.ts` in `packages/admin-cf/src/` already has `hashPassword`, `verifyPassword`, and `generateJwt` functions. Add `encryptWebhookConfig` and `decryptWebhookConfig` following the same module pattern.
- The `requireSuperAdmin` middleware in `routes/auth.ts` is already implemented. Use it for all webhook config mutation endpoints.

**CF Workers fetch() for webhooks:**
- CF Workers support outbound `fetch()` to external HTTPS URLs with no restrictions. The 5-second timeout is implemented via `AbortSignal.timeout(5000)` (supported in the Workers runtime).
- Be aware of the 50ms CPU time limit per request in Workers. Webhook delivery may consume CPU time for JSON serialization and the fetch itself. If dispatching to many webhooks, consider sending them in parallel with `Promise.allSettled()` to stay within limits.
- The DO runtime has more generous CPU limits (30 seconds wall clock per request), so dispatching from the DO is preferred over the Worker.

**DO alarm() for retry:**
- Durable Objects support `this.ctx.storage.setAlarm(scheduledTime)` to wake the DO at a future time. Only one alarm can be active at a time. If multiple webhooks fail in the same notification, store all retries and handle them in a single alarm firing.
- The `alarm()` handler is a method on the DO class. It runs with the same CPU budget as a `fetch()` handler.

**Webhook URL encryption:**
- Use `crypto.subtle.importKey('raw', keyMaterial, 'AES-GCM', false, ['encrypt', 'decrypt'])` with key material derived from `ZAJEL_ADMIN_JWT_SECRET` via HKDF (SHA-256, salt = "webhook-config", info = "aes-gcm-key").
- IV: generate 12 random bytes per encryption. Prepend IV to ciphertext. On decrypt, split first 12 bytes as IV.
- The `config` column in `notification_channels` stores `base64(iv + ciphertext)` for webhook types and plaintext JSON for email types. Differentiate by `channel_type`.

**Slack/Discord payload compatibility:**
- Slack incoming webhooks accept `{ text: "..." }` as the minimum payload. The `blocks` array provides rich formatting. Both are included for maximum compatibility.
- Discord webhooks accept `{ embeds: [...] }`. The `color` field is a decimal integer, not a hex string. Use `0xEF4444` (not `"#EF4444"`).
- Both Slack and Discord return 2xx on success. Slack returns `ok` as the response body; Discord returns a JSON object.

**URL masking for UI:**
- Webhook URLs may contain tokens (e.g., Slack webhook URLs have the token in the path). Mask the URL in API responses: show the scheme and host, mask the path. Example: `https://hooks.slack.com/***`.

## Estimation
**M (Medium)** -- The payload construction for three formats is the main implementation work. Encryption, cooldown, and retry logic add moderate complexity but follow patterns established in US-8.2 (email). The UI extends the existing Notifications tab. Estimated 2-3 days.
