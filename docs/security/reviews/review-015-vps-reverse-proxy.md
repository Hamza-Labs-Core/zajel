# Review: Plan 015 - VPS Reverse Proxy with Rate Limiting

**Reviewer:** Claude Opus 4.6
**Date:** 2026-03-03
**Documents Reviewed:**
- `docs/security/implementation-plans/plan-015-vps-reverse-proxy.md`
- `docs/security/stories/story-015-vps-reverse-proxy.md`

---

## Verdict: NEEDS REVISION

The plan is well-structured and covers the major infrastructure changes competently. However, it has one **critical omission** (client IP propagation to Node.js), one **high-severity issue** (nginx HTTP/2 + WebSocket incompatibility), and several moderate issues that must be addressed before implementation.

---

## 1. Accuracy

### 1.1 File Paths -- PASS

All referenced source files exist at the stated paths:
- `.github/workflows/deploy-vps.yml` -- exists
- `packages/server-vps/src/config.ts` -- exists
- `packages/server-vps/src/index.ts` -- exists
- `packages/server-vps/src/constants.ts` -- exists

New files to be created under `packages/server-vps/deploy/` -- directory does not yet exist (correct, these are new files).

### 1.2 Line Numbers -- PASS WITH NOTES

| Reference | Claimed | Actual | Status |
|-----------|---------|--------|--------|
| deploy-vps.yml "lines 134-144" (plan 3.5) | start.sh creation through PM2 start | Lines 134-144 match | PASS |
| deploy-vps.yml "lines 156-159" (plan 3.7) | Health check loop | Lines 156-159 match | PASS |
| config.ts "lines 36-38" (plan 3.8) | `network.host` default | Lines 36-38 match | PASS |
| config.ts "lines 37-38" (plan section 2.2) | Claims to update host/port | Port default is already 9000; only host changes | Minor: description misleading |
| story "lines 126-173" | deploy-vps.yml server startup | Lines 126-173 match | PASS |
| story "lines 368-374" | index.ts httpServer.listen | Lines 368-374 match | PASS |
| story "lines 313-332" | index.ts connection limits | Lines 312-332 (off by 1 at start) | PASS (close enough) |
| story "lines 89-176" | index.ts HTTP request handler | Lines 89-176 match | PASS |
| story "lines 192-198" | constants.ts CONNECTION_LIMITS | Lines 192-198 match | PASS |
| story "lines 42-46" | config.ts TLS config | Lines 42-46 match | PASS |
| story "line 194" | MAX_TOTAL_CONNECTIONS: 10000 | Line 194 matches | PASS |
| story "line 197" | MAX_CONNECTIONS_PER_IP: 50 | Line 197 matches | PASS |

### 1.3 Code Snippets -- PASS WITH NOTES

All code snippets from the story accurately reflect the current source. The "Before" blocks in the plan match the current deploy-vps.yml and config.ts.

**Minor inaccuracy in plan section 2.2:** The table says config.ts lines 37-38 change is "Update default host/port (localhost:9000)". The port default is already 9000 (line 38: `port: envNumber('ZAJEL_PORT', 9000)`). Only the host default changes. The plan acknowledges this in section 3.8's note ("Port default is already 9000, which is correct") but the table entry is misleading.

### 1.4 Current State Description -- PASS

The story accurately describes that:
- Node.js listens on `0.0.0.0:80` via the deploy workflow (even though config.ts defaults to port 9000, the workflow overrides with `ZAJEL_PORT=80`)
- No reverse proxy is configured
- Application-level rate limiting only fires after TCP handshake and HTTP upgrade complete
- TLS config options exist but are unused in deployment

---

## 2. Completeness

### 2.1 CRITICAL: Client IP Propagation Missing

**The plan sets `X-Real-IP` and `X-Forwarded-For` headers in nginx but does NOT update the Node.js application to read them.**

Current code in `packages/server-vps/src/index.ts` line 317:
```typescript
const clientIp = req.socket.remoteAddress || 'unknown';
```

After deploying nginx, `req.socket.remoteAddress` will always be `127.0.0.1` (nginx's loopback address). The per-IP connection limit (`MAX_CONNECTIONS_PER_IP: 50`) will treat ALL clients as a single IP, making it effectively useless. A single client exceeding 50 connections would block every other client.

**Required fix:** Update the Node.js code to parse `X-Real-IP` or `X-Forwarded-For` headers:
```typescript
const clientIp = req.headers['x-real-ip'] as string
  || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
  || req.socket.remoteAddress
  || 'unknown';
```

This must also be applied to `packages/server-vps/src/federation/transport/server-connection.ts` line 97, which also uses `req.socket.remoteAddress`.

### 2.2 HIGH: nginx HTTP/2 + WebSocket Incompatibility

The nginx config uses `listen 443 ssl http2;` (lines 91-92 of the template). Ubuntu 24.04 ships nginx 1.24.0 (the `apt-get install -y nginx` in setup-nginx.sh will install this version). In nginx 1.24.x:

- The `http2` parameter on the `listen` directive is the correct syntax (not deprecated until 1.25.1).
- However, **WebSocket upgrade is an HTTP/1.1 mechanism**. When nginx negotiates HTTP/2 via ALPN, most browser WebSocket implementations and Dart's `web_socket_channel` will fall back to HTTP/1.1 automatically. But some HTTP/2-capable clients may fail to upgrade.
- nginx 1.24.x does **not** support RFC 8441 (WebSocket over HTTP/2 / Extended CONNECT).

**Recommendation:** Remove `http2` from the `listen` directive to avoid any risk of HTTP/2 negotiation interfering with WebSocket upgrades:
```nginx
listen 443 ssl;
listen [::]:443 ssl;
```

Alternatively, install nginx mainline (1.27.x) which supports both HTTP/2 and WebSocket over HTTP/2.

### 2.3 MEDIUM: Deploy File Copy Ordering

The plan says the infrastructure setup step (section 3.6) should run "after 'Setup server environment' (after line 88) and before 'Prepare deployment' (line 89)." However, the infrastructure step references files at `/opt/zajel/server-vps/deploy/setup-firewall.sh` and `/opt/zajel/server-vps/deploy/setup-nginx.sh`. These files are only copied to the server in the "Copy files to servers" step (line 104), which happens AFTER the proposed infrastructure step.

The `deploy/` directory files need to be present on the VPS before the infrastructure setup runs. Either:
1. Move the infrastructure step to after "Copy files to servers", or
2. Add a separate SCP step to copy deploy scripts before running infrastructure setup.

The plan does note the step "checks for existing configuration before making changes," but on first deployment, the scripts will not exist.

### 2.4 MEDIUM: Other Workflow Files Not Updated

Two workflow files hard-code `ws://65.21.54.26:9000` which will break after this change:
- `.github/workflows/integration-tests.yml` line 48: `VITE_SIGNALING_URL: ws://65.21.54.26:9000`
- `.github/workflows/web-client-tests.yml` line 64: `VITE_SIGNALING_URL: ws://65.21.54.26:9000`

These should be updated to use `wss://` and port 443 (or use the `VPS_QA_WS_URL` variable like `pr-pipeline.yml` does).

### 2.5 MEDIUM: Admin Location Block Uses Wrong Connection Header

In the nginx config template (plan section 3.1), the admin endpoint location block uses:
```nginx
proxy_set_header Connection $http_connection;
```

This passes through the client's `Connection` header value, which may be empty or incorrect for WebSocket upgrade. Admin WebSocket connections (`/admin/ws`) are handled by the default `/` location block, not the admin regex location, so this is not a functional problem. However, the admin location regex `^/(admin|stats|metrics)` will match `/admin/ws` upgrades before the `/` location. Since the upgrade handler in Node.js (`httpServer.on('upgrade')`) operates at the HTTP level before routing, and the nginx location block for admin does pass through the Upgrade header, this should work. But using `$http_connection` instead of `"upgrade"` is inconsistent and fragile.

**Recommendation:** Either exclude `/admin/ws` from the admin regex, or use the same `Connection "upgrade"` header as the `/` block.

### 2.6 LOW: `limit_req off` and `limit_conn off` Syntax

In the health check location block:
```nginx
limit_req off;
limit_conn off;
```

The `limit_req off;` directive is not valid in nginx. To disable rate limiting for a specific location, simply don't apply `limit_req` in that location. Since `limit_req` is set in the `server` block, it applies to all locations. The correct way to exempt `/health` is to use `limit_req zone=http_limit burst=1000 nodelay;` with a very high burst, or restructure the config so `limit_req` is applied per-location instead of at the server level.

Similarly, `limit_conn` cannot be turned off with `off` in a location context. The directive must simply not be present if not desired, but it inherits from the server block.

**Update:** Actually, `limit_req off;` IS valid in nginx 1.18+ (added in the ngx_http_limit_req_module). However, `limit_conn off;` is NOT valid -- there is no `off` argument for `limit_conn`. This will cause an nginx config syntax error. The `limit_conn` directive must be removed from the health location block, or the `limit_conn` must be moved from the `server` block to individual `location` blocks.

### 2.7 LOW: Self-Hosting Documentation

`packages/server-vps/docs/self-hosting.md` line 38 shows `ZAJEL_HOST=0.0.0.0` which is correct for self-hosting (users binding to all interfaces). The plan only updates `config.ts` defaults. The self-hosting doc should note that `0.0.0.0` is used when NOT behind a reverse proxy, and `127.0.0.1` when behind one.

---

## 3. Test Plan Coverage vs. Acceptance Criteria

| Acceptance Criterion | Test Coverage | Verdict |
|---------------------|---------------|---------|
| nginx installed and configured as reverse proxy | Tests 1, 4, 5, 6, 8 | COVERED |
| TLS enabled with auto-renewed certificates | Test 4 (manual verification) | COVERED |
| Node.js on 127.0.0.1:9000 only | Test 7 | COVERED |
| `ZAJEL_PUBLIC_ENDPOINT` uses `wss://` | Implicit in Test 8 | COVERED |
| nginx enforces 20 concurrent connections/IP | Test 11 | COVERED |
| nginx enforces 30 req/s per IP | Test 12 | COVERED |
| UFW firewall configured | Test 9 | COVERED |
| fail2ban installed and configured | Test 10, 14 | COVERED |
| Health check accessible through proxy | Test 6 | COVERED |
| WebSocket upgrade works through proxy | Test 8 | COVERED |
| Federation server-to-server connections work | Test 15 | COVERED (vaguely) |
| PM2 cluster mode evaluated | Section 11.1, Q3 | COVERED (decided "not yet") |
| Deploy workflow includes rollback on nginx failure | Tests 17, 18 | PARTIALLY COVERED |

**Missing test coverage:**
- No test verifies that per-IP rate limiting in Node.js still works correctly after the proxy is deployed (i.e., that client IPs are correctly propagated, not all showing as 127.0.0.1).
- Test 13 (health check rate limit exemption) will fail due to the `limit_conn off;` syntax error noted above.
- Test 15 (federation) is vague ("Start a second VPS server with same configuration") with no concrete steps.
- No test for the admin WebSocket (`/admin/ws`) path through the reverse proxy.
- No test for verifying that the `deploy/` scripts were correctly uploaded before the infrastructure step runs (relates to issue 2.3).

---

## 4. Risks

### 4.1 SSH Lockout Risk (Acknowledged, Mitigated)

The plan correctly identifies SSH lockout risk and provides mitigation (cloud console access, UFW allows SSH port from GitHub secret). However, the `ufw --force reset` in `setup-firewall.sh` will momentarily drop all existing firewall rules including any existing SSH allowance. If the script fails between `ufw --force reset` and `ufw allow "$SSH_PORT/tcp"`, SSH access is lost.

**Mitigation suggestion:** Add `ufw allow "$SSH_PORT/tcp"` immediately after `ufw --force reset`, before any other rules.

### 4.2 Let's Encrypt IP Certificate Rate Limits

The plan uses `--keep-until-expiring` which is correct. However, if the VPS IP changes (e.g., provider maintenance, migration), a new certificate is needed. Let's Encrypt IP certificates have the same rate limits as domain certificates (50 per week). This is unlikely to be an issue but should be documented.

### 4.3 First-Deployment Downtime

On first deployment, the workflow will:
1. Stop the existing Node.js on port 80
2. Reconfigure to port 9000
3. Install and configure nginx
4. Provision TLS certificate

Between steps 1 and 3 completing, the server is unreachable. The plan does not quantify this downtime window or suggest how to minimize it (e.g., install nginx first, then switch Node.js port).

### 4.4 Certbot Version

The plan requires certbot 5.3.0+ for IP certificate support. Ubuntu 24.04's default certbot from apt is likely older. The setup script uses `apt-get install -y certbot` which may install an incompatible version. The plan should specify `pip install certbot>=5.3.0` or use a PPA/snap for a newer version.

---

## 5. Recommended Changes

### Must Fix (Blockers)

1. **Add client IP header parsing to Node.js.** Update `packages/server-vps/src/index.ts` line 317 to read `X-Real-IP` / `X-Forwarded-For` headers. Without this, all per-IP rate limiting and connection tracking in Node.js is broken behind nginx.

2. **Fix `limit_conn off;` syntax error.** Remove `limit_conn off;` from the health check location block (it is not valid nginx syntax). Either move `limit_conn` to individual location blocks or accept that `/health` is also subject to the connection limit.

3. **Fix deploy file copy ordering.** The infrastructure setup step references scripts at `/opt/zajel/server-vps/deploy/` but these are not yet copied at that point in the workflow. Reorder steps or add an early SCP step for deploy scripts.

4. **Remove `http2` from listen directive** or ensure nginx mainline (>= 1.25.1) is installed. Ubuntu 24.04's default nginx 1.24.0 does not support WebSocket over HTTP/2.

### Should Fix (Important)

5. **Update hard-coded `ws://65.21.54.26:9000`** in `integration-tests.yml` and `web-client-tests.yml` to use `wss://` or a GitHub variable.

6. **Verify certbot version requirement.** Add a version check in `setup-nginx.sh` to confirm certbot >= 5.3.0, and install via pip/snap if the apt version is too old.

7. **Add a test for client IP correctness** behind nginx (verify Node.js logs show real client IPs, not `127.0.0.1`).

8. **Fix admin location block** `Connection` header to use `"upgrade"` or exclude `/admin/ws` from the regex match.

### Nice to Have

9. **Minimize first-deployment downtime** by installing nginx before reconfiguring Node.js.

10. **Update self-hosting documentation** to note the difference between `0.0.0.0` (standalone) and `127.0.0.1` (behind proxy).

11. **Add nginx `set_real_ip_from 127.0.0.1;` and `real_ip_header X-Real-IP;`** directives so nginx's own logging shows the real client IP (currently it will log the client IP correctly since it's the one receiving the connection, but this is good practice for future load balancer scenarios).

---

## 6. Summary

The plan demonstrates solid understanding of reverse proxy architecture and covers the major infrastructure components (nginx, UFW, fail2ban, TLS). The story accurately describes the current vulnerability and its impact. Line number references and code snippets are accurate.

However, the **critical omission of client IP propagation** means that deploying this plan as-is would break Node.js per-IP connection limits, causing all clients to share a single rate limit bucket. The nginx config syntax error (`limit_conn off;`) and the deploy step ordering issue would cause deployment failures. The HTTP/2 + WebSocket concern requires attention to avoid connection failures with certain clients.

These issues are straightforward to fix and should not significantly change the scope or timeline of the plan.
