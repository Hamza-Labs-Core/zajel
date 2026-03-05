# US-8.2: Email Notifications

## Story
As an admin, I want email alerts for critical events, so that I am notified of important issues even when not actively viewing the dashboard.

## Acceptance Criteria
- Admins can configure one or more email addresses to receive alert notifications, via the Notifications settings tab in the admin portal.
- Each configured email address has a severity filter: receive only `critical`, `critical + warning`, or `all` (critical + warning + info).
- A cooldown period is configurable per email address (default: 60 minutes). After an email is sent to an address, no further emails are sent to that address until the cooldown expires, regardless of severity. This prevents email flooding during cascading failures.
- Each email includes an unsubscribe link that, when clicked, disables email notifications for that address without requiring dashboard login.
- Email content includes: alert severity, title, message body, timestamp, and a direct link to the relevant dashboard section.
- Email is sent via Cloudflare Email Workers (`send_email` binding) using the project's domain for the sender address.
- If the email binding is not configured (e.g., local dev or Email Routing not enabled), the notification is silently skipped with a warning logged -- it does not block other notification channels.
- Email delivery failures are recorded in the `alert_history` D1 table with a `delivery_status` of `failed` and the error message.
- The Notifications settings tab shows a table of configured email addresses with severity filter, cooldown, and a delete button.
- Adding a new email address sends a test email to verify deliverability before saving.

## Technical Design

### Architecture
Email notifications are dispatched by the `NotificationDO` (from US-8.1) when an alert fires. The `NotificationDO` checks the notification config stored in D1 to determine which email addresses should receive the alert based on severity filters and cooldown state. It then calls the admin-cf Worker's `send_email` binding to send the email.

The flow:
1. Alert rule fires (US-8.4) and calls `POST /admin/internal/notify` on the admin-cf Worker.
2. The Worker forwards to `NotificationDO`.
3. `NotificationDO` broadcasts via WebSocket (US-8.1) and checks email channel config in D1.
4. For each matching email address (severity >= configured threshold and cooldown expired), construct an email and call `env.SEND_EMAIL.send(message)`.
5. Record the delivery attempt in `alert_history`.

The email configuration is stored in D1 (not in DO storage) so it can be queried by the admin API for the settings UI. The cooldown state (last-sent timestamp per email) is stored in KV for fast reads.

### Implementation Details

**Email dispatch in NotificationDO (`src/notification-do.ts` extension):**
- After broadcasting via WebSocket, the `handleNotify()` method also queries D1 for email notification configs where `channel = 'email'` and `enabled = 1`.
- For each config row:
  1. Check severity threshold: skip if notification severity is below the configured threshold (e.g., `info` alert skipped for a `critical`-only config).
  2. Check cooldown: read KV key `email_cooldown:{email_hash}` to get the last-sent timestamp. Skip if `now - last_sent < cooldown_minutes * 60 * 1000`.
  3. Construct the email using the `EmailMessage` class from `cloudflare:email`.
  4. Send via `env.SEND_EMAIL.send(message)`.
  5. Update cooldown in KV: `put('email_cooldown:{email_hash}', now.toString(), { expirationTtl: cooldown_minutes * 60 })`.
  6. Record in D1 `alert_history`: rule_id, triggered_at, message, `channels_notified = 'email'`, delivery_status.

**Email message construction (`src/email.ts`):**
- Use the `EmailMessage` class from `cloudflare:email` and the `MimeMessage` class from `mimetext` (add to package.json).
- Sender: `notifications@zajel.hamzalabs.dev` (or configurable via env var `NOTIFICATION_FROM_EMAIL`).
- Subject: `[Zajel Alert - {SEVERITY}] {title}`.
- Body: HTML email with:
  - Header with Zajel branding (inline CSS, no external assets).
  - Severity badge (color-coded).
  - Alert title and message.
  - Timestamp in UTC.
  - "View in Dashboard" button linking to the relevant dashboard section.
  - Footer with unsubscribe link.
- The unsubscribe link points to `GET /admin/api/notifications/unsubscribe?token={jwt}` where the JWT encodes the email address and is signed with `ZAJEL_ADMIN_JWT_SECRET`. This avoids needing a database lookup for the email.

**Unsubscribe endpoint (`src/routes/notifications.ts`):**
- `GET /admin/api/notifications/unsubscribe?token={jwt}` -- No auth required (the JWT in the query param is the auth). Verify the JWT, extract the email address, set `enabled = 0` in D1 for that email config. Return a simple HTML page confirming unsubscription.

**Email config API (`src/routes/notifications.ts`):**
- `GET /admin/api/notifications/config` -- Return all notification channel configs (email + webhook) for the settings UI.
- `POST /admin/api/notifications/config` -- Add or update a notification channel config. For email channels, send a test email before saving. If the test email fails, return 400 with the error.
- `DELETE /admin/api/notifications/config/:id` -- Remove a channel config.

**Frontend (Notifications settings tab):**
- A form to add a new email address: input for email, select for severity filter (critical / warning / info), input for cooldown minutes (default 60).
- On submit, the API sends a test email and only saves if the test succeeds.
- A table listing configured emails with columns: email (partially masked, e.g., `a***@example.com`), severity filter, cooldown, enabled status, and a delete button.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/email.ts` | Create | Email message construction helper using `cloudflare:email` and `mimetext` |
| `packages/admin-cf/src/routes/notifications.ts` | Create | Notification config CRUD API + unsubscribe endpoint |
| `packages/admin-cf/src/routes/index.ts` | Modify | Re-export from `notifications.ts` |
| `packages/admin-cf/src/notification-do.ts` | Modify | Add email dispatch logic after WebSocket broadcast |
| `packages/admin-cf/src/index.ts` | Modify | Register notification config routes and unsubscribe endpoint; add Notifications settings tab to dashboard HTML |
| `packages/admin-cf/src/types.ts` | Modify | Add `NotificationChannelConfig`, `EmailConfig` interfaces; extend `Env` with `SEND_EMAIL` binding and `ADMIN_KV` |
| `packages/admin-cf/wrangler.jsonc` | Modify | Add `send_email` binding and `kv_namespaces` for `ADMIN_KV` |
| `packages/admin-cf/package.json` | Modify | Add `mimetext` dependency |
| `packages/admin-cf/tests/unit/email.test.ts` | Create | Unit tests for email construction and severity filtering |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Modify | Add notification config CRUD E2E tests |

### Data Models / Schemas

**D1 Tables (in diagnostics DB, shared):**

```sql
-- Notification channel configuration
CREATE TABLE notification_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_type TEXT NOT NULL,              -- 'email' | 'webhook'
  config TEXT NOT NULL,                    -- JSON: { address, severity_filter, cooldown_minutes } for email
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,                -- admin user ID
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Extend alert_history with delivery_status (from plan's schema)
-- Already defined in Section 4.6, adding delivery_status:
CREATE TABLE alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL,
  triggered_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  channels_notified TEXT NOT NULL,          -- JSON array of channel types
  delivery_status TEXT DEFAULT 'sent',      -- 'sent' | 'failed' | 'skipped'
  delivery_error TEXT,                      -- error message if failed
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id)
);
```

**TypeScript interfaces:**

```typescript
/** Email notification channel config (stored as JSON in notification_channels.config) */
interface EmailChannelConfig {
  address: string;
  severityFilter: 'critical' | 'warning' | 'info';  // minimum severity to send
  cooldownMinutes: number;
}

/** Notification channel config row */
interface NotificationChannelRow {
  id: number;
  channelType: 'email' | 'webhook';
  config: string;  // JSON
  enabled: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** Env additions */
interface Env {
  // ... existing bindings
  SEND_EMAIL?: SendEmail;         // CF Email Workers binding (optional)
  ADMIN_KV?: KVNamespace;         // For cooldown state
  DIAGNOSTICS_DB?: D1Database;    // For notification_channels table
  NOTIFICATION_FROM_EMAIL?: string; // Sender address (default: notifications@zajel.hamzalabs.dev)
}
```

### API Endpoints

**GET /admin/api/notifications/config**
- Auth: Bearer JWT required (admin or super-admin)
- Response:
  ```json
  {
    "success": true,
    "data": {
      "channels": [
        {
          "id": 1,
          "channelType": "email",
          "config": { "address": "a***@example.com", "severityFilter": "critical", "cooldownMinutes": 60 },
          "enabled": true,
          "createdAt": 1709380800000
        }
      ]
    }
  }
  ```

**POST /admin/api/notifications/config**
- Auth: Bearer JWT required (super-admin only)
- Request body:
  ```json
  {
    "channelType": "email",
    "config": {
      "address": "admin@example.com",
      "severityFilter": "warning",
      "cooldownMinutes": 30
    }
  }
  ```
- Response: `{ "success": true, "data": { "id": 2, "testEmailSent": true } }`
- Error: `{ "success": false, "error": "Test email failed: ..." }` (400)

**DELETE /admin/api/notifications/config/:id**
- Auth: Bearer JWT required (super-admin only)
- Response: `{ "success": true }`

**GET /admin/api/notifications/unsubscribe?token={jwt}**
- Auth: JWT embedded in query param (self-contained, no session needed)
- Response: HTML page confirming unsubscription

## Dependencies
- **US-8.1 (Real-Time Dashboard Notifications):** The `NotificationDO` created in US-8.1 is extended here with email dispatch logic.
- **US-8.4 (Alert Rule Management):** Alert rules trigger notifications. However, the email dispatch can be tested independently by calling `POST /admin/internal/notify` directly.
- **Cloudflare Email Routing:** Must be enabled on the `zajel.hamzalabs.dev` domain with at least one verified destination address. The `send_email` binding must be configured.
- **`mimetext` npm package:** For constructing MIME email messages. MIT-licensed, lightweight (<10KB).

## Testing Strategy

- **Unit tests:**
  - Test email message construction: verify subject line format, HTML body contains severity badge, timestamp, dashboard link, and unsubscribe link.
  - Test severity filtering logic: `critical` notification passes all filters; `info` notification is filtered out for `critical`-only configs.
  - Test cooldown logic: mock KV returning a recent timestamp, verify email is skipped; mock KV returning null (no cooldown active), verify email is sent.
  - Test unsubscribe JWT generation and verification.
  - Test email address masking for the settings UI (e.g., `admin@example.com` -> `a***n@example.com`).

- **Integration tests:**
  - Seed D1 with email channel configs, trigger a notification, and verify the `SEND_EMAIL.send()` binding is called with the correct EmailMessage.
  - Verify that after sending, the KV cooldown key is set with the correct TTL.
  - Verify that a second notification within the cooldown window does not trigger another email.

- **E2E tests:**
  - `POST /admin/api/notifications/config` with an email channel returns 200 and the config appears in `GET /admin/api/notifications/config`.
  - `DELETE /admin/api/notifications/config/:id` removes the config.
  - Config CRUD requires super-admin role; admin role returns 403.
  - Unsubscribe endpoint with valid token returns 200 HTML and disables the channel.
  - Unsubscribe endpoint with invalid token returns 401.

## Technical Notes

**Cloudflare Email Workers binding:**
- The `send_email` binding is configured in `wrangler.jsonc` under the `send_email` array. The sender address must be on a domain with Email Routing enabled (i.e., `zajel.hamzalabs.dev`).
- The binding is optional (`SEND_EMAIL?` in the Env type). When not configured (local dev, or Email Routing not enabled), the email dispatch path logs a warning and skips without error.
- Email Workers require importing `EmailMessage` from `cloudflare:email`. This is a runtime-provided module, not an npm package.
- DKIM, SPF, and DMARC are automatically managed by Cloudflare Email Routing when using the native binding.

**Wrangler config for send_email:**
```jsonc
{
  "send_email": [
    {
      "name": "SEND_EMAIL",
      "destination_address": "admin@example.com"  // or use allowed_destination_addresses for multiple
    }
  ]
}
```
Note: For flexibility (admins configure arbitrary destination addresses), use unrestricted mode (no `destination_address` field). This requires that the domain has Email Routing fully enabled.

**`mimetext` library:**
- Used to construct proper MIME messages with HTML body, subject, and headers.
- Example: `createMimeMessage().setSender('notifications@zajel.hamzalabs.dev').setRecipient('admin@example.com').setSubject('[Zajel Alert]').setMessage('text/html', htmlBody)`.
- MIT-licensed, compatible with the project's licensing requirements.

**Cooldown via KV with TTL:**
- Rather than querying D1 for the last-sent timestamp on every notification, use KV with `expirationTtl` set to the cooldown duration. If the key exists, the cooldown is active. When the key expires automatically, the cooldown is over.
- KV key format: `email_cooldown:{sha256(email)}`. The email is hashed to avoid storing PII in KV keys.

**Graceful degradation:**
- If `SEND_EMAIL` binding is missing: skip email, log warning, continue to other channels.
- If `ADMIN_KV` binding is missing: skip cooldown check (send every time), log warning.
- If D1 is unavailable: skip email lookup, log error. WebSocket notifications from US-8.1 still work.

## Estimation
**M (Medium)** -- The email construction is straightforward with `mimetext`. The main complexity is in the cooldown logic (KV + TTL), severity filtering, and the unsubscribe flow (JWT-in-link). The settings tab UI follows existing CRUD patterns. The `SEND_EMAIL` binding integration is simple but requires Email Routing to be set up on the domain. Estimated 2-3 days.
