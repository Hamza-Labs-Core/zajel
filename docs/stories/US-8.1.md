# US-8.1: Real-Time Dashboard Notifications

## Story
As an admin, I want real-time alerts via WebSocket, so that I am immediately informed of critical events while viewing the admin dashboard.

## Acceptance Criteria
- A new `NotificationDO` Durable Object is implemented in `packages/admin-cf/` that maintains WebSocket connections to admin dashboard clients using the Hibernation API.
- When an alert rule fires (error rate spike, server offline, AI issue created, etc.), the `NotificationDO` pushes a notification message over the WebSocket to all connected admin sessions.
- The admin dashboard displays incoming notifications as toast messages overlaid on the current view. Toast messages auto-dismiss after 10 seconds, or can be dismissed manually.
- Critical-severity notifications trigger a browser notification sound (using the Web Audio API) in addition to the toast.
- A notification bell icon appears in the dashboard header. It shows an unread count badge when there are unseen notifications.
- Clicking the notification bell opens a dropdown panel listing the most recent 50 notifications with timestamp, severity, and message. Each entry links to the relevant dashboard section (e.g., clicking an error-rate alert navigates to the Errors tab).
- Notifications are persisted in the `NotificationDO` storage so they survive hibernation and are available when the admin reconnects or refreshes.
- The WebSocket connection auto-reconnects with exponential backoff (1s, 2s, 4s, capped at 30s) if the connection drops.
- When no admin clients are connected, the `NotificationDO` hibernates (zero duration charges).
- All WebSocket connections require valid JWT authentication; unauthenticated upgrade requests receive a 401 response.
- A `setWebSocketAutoResponse` is configured for ping/pong keepalive so that heartbeat messages do not wake the hibernating DO.

## Technical Design

### Architecture
This story introduces the `NotificationDO` Durable Object in `packages/admin-cf/`. It is the central hub for real-time push notifications to admin dashboard clients. The DO uses the Cloudflare Durable Objects WebSocket Hibernation API, which allows the DO to be evicted from memory when no messages are being processed while keeping WebSocket connections alive. This significantly reduces duration billing.

The notification flow:
1. Internal services (alert rule engine from US-8.4, log processor, VPS metrics push) call the admin-cf Worker with an internal notification request.
2. The Worker forwards the notification to the `NotificationDO` via its Durable Object stub.
3. The `NotificationDO` stores the notification, then broadcasts it to all connected admin WebSocket clients.
4. The dashboard frontend receives the WebSocket message and renders a toast / updates the bell badge.

The `NotificationDO` is a singleton -- there is one instance identified by `idFromName('notifications')`. All admin dashboard clients connect to this single instance.

### Implementation Details

**NotificationDO Durable Object (`src/notification-do.ts`):**
- Extends `DurableObject` base class.
- In `constructor`, call `this.ctx.getWebSockets()` to recover any hibernating WebSocket sessions. Deserialize attachments to restore per-client metadata (username, role, connected-at timestamp).
- Configure `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))` so that ping/pong keepalives do not wake the DO from hibernation.
- `fetch()` handler routes:
  - `GET /ws` -- WebSocket upgrade. Verify JWT from `Sec-WebSocket-Protocol` header (since WebSocket API does not support custom headers; token passed as subprotocol). Call `this.ctx.acceptWebSocket(server)` with a tag based on the admin user ID. Serialize the admin identity as an attachment via `server.serializeAttachment({ userId, username, role, connectedAt })`. Return the 101 switching response.
  - `POST /notify` -- Internal endpoint (called by the Worker, not exposed publicly). Parse the notification payload, store in DO storage, broadcast to all connected WebSockets via `this.ctx.getWebSockets()`.
  - `GET /notifications` -- Fetch stored notifications (paginated). Used by the dashboard on initial load to populate the bell dropdown.
  - `POST /notifications/:id/read` -- Mark a notification as read for a specific user.
- `webSocketMessage(ws, message)` -- Handle client-side messages. Supported messages: `{ type: 'mark_read', id: string }`, `{ type: 'mark_all_read' }`.
- `webSocketClose(ws, code, reason)` -- Clean up session tracking.
- `webSocketError(ws, error)` -- Log and clean up.

**Notification storage in DO:**
- Store notifications as an ordered list in DO storage keyed by `notification:{timestamp}:{id}`.
- Each notification: `{ id, severity, title, message, category, link, timestamp, readBy: string[] }`.
- Cap stored notifications at 200; prune oldest when exceeded.
- Store per-user read state as `read:{userId}:{notificationId}` keys.

**Worker entry point changes (`src/index.ts`):**
- Add route for WebSocket upgrade: `if (path === '/admin/ws/notifications')` -- forward to `NotificationDO` stub.
- Add internal route: `if (path === '/admin/internal/notify' && method === 'POST')` -- forward to `NotificationDO` (protected by an internal secret or same-worker validation, not exposed via CORS).
- Export `NotificationDO` class for the runtime.

**Frontend (inline HTML or Preact):**
- On dashboard load (after auth), open a WebSocket to `/admin/ws/notifications` passing the JWT as a subprotocol.
- Implement reconnection with exponential backoff.
- On receiving a `notification` message: render a toast, increment the bell badge, prepend to the notification list.
- Toast rendering: a fixed-position container in the top-right corner; CSS transitions for slide-in/fade-out.
- Bell icon: an SVG bell in the header bar with a red circle badge showing the unread count.
- Notification panel: a dropdown div anchored to the bell; scrollable list; clicking an entry navigates to the relevant tab and closes the panel.
- Critical notifications: play a short beep using `AudioContext.createOscillator()` (440Hz, 200ms).

### Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/admin-cf/src/notification-do.ts` | Create | NotificationDO Durable Object with Hibernation WebSocket API |
| `packages/admin-cf/src/index.ts` | Modify | Register WebSocket upgrade route `/admin/ws/notifications`, internal notify route; export NotificationDO; add notification bell + toast UI to dashboard HTML |
| `packages/admin-cf/src/types.ts` | Modify | Add `NotificationPayload`, `StoredNotification`, `NotificationWsMessage` interfaces; extend `Env` with `NOTIFICATIONS` DO namespace |
| `packages/admin-cf/wrangler.jsonc` | Modify | Add `NotificationDO` to `durable_objects.bindings` and `migrations` |
| `packages/admin-cf/tests/unit/notification-do.test.ts` | Create | Unit tests for NotificationDO message handling, storage, broadcast |
| `packages/admin-cf/tests/e2e/admin-e2e.test.ts` | Modify | Add WebSocket notification E2E tests |

### Data Models / Schemas

```typescript
/** Notification payload sent by internal services */
interface NotificationPayload {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  category: 'error_rate' | 'server_offline' | 'ai_issue' | 'security' | 'system';
  link?: string;  // e.g., '/admin/#errors' or '/admin/#security'
}

/** Notification as stored in DO storage */
interface StoredNotification {
  id: string;          // nanoid
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  category: string;
  link?: string;
  timestamp: number;   // Unix ms
  readBy: string[];    // user IDs that have read this
}

/** WebSocket messages sent to dashboard clients */
type NotificationWsMessage =
  | { type: 'notification'; data: StoredNotification }
  | { type: 'notification_list'; data: StoredNotification[]; unreadCount: number }
  | { type: 'read_ack'; id: string };

/** WebSocket messages received from dashboard clients */
type NotificationClientMessage =
  | { type: 'mark_read'; id: string }
  | { type: 'mark_all_read' };

/** WebSocket attachment persisted across hibernation */
interface WsSessionAttachment {
  userId: string;
  username: string;
  role: 'admin' | 'super-admin';
  connectedAt: number;
}
```

### API Endpoints

**WebSocket: /admin/ws/notifications**
- Upgrade: `GET` with `Connection: Upgrade`, `Upgrade: websocket`
- Auth: JWT token passed as subprotocol (`Sec-WebSocket-Protocol: <jwt-token>`)
- On connect: server sends `{ type: 'notification_list', data: [...], unreadCount: N }` with the last 50 notifications
- Ongoing: server pushes `{ type: 'notification' }` messages as alerts fire
- Client can send: `{ type: 'mark_read', id }` or `{ type: 'mark_all_read' }`

**POST /admin/internal/notify** (internal only, not CORS-exposed)
- Auth: Internal request validation (same-worker context or shared secret)
- Request body:
  ```json
  {
    "severity": "critical",
    "title": "Server srv-01 offline",
    "message": "Server srv-01 has not sent a heartbeat for 5 minutes.",
    "category": "server_offline",
    "link": "/admin/#servers"
  }
  ```
- Response: `{ "success": true, "data": { "id": "abc123", "delivered": 3 } }`

**GET /admin/api/notifications/history**
- Auth: Bearer JWT required
- Query params: `limit` (default 50, max 200), `offset` (default 0)
- Response: `{ "success": true, "data": { "notifications": [...], "total": 120, "unreadCount": 5 } }`

## Dependencies
- **US-8.4 (Alert Rule Management):** The alert rules that fire notifications are defined in US-8.4. However, this story can be developed independently by providing the `POST /admin/internal/notify` endpoint that US-8.4 will call.
- **Cloudflare Workers runtime:** Requires `DurableObject` base class, `acceptWebSocket`, `getWebSockets`, `setWebSocketAutoResponse`, `serializeAttachment`, `deserializeAttachment` APIs (available since compatibility_date 2024-01-01).
- **No external packages:** Uses built-in WebSocket API and DO storage.

## Testing Strategy

- **Unit tests:**
  - Test `NotificationDO` fetch handler routing (WebSocket upgrade, POST /notify, GET /notifications).
  - Test notification storage: storing, retrieving, pagination, pruning at 200 cap.
  - Test broadcast logic: mock `getWebSockets()` returning multiple sockets, verify each receives the message.
  - Test read state: mark_read for one user does not affect another user's unread count.
  - Test JWT validation on WebSocket upgrade: invalid token results in 401, not a WebSocket upgrade.

- **Integration tests:**
  - Use `wrangler dev --local` with miniflare to stand up the DO, connect a WebSocket client, send a notification via POST, and verify the client receives it.
  - Test reconnection by closing the WebSocket from the server side and verifying the client reconnects.

- **E2E tests:**
  - Connect a WebSocket to the deployed admin worker, verify the initial notification list is received.
  - POST a test notification and verify it appears on the WebSocket within 1 second.
  - Verify unauthenticated WebSocket upgrade returns 401.

## Technical Notes

**Codebase patterns to follow:**
- The existing `AdminUsersDO` in `admin-users-do.ts` is the model for Durable Object structure: constructor signature, `fetch()` routing, `jsonResponse()` helper, and storage key patterns (`user:{id}`, `username:{name}`). The new `NotificationDO` follows the same conventions but adds WebSocket Hibernation API methods.
- The VPS `AdminWebSocketHandler` in `server-vps/src/admin/websocket.ts` provides a reference implementation for WebSocket broadcast patterns (iterating clients, checking `readyState`, sending JSON). The `NotificationDO` equivalent uses `this.ctx.getWebSockets()` instead of a manual `Set<WebSocket>`.
- The existing `Env` interface uses the pattern `ADMIN_USERS: DurableObjectNamespace`. Follow the same convention: `NOTIFICATIONS: DurableObjectNamespace`.

**WebSocket Hibernation API specifics:**
- `acceptWebSocket(ws)` is called instead of `ws.accept()`. This tells the runtime the socket is hibernatable.
- `setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))` prevents heartbeat messages from waking the DO, reducing duration charges to near zero during idle periods.
- `getWebSockets(tag?)` can filter by tag. Tags are set via `acceptWebSocket(ws, [tag1, tag2])`. Use the user ID as a tag for targeted notifications in the future.
- `serializeAttachment()` and `deserializeAttachment()` persist per-socket state across hibernation. Store the admin user identity here.
- Maximum 10 tags per WebSocket, maximum 256 characters per tag.
- When the DO wakes from hibernation, the constructor runs again. Recover session state by iterating `getWebSockets()` and deserializing attachments.

**Browser Audio for critical alerts:**
- Use the Web Audio API (`AudioContext`) rather than an `<audio>` element to avoid needing a sound file asset. A simple oscillator at 440Hz for 200ms is sufficient.
- Browsers require user interaction before creating an `AudioContext`. Initialize the context on the first user click/tap on the dashboard and reuse it.

**JWT via subprotocol:**
- The browser WebSocket API does not support custom headers. The standard workaround is passing the JWT as a subprotocol: `new WebSocket(url, [token])`. On the server, extract it from `Sec-WebSocket-Protocol`, verify it, and echo it back in the 101 response's `Sec-WebSocket-Protocol` header.

## Estimation
**L (Large)** -- This story introduces a new Durable Object with the Hibernation WebSocket API (a pattern not yet used in this codebase), WebSocket upgrade handling in the Worker, frontend toast/bell/dropdown UI, browser audio, and reconnection logic. The DO storage model for notifications and read states adds complexity. Estimated 4-5 days.
