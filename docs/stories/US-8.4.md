# US-8.4: Alert Rule Management

## Story
As a super-admin, I want to create, edit, and delete alert rules, so that I control which conditions trigger notifications and through which channels.

## Acceptance Criteria
- The Notifications settings tab includes an "Alert Rules" section with a table listing all configured rules.
- Each alert rule has: name, condition type, threshold value, threshold unit, severity, notification channels (JSON array), enabled toggle, and cooldown period.
- Supported condition types:
  - `error_rate` -- error count per hour exceeds threshold for any error category.
  - `error_rate_spike` -- error rate exceeds N times the 24-hour rolling average.
  - `new_critical_crash` -- a new error signature with `critical` severity is detected.
  - `server_offline` -- a server has not sent a heartbeat for more than N minutes.
  - `rate_limit_violations` -- rate limit violation count per hour exceeds threshold.
  - `ai_issue_created` -- the AI log processor creates a new GitHub issue.
- Super-admins can create new rules via a form with fields for all rule properties.
- Super-admins can edit existing rules inline or via a modal.
- Super-admins can delete rules with a confirmation prompt.
- Super-admins can enable/disable individual rules via a toggle without deleting them.
- Each rule has a cooldown period (default: 60 minutes). After a rule fires, it will not fire again until the cooldown expires, even if the condition is still met.
- The system ships with 6 default alert rules (matching the plan's "Default Alert Rules" list). Default rules can be edited or disabled but not deleted.
- A "Rule History" section shows the last 50 times each rule was triggered, with timestamp, message, channels notified, and acknowledgment status.
- Admins (non-super-admin) can view alert rules and history but cannot create, edit, or delete them.
- An "Acknowledge" button on each alert history entry marks it as acknowledged (with the admin's username and timestamp). This is informational only and does not affect rule firing.

## Technical Design

### Architecture
The alert rule engine is the core of the notification system. It sits between event sources (metrics ingestion, log processor, server health checks) and notification dispatch (WebSocket, email, webhook from US-8.1/8.2/8.3).

The engine operates in two modes:
1. **Push-triggered evaluation:** When a notification-worthy event occurs (e.g., AI creates an issue, a new critical crash is detected), the source service calls `POST /admin/internal/notify` directly. The `NotificationDO` matches the event against alert rules to determine severity and channels.
2. **Periodic evaluation:** A cron trigger on the admin-cf Worker (every 5 minutes) evaluates threshold-based rules (error rate, server offline, rate limit violations) by querying D1 for current metric values and comparing against rule thresholds.

Alert rules are stored in D1 and cached in KV for fast reads during evaluation. The cache is invalidated on rule CRUD operations.

### Implementation Details

**Alert rule evaluation engine (`src/alert-engine.ts`):**

```typescript
interface AlertRule {
  id: number;
  name: string;
  conditionType: AlertConditionType;
  thresholdValue: number | null;
  thresholdUnit: string | null;
  severity: 'critical' | 'warning' | 'info';
  channels: string[];    // ['dashboard', 'email', 'webhook']
  enabled: boolean;
  cooldownMinutes: number;
  isDefault: boolean;
  createdBy: string;
  createdAt: number;
  lastTriggeredAt: number | null;
}

type AlertConditionType =
  | 'error_rate'
  | 'error_rate_spike'
  | 'new_critical_crash'
  | 'server_offline'
  | 'rate_limit_violations'
  | 'ai_issue_created';

async function evaluateRules(
  env: Env,
  rules: AlertRule[]
): Promise<FiredAlert[]> {
  const fired: FiredAlert[] = [];
  const now = Date.now();

  for (const rule of rules) {
    if (!rule.enabled) continue;

    // Check cooldown
    if (rule.lastTriggeredAt &&
        now - rule.lastTriggeredAt < rule.cooldownMinutes * 60 * 1000) {
      continue;
    }

    const result = await evaluateCondition(env, rule);
    if (result.triggered) {
      fired.push({
        rule,
        message: result.message,
        metricValue: result.metricValue,
      });
    }
  }

  return fired;
}
```

**Condition evaluators (`src/alert-engine.ts`):**

- `error_rate`: Query D1 `error_aggregates` for the last hour. Sum counts across all categories. Compare against `thresholdValue`.
  ```sql
  SELECT SUM(count) as total
  FROM error_aggregates
  WHERE time_bucket >= ?
  ```

- `error_rate_spike`: Query D1 for the last hour and the last 24 hours. Compute `current_rate / (avg_24h_rate || 1)`. Compare ratio against `thresholdValue` (default: 3).

- `new_critical_crash`: Query D1 `issue_tracking` for new entries since the last evaluation where `severity = 'critical'` and `created_at > last_checked`. This is typically push-triggered rather than polled.

- `server_offline`: Fetch server list from bootstrap registry (same pattern as `routes/servers.ts`). Check each server's `lastHeartbeat`. If `now - lastHeartbeat > thresholdValue * 60 * 1000`, fire alert with the server ID in the message.

- `rate_limit_violations`: Query a D1 table or KV counter tracking rate limit violations per hour. Compare against threshold.

- `ai_issue_created`: Push-triggered only. The log processor calls `POST /admin/internal/notify` with `category: 'ai_issue'` when it creates a GitHub issue. The engine matches this against rules with `conditionType = 'ai_issue_created'`.

**Cron trigger for periodic evaluation (`src/index.ts`):**
- Add a `scheduled` handler to the Worker export:
  ```typescript
  export default {
    async fetch(request, env) { /* ... existing ... */ },
    async scheduled(event, env, ctx) {
      ctx.waitUntil(runAlertEvaluation(env));
    },
  };
  ```
- `runAlertEvaluation(env)`:
  1. Read all enabled rules from D1 (or KV cache).
  2. Filter to threshold-based condition types (`error_rate`, `error_rate_spike`, `server_offline`, `rate_limit_violations`).
  3. Call `evaluateRules(env, rules)`.
  4. For each fired alert: update `lastTriggeredAt` in D1, insert into `alert_history`, call `POST /admin/internal/notify` on the NotificationDO to dispatch via configured channels.

**Alert rules CRUD API (`src/routes/alert-rules.ts`):**
- `GET /admin/api/alerts/rules` -- List all rules. Auth: admin or super-admin.
- `POST /admin/api/alerts/rules` -- Create a new rule. Auth: super-admin.
- `PUT /admin/api/alerts/rules/:id` -- Update a rule. Auth: super-admin. Reject if `isDefault` and trying to delete.
- `DELETE /admin/api/alerts/rules/:id` -- Delete a rule. Auth: super-admin. Reject if `isDefault`.
- `PATCH /admin/api/alerts/rules/:id/toggle` -- Enable/disable a rule. Auth: super-admin.
- `GET /admin/api/alerts/history` -- List alert history. Auth: admin or super-admin. Supports `ruleId`, `limit`, `offset` query params.
- `POST /admin/api/alerts/history/:id/acknowledge` -- Acknowledge an alert. Auth: admin or super-admin.

**Default rules seeding (`src/alert-engine.ts`):**
- On first deployment (or when the `alert_rules` table is empty), seed with the 6 default rules from the plan:
  1. Error rate > 100/hour for any category -> warning
  2. New critical crash signature detected -> critical
  3. Server offline for > 5 minutes -> critical
  4. Rate limit violations > 1000/hour -> warning
  5. AI creates new GitHub issue -> info
  6. Error rate spike > 3x 24h average -> warning
- Mark each with `is_default = 1`.
- Seeding is idempotent: check if default rules exist before inserting.

**Frontend (Alert Rules section in Notifications tab):**
- Two sub-sections: "Alert Rules" and "Alert History".
- **Alert Rules table:** Columns: Name, Condition, Threshold, Severity (color badge), Channels (icons), Cooldown, Enabled (toggle), Actions (Edit/Delete).
  - "Add Rule" button opens a form (inline or modal) with: Name (text), Condition Type (select), Threshold Value (number), Threshold Unit (text), Severity (select), Channels (multi-select checkboxes), Cooldown Minutes (number).
  - Edit: same form, pre-populated.
  - Delete: confirmation dialog. Disabled for default rules.
  - Toggle: calls `PATCH .../toggle` immediately.
- **Alert History table:** Columns: Time, Rule Name, Message, Channels, Acknowledged (checkmark or "Acknowledge" button).
  - Paginated (50 per page).
  - Clicking "Acknowledge" calls `POST .../acknowledge` and updates the row in-place.

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/alert-engine.ts` | Create | Alert rule evaluation engine with condition evaluators, default rule seeding |
| `packages/admin-cf/src/routes/alert-rules.ts` | Create | Alert rules CRUD API and alert history API |
| `packages/admin-cf/src/routes/index.ts` | Modify | Re-export from `alert-rules.ts` |
| `packages/admin-cf/src/index.ts` | Modify | Register alert rule routes; add cron `scheduled` handler; add Alert Rules UI to Notifications tab |
| `packages/admin-cf/src/types.ts` | Modify | Add `AlertRule`, `AlertConditionType`, `AlertHistory`, `FiredAlert` interfaces |
| `packages/admin-cf/wrangler.jsonc` | Modify | Add `[triggers]` cron schedule (`*/5 * * * *`) for periodic evaluation |
| `packages/admin-cf/tests/unit/alert-engine.test.ts` | Create | Unit tests for each condition evaluator and rule evaluation logic |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Modify | Add alert rule CRUD and history E2E tests |

### Data Models / Schemas

**D1 Tables (from Section 4.6 of the plan):**

```sql
CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  condition_type TEXT NOT NULL,
  threshold_value REAL,
  threshold_unit TEXT,
  severity TEXT NOT NULL,
  channels TEXT NOT NULL,              -- JSON array: ["dashboard","email","webhook"]
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_minutes INTEGER DEFAULT 60,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_triggered_at INTEGER
);

CREATE TABLE alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL,
  triggered_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  channels_notified TEXT NOT NULL,      -- JSON array
  delivery_status TEXT DEFAULT 'sent',
  delivery_error TEXT,
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id)
);

CREATE INDEX idx_alert_history_rule ON alert_history(rule_id);
CREATE INDEX idx_alert_history_time ON alert_history(triggered_at);
```

**TypeScript interfaces:**

```typescript
type AlertConditionType =
  | 'error_rate'
  | 'error_rate_spike'
  | 'new_critical_crash'
  | 'server_offline'
  | 'rate_limit_violations'
  | 'ai_issue_created';

interface AlertRule {
  id: number;
  name: string;
  conditionType: AlertConditionType;
  thresholdValue: number | null;
  thresholdUnit: string | null;       // 'per_hour', 'minutes', 'multiplier'
  severity: 'critical' | 'warning' | 'info';
  channels: string[];
  enabled: boolean;
  cooldownMinutes: number;
  isDefault: boolean;
  createdBy: string;
  createdAt: number;
  lastTriggeredAt: number | null;
}

interface AlertHistoryEntry {
  id: number;
  ruleId: number;
  ruleName?: string;                  // joined from alert_rules
  triggeredAt: number;
  message: string;
  channelsNotified: string[];
  deliveryStatus: 'sent' | 'failed' | 'skipped';
  deliveryError?: string;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
}

interface FiredAlert {
  rule: AlertRule;
  message: string;
  metricValue?: number;
}

/** Condition evaluation result */
interface ConditionResult {
  triggered: boolean;
  message: string;
  metricValue?: number;
}
```

### API Endpoints

**GET /admin/api/alerts/rules**
- Auth: Bearer JWT required (admin or super-admin)
- Response:
  ```json
  {
    "success": true,
    "data": {
      "rules": [
        {
          "id": 1,
          "name": "High error rate",
          "conditionType": "error_rate",
          "thresholdValue": 100,
          "thresholdUnit": "per_hour",
          "severity": "warning",
          "channels": ["dashboard", "email"],
          "enabled": true,
          "cooldownMinutes": 60,
          "isDefault": true,
          "createdBy": "system",
          "createdAt": 1709380800000,
          "lastTriggeredAt": 1709384400000
        }
      ]
    }
  }
  ```

**POST /admin/api/alerts/rules**
- Auth: Bearer JWT required (super-admin only)
- Request body:
  ```json
  {
    "name": "Critical error spike",
    "conditionType": "error_rate_spike",
    "thresholdValue": 5,
    "thresholdUnit": "multiplier",
    "severity": "critical",
    "channels": ["dashboard", "email", "webhook"],
    "cooldownMinutes": 30
  }
  ```
- Validation:
  - `name`: required, 1-100 characters
  - `conditionType`: must be one of the supported types
  - `thresholdValue`: required for `error_rate`, `error_rate_spike`, `server_offline`, `rate_limit_violations`; not required for `new_critical_crash`, `ai_issue_created`
  - `severity`: required, one of `critical`, `warning`, `info`
  - `channels`: required, non-empty array, values must be `dashboard`, `email`, or `webhook`
  - `cooldownMinutes`: optional, defaults to 60, minimum 1
- Response: `{ "success": true, "data": { "id": 7 } }`

**PUT /admin/api/alerts/rules/:id**
- Auth: Bearer JWT required (super-admin only)
- Request body: same as POST (partial update supported)
- Response: `{ "success": true }`
- Error: 400 if trying to change `conditionType` on a default rule

**DELETE /admin/api/alerts/rules/:id**
- Auth: Bearer JWT required (super-admin only)
- Response: `{ "success": true }`
- Error: 400 if rule is a default rule (`"Cannot delete default alert rules. Disable instead."`)

**PATCH /admin/api/alerts/rules/:id/toggle**
- Auth: Bearer JWT required (super-admin only)
- Request body: `{ "enabled": false }`
- Response: `{ "success": true }`

**GET /admin/api/alerts/history**
- Auth: Bearer JWT required (admin or super-admin)
- Query params: `ruleId` (optional), `limit` (default 50, max 200), `offset` (default 0)
- Response:
  ```json
  {
    "success": true,
    "data": {
      "history": [
        {
          "id": 42,
          "ruleId": 1,
          "ruleName": "High error rate",
          "triggeredAt": 1709384400000,
          "message": "Error rate exceeded 100/hour: 147 errors in the last hour",
          "channelsNotified": ["dashboard", "email"],
          "deliveryStatus": "sent",
          "acknowledgedAt": null,
          "acknowledgedBy": null
        }
      ],
      "total": 120
    }
  }
  ```

**POST /admin/api/alerts/history/:id/acknowledge**
- Auth: Bearer JWT required (admin or super-admin)
- Response: `{ "success": true }`
- Error: 404 if history entry not found; 400 if already acknowledged

## Dependencies
- **US-8.1 (Real-Time Dashboard Notifications):** The `NotificationDO` and `POST /admin/internal/notify` endpoint must exist for the alert engine to dispatch notifications.
- **US-8.2 (Email Notifications):** Email channel config must exist for rules that specify `email` in their channels.
- **US-8.3 (Webhook Notifications):** Webhook channel config must exist for rules that specify `webhook` in their channels.
- **US-2.1 (Error Rate Overview):** The `error_aggregates` D1 table must be populated for `error_rate` and `error_rate_spike` conditions to evaluate.
- **US-5.1 (Server Status):** Server heartbeat data from the bootstrap registry is needed for `server_offline` evaluation.
- **US-6.2 (GitHub Issue Creation):** The `issue_tracking` D1 table is needed for `new_critical_crash` and `ai_issue_created` conditions.
- **D1 database:** The `alert_rules` and `alert_history` tables must be created (via migration script).

## Testing Strategy

- **Unit tests:**
  - Test each condition evaluator in isolation with mock D1 results:
    - `error_rate`: mock returning 150 errors, verify trigger with threshold 100; mock returning 50, verify no trigger.
    - `error_rate_spike`: mock returning current=300, 24h avg=100, verify trigger at 3x threshold; mock returning current=200, 24h avg=100, verify no trigger at 3x.
    - `server_offline`: mock server with lastHeartbeat 10 minutes ago, verify trigger with 5-minute threshold.
    - `rate_limit_violations`: mock returning 1500 violations, verify trigger with threshold 1000.
  - Test cooldown logic: rule with `lastTriggeredAt` 30 minutes ago and `cooldownMinutes` 60 should not fire.
  - Test default rule seeding: verify 6 rules are inserted when table is empty; verify no duplicates on re-run.
  - Test rule validation: missing name returns error, invalid conditionType returns error, empty channels returns error.

- **Integration tests:**
  - Seed D1 with `error_aggregates` rows and an `error_rate` rule. Run `evaluateRules()`. Verify the rule fires and a notification is dispatched to the NotificationDO.
  - Create a rule via the API, verify it appears in the rules list. Edit it, verify changes. Delete it, verify removal. Toggle it, verify enabled state changes.
  - Trigger a rule, verify an entry appears in `alert_history`. Acknowledge it, verify `acknowledgedAt` and `acknowledgedBy` are set.

- **E2E tests:**
  - `GET /admin/api/alerts/rules` returns the 6 default rules.
  - `POST /admin/api/alerts/rules` creates a custom rule (super-admin auth).
  - `POST /admin/api/alerts/rules` returns 403 for non-super-admin.
  - `DELETE /admin/api/alerts/rules/:id` returns 400 for default rules.
  - `GET /admin/api/alerts/history` returns history entries.
  - `POST /admin/api/alerts/history/:id/acknowledge` sets acknowledged fields.
  - Cron trigger: verify `scheduled` handler runs without error (use Miniflare's cron simulation).

## Technical Notes

**Codebase patterns to follow:**
- The existing `requireSuperAdmin` middleware in `routes/auth.ts` is the access control pattern for mutation endpoints. Use it for all rule CRUD operations.
- The `handleListServers` in `routes/servers.ts` fetches from the bootstrap registry. The `server_offline` condition evaluator uses the same `fetchFromBootstrap('/servers', env)` pattern.
- The `MetricsCollector.getScalingRecommendation()` in `server-vps/src/admin/metrics.ts` is a reference for threshold-based condition evaluation. The alert engine follows a similar pattern but is more configurable (user-defined thresholds vs. hardcoded).
- The existing `AdminWsMessage` type in `server-vps/src/admin/types.ts` includes an `alert` variant: `{ type: 'alert', data: { level, message } }`. The `NotificationDO` produces similar payloads but with more structured data.

**Cron trigger configuration:**
- Add to `wrangler.jsonc`:
  ```jsonc
  {
    "triggers": {
      "crons": ["*/5 * * * *"]
    }
  }
  ```
- The `scheduled` handler receives `event.cron` (the cron pattern) and `event.scheduledTime`. Use `event.scheduledTime` for consistent time-bucketing in queries.
- In development, use `wrangler dev --test-scheduled` to trigger the cron handler manually via `GET /__scheduled`.

**KV caching for rules:**
- Store rules in KV as `alert_rules_cache` with a 5-minute TTL. The cron runs every 5 minutes, so the cache is always fresh for evaluation.
- Invalidate the cache (delete the KV key) on any rule CRUD operation so the next evaluation uses the latest rules.
- If KV is unavailable, fall back to reading directly from D1.

**Default rule seeding strategy:**
- Use a D1 migration script or a one-time check in the `scheduled` handler. On each cron run, check if `SELECT COUNT(*) FROM alert_rules WHERE is_default = 1` returns 6. If not, insert the missing defaults.
- This approach is idempotent and self-healing: if someone manually deletes a default rule row from D1 (bypassing the API), it will be re-created on the next cron run. However, the API blocks default rule deletion, so this is a safety net.

**Push-triggered vs. poll-triggered conditions:**
- `new_critical_crash` and `ai_issue_created` are push-triggered: the log processor or diagnostics worker calls `POST /admin/internal/notify` directly when the event occurs. The alert engine does not poll for these.
- `error_rate`, `error_rate_spike`, `server_offline`, and `rate_limit_violations` are poll-triggered: the cron handler queries D1 and the bootstrap registry every 5 minutes.
- The `POST /admin/internal/notify` handler in the `NotificationDO` matches the incoming notification's `category` against rules with the corresponding `conditionType` to determine severity and channels. If no matching rule exists, the notification is still delivered via the dashboard WebSocket channel (always-on).

**Condition type extensibility:**
- The `conditionType` is a string enum stored in D1. Adding new condition types in the future requires:
  1. Adding a new evaluator function in `alert-engine.ts`.
  2. Adding the new type to the `AlertConditionType` TypeScript union.
  3. Adding UI support in the condition type dropdown.
  4. No D1 schema changes needed (the `condition_type` column is `TEXT`).

## Estimation
**L (Large)** -- This story is the most complex in Epic 8. It includes the alert evaluation engine with 6 condition evaluators, the CRUD API for rules, the cron trigger, default rule seeding, alert history management, acknowledgment flow, and a substantial settings UI with forms, tables, and inline editing. Estimated 4-5 days.
