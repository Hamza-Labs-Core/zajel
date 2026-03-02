# Security Remediation: JWT Secret Written to Disk as Plaintext on VPS

**Issue ID**: SEC-VPS-001
**Severity**: High
**Date**: 2026-02-27
**Status**: Planned

---

## 1. Current State Analysis

### 1.1 Problem Description

Both the production and QA VPS deployment workflows embed the `ZAJEL_ADMIN_JWT_SECRET` (and other configuration) directly into a shell script that is written to disk, executed by PM2, and persists indefinitely on the VPS filesystem.

### 1.2 Affected Files

| File | Location in workflow | Script written to VPS |
|------|---------------------|-----------------------|
| `.github/workflows/deploy-vps.yml` | Line ~137 ("Start server" step) | `/opt/zajel/server-vps/start.sh` |
| `.github/workflows/pr-pipeline.yml` | Line ~1488 ("Start server" step in QA VPS deploy) | `/opt/zajel/server-vps-qa/start-qa.sh` |

### 1.3 How the Secret Gets to Disk

**Production (`deploy-vps.yml`)**:

The `appleboy/ssh-action` receives `ZAJEL_ADMIN_JWT_SECRET` via the `envs` parameter, which injects it as an environment variable into the SSH session. The script then embeds it into `start.sh` using `printf`:

```bash
printf '#!/bin/bash\n...export ZAJEL_ADMIN_JWT_SECRET=%s...\n' "$ZAJEL_ADMIN_JWT_SECRET" > start.sh
chmod +x start.sh
```

**QA (`pr-pipeline.yml`)**:

Same pattern using a heredoc:

```bash
cat > start-qa.sh << EOF
#!/bin/bash
...
export ZAJEL_ADMIN_JWT_SECRET=${ZAJEL_ADMIN_JWT_SECRET}
...
EOF
chmod +x start-qa.sh
```

### 1.4 File Permissions on Disk

Both scripts are created with `chmod +x`, which sets permissions based on the user's umask. On a typical Ubuntu VPS with default umask `0022`, the resulting permissions are:

```
-rwxr-xr-x 1 deploy deploy  start.sh
```

This means the file is **world-readable** (`r-x` for "other"). Any user or process on the VPS can read the JWT secret.

### 1.5 Complete List of Secrets and Sensitive Values in Start Scripts

**Production `start.sh`**:
| Variable | Sensitivity | Notes |
|----------|-------------|-------|
| `ZAJEL_ADMIN_JWT_SECRET` | **HIGH** -- Shared HMAC secret for admin JWT verification | Compromise allows forging admin tokens |
| `ZAJEL_PUBLIC_ENDPOINT` | Low -- Derived from public IP | Public information |
| `ZAJEL_BOOTSTRAP_URL` | Low -- Public bootstrap server URL | Not secret |
| `ZAJEL_CF_ADMIN_URL` | Low -- CF admin dashboard URL | Not secret |
| `ZAJEL_PORT`, `ZAJEL_KEY_PATH`, `ZAJEL_DB_PATH`, `ZAJEL_REGION` | Low -- Operational config | Not secret |

**QA `start-qa.sh`** (same as above, plus):
| Variable | Sensitivity | Notes |
|----------|-------------|-------|
| `ZAJEL_TLS_CERT` | Medium -- Path to TLS certificate | File path, not the cert content |
| `ZAJEL_TLS_KEY` | Medium -- Path to TLS private key | File path, not the key content |
| `APP_VERSION` | Low -- Version string | Not secret |
| `NODE_ENV` | Low -- Environment designation | Not secret |

### 1.6 How PM2 Uses the Start Script

PM2 is configured to execute the bash script directly:

```bash
pm2 start start.sh --name zajel-server --interpreter bash --cwd /opt/zajel/server-vps
```

PM2 spawns a bash process that sources the exports in `start.sh`, then `exec`s into `node dist/index.js`. The Node.js process reads `ZAJEL_ADMIN_JWT_SECRET` from `process.env` in `packages/server-vps/src/config.ts` (line 96). PM2 also stores its own process metadata in `~/.pm2/` which may cache environment variables.

### 1.7 The Server's dotenv Support

The server already has `dotenv` as a production dependency and calls `config()` from dotenv at the top of `config.ts` (line 10). This means the server natively loads environment variables from a `.env` file in its working directory if one exists. This capability is currently unused by the CI/CD deployment.

---

## 2. Risk Assessment

### 2.1 Threat Scenarios

| # | Threat | Impact | Likelihood |
|---|--------|--------|------------|
| T1 | **Local privilege escalation**: Any user or compromised service on the VPS reads `start.sh` and extracts the JWT secret | Attacker forges admin JWTs, gains full admin API access to the VPS server (metrics, federation control, scaling) | Medium -- Requires VPS access but file is world-readable |
| T2 | **Lateral movement**: Attacker with read access to the VPS filesystem (e.g., via web vulnerability, container escape, or compromised co-tenant) extracts the shared JWT secret | Secret is shared with CF Workers admin dashboard; compromise enables forging admin tokens accepted by both VPS and CF Workers | Medium |
| T3 | **Backup/snapshot exposure**: VPS disk snapshots, backups, or images contain the plaintext secret | Secret persists in backup storage with potentially weaker access controls | Medium -- Common in cloud VPS providers |
| T4 | **Process listing exposure**: The secret is visible in `start.sh` content and potentially in PM2's process metadata (`~/.pm2/dump.pm2.bak`) | Exposure through process inspection tools | Low-Medium |
| T5 | **Log leakage**: The QA deploy script runs `cat start-qa.sh` on validation failure (line 1510 in pr-pipeline.yml), printing the entire script (including the JWT secret) to GitHub Actions logs | Secret visible in CI logs to anyone with repo read access | Low -- Only on failure path, but GitHub logs are retained 90 days |

### 2.2 CVSS Assessment

- **Attack Vector**: Local (AV:L)
- **Attack Complexity**: Low (AC:L)
- **Privileges Required**: Low (PR:L) -- any local user
- **User Interaction**: None (UI:N)
- **Scope**: Changed (S:C) -- secret is shared with CF Workers
- **Confidentiality Impact**: High (C:H) -- admin JWT secret
- **Integrity Impact**: High (I:H) -- can forge admin tokens
- **Availability Impact**: Low (A:L) -- admin API can disrupt monitoring

**CVSS v3.1 Score: 8.2 (High)**

### 2.3 Compliance Considerations

- **OWASP ASVS v4.0 Section 2.10**: Credentials must not be stored in plaintext in configuration files
- **CIS Benchmark**: Sensitive data must have restrictive file permissions (0600 or 0640)
- **NIST SP 800-123**: Server security recommends separation of configuration secrets from application code/scripts

---

## 3. Remediation Plan

### Overview

Replace the plaintext start script approach with a restricted-permission `.env` file. The server already has `dotenv` built in and calls `config()` at startup. The `.env` file will be created with `0600` permissions (owner read/write only), and PM2 will launch the Node.js process directly rather than through a bash wrapper that exports secrets.

### 3.1 Step 1: Production Deploy -- Replace `start.sh` with `.env` File

**File to modify**: `.github/workflows/deploy-vps.yml`

Replace the "Start server" step's script (lines ~125-173) with:

```yaml
      - name: Start server
        uses: appleboy/ssh-action@v1.0.3
        env:
          ZAJEL_ADMIN_JWT_SECRET: ${{ secrets.ZAJEL_ADMIN_JWT_SECRET }}
        with:
          host: ${{ vars.VPS_SERVERS }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          port: ${{ secrets.VPS_PORT || 22 }}
          envs: ZAJEL_ADMIN_JWT_SECRET
          script: |
            set -e
            cd /opt/zajel/server-vps

            # Create data directory
            mkdir -p data

            npm ci --omit=dev

            # Get public IP for the endpoint
            PUBLIC_IP=$(curl -sf http://checkip.amazonaws.com || curl -sf http://ifconfig.me || echo "localhost")

            # Write environment file with restricted permissions
            # Use install to create the file with 0600 before writing content
            install -m 0600 /dev/null .env

            cat > .env << ENVEOF
            ZAJEL_PORT=80
            ZAJEL_KEY_PATH=./data/server.key
            ZAJEL_DB_PATH=./data/zajel.db
            ZAJEL_PUBLIC_ENDPOINT=ws://${PUBLIC_IP}
            ZAJEL_REGION=auto
            ZAJEL_BOOTSTRAP_URL=https://signal.zajel.hamzalabs.dev
            ZAJEL_ADMIN_JWT_SECRET=${ZAJEL_ADMIN_JWT_SECRET}
            ZAJEL_CF_ADMIN_URL=https://admin.zajel.hamzalabs.dev
            ENVEOF

            # Verify permissions are restrictive
            ENV_PERMS=$(stat -c '%a' .env)
            if [ "$ENV_PERMS" != "600" ]; then
              echo "ERROR: .env has permissions $ENV_PERMS, expected 600"
              chmod 600 .env
            fi

            # Remove legacy start.sh if it exists (contains plaintext secret)
            if [ -f start.sh ]; then
              shred -u start.sh 2>/dev/null || rm -f start.sh
              echo "Removed legacy start.sh"
            fi

            # Stop existing if running
            pm2 delete zajel-server 2>/dev/null || true

            # Start with PM2 directly, no bash wrapper needed
            # dotenv in config.ts loads .env automatically when cwd is correct
            pm2 start dist/index.js --name zajel-server \
              --cwd /opt/zajel/server-vps \
              --max-memory-restart 512M \
              --exp-backoff-restart-delay=100
            pm2 save

            # Check PM2 status
            pm2 list
            sleep 3

            # Check port
            echo "=== Checking port 80 ==="
            netstat -tlnp 2>/dev/null | grep :80 || ss -tlnp | grep :80 || echo "Port 80 not listening"
            echo "=========================="

            # Wait for server to be ready
            echo "Waiting for server to start..."
            for i in {1..6}; do
              if curl -sf http://localhost:80/health; then
                echo "Health check passed!"
                pm2 logs zajel-server --lines 20 --nostream || true
                exit 0
              fi
              echo "Attempt $i failed, waiting 5 seconds..."
              pm2 logs zajel-server --lines 5 --nostream 2>/dev/null || true
              sleep 5
            done

            # If we get here, show logs and fail
            echo "Health check failed after 30 seconds"
            pm2 logs zajel-server --lines 100 --nostream
            pm2 show zajel-server
            exit 1
```

Key changes:
1. `install -m 0600 /dev/null .env` creates the file with restrictive permissions **before** any content is written, preventing a race condition where another process could read the file between creation and `chmod`.
2. PM2 launches `dist/index.js` directly instead of through a bash wrapper. The `dotenv` library in `config.ts` handles `.env` loading.
3. The legacy `start.sh` is securely deleted with `shred` (falls back to `rm` if `shred` is unavailable).
4. Permissions are verified after writing.

### 3.2 Step 2: QA Deploy -- Replace `start-qa.sh` with `.env` File

**File to modify**: `.github/workflows/pr-pipeline.yml`

Replace the start-qa.sh creation block (lines ~1487-1521) with:

```bash
            # Write environment file with restricted permissions
            install -m 0600 /dev/null .env

            cat > .env << ENVEOF
            ZAJEL_PORT=8443
            ZAJEL_KEY_PATH=./data-qa/server.key
            ZAJEL_DB_PATH=./data-qa/zajel.db
            ZAJEL_PUBLIC_ENDPOINT=${PUBLIC_ENDPOINT}
            ZAJEL_REGION=qa
            ZAJEL_BOOTSTRAP_URL=${BOOTSTRAP_URL}
            ZAJEL_ADMIN_JWT_SECRET=${ZAJEL_ADMIN_JWT_SECRET}
            ZAJEL_CF_ADMIN_URL=https://admin.zajel.qa.hamzalabs.dev
            ZAJEL_TLS_CERT=${TLS_CERT}
            ZAJEL_TLS_KEY=${TLS_KEY}
            NODE_ENV=qa
            APP_VERSION=${APP_VERSION}
            ENVEOF

            # Verify permissions
            ENV_PERMS=$(stat -c '%a' .env)
            if [ "$ENV_PERMS" != "600" ]; then
              chmod 600 .env
            fi

            # Remove legacy start-qa.sh if it exists
            if [ -f start-qa.sh ]; then
              shred -u start-qa.sh 2>/dev/null || rm -f start-qa.sh
            fi

            # Verify the env file has the bootstrap URL
            if ! grep -q "ZAJEL_BOOTSTRAP_URL=https" .env; then
              echo "ERROR: .env missing BOOTSTRAP_URL"
              # Print only non-secret lines for debugging
              grep -v 'JWT_SECRET\|TLS_KEY' .env
              exit 1
            fi

            mkdir -p data-qa

            # Stop existing QA server
            pm2 delete zajel-server-qa 2>/dev/null || true

            # Start QA server -- dotenv loads .env from cwd
            pm2 start dist/index.js --name zajel-server-qa \
              --cwd /opt/zajel/server-vps-qa
            pm2 save
```

Note the validation step now uses `grep -v 'JWT_SECRET\|TLS_KEY'` to avoid printing secrets in CI logs on failure, fixing threat T5.

### 3.3 Step 3: Secure PM2 Dump File

PM2 caches process metadata (including environment variables) in `~/.pm2/dump.pm2`. Since we are no longer passing env vars through PM2's process config (they come from dotenv at runtime inside the Node process), PM2 will not capture them. However, to clean up any existing cached secrets:

Add to both deploy scripts, after `pm2 save`:

```bash
            # Verify PM2 dump does not contain secrets
            if grep -q "ZAJEL_ADMIN_JWT_SECRET" ~/.pm2/dump.pm2 2>/dev/null; then
              echo "WARNING: PM2 dump contains JWT secret, regenerating..."
              pm2 save --force
            fi
```

### 3.4 Step 4: Add .env to Server .gitignore

While the repo root `.gitignore` already has `.env` and `.env.*` entries (lines 68-69), add an explicit `.gitignore` in the server-vps package for defense in depth.

**New file**: `packages/server-vps/.gitignore`

```
# Environment file contains secrets
.env
.env.*

# Data directory
data/

# PM2 ecosystem file (may contain secrets)
ecosystem.config.*
```

### 3.5 Step 5: Clean Up Existing VPS Instances

Run a one-time cleanup on all VPS instances to remove legacy plaintext scripts. This can be done via a workflow dispatch job or manual SSH:

```bash
# Production VPS
ssh deploy@$VPS_IP << 'CLEANUP'
  # Securely delete legacy start scripts
  for f in /opt/zajel/server-vps/start.sh /opt/zajel/server-vps-qa/start-qa.sh; do
    if [ -f "$f" ]; then
      echo "Shredding $f"
      shred -vfz -n 3 "$f" 2>/dev/null && rm -f "$f" || rm -f "$f"
    fi
  done

  # Verify no secrets in PM2 dump
  if grep -q "ZAJEL_ADMIN_JWT_SECRET" ~/.pm2/dump.pm2 2>/dev/null; then
    echo "Regenerating PM2 dump..."
    pm2 resurrect 2>/dev/null || true
    pm2 save --force
  fi

  echo "Cleanup complete"
CLEANUP
```

### 3.6 Step 6: Rotate the JWT Secret

After the remediation is deployed and verified, rotate the `ZAJEL_ADMIN_JWT_SECRET` in GitHub Secrets and redeploy. The old secret has been exposed in plaintext on disk and should be considered potentially compromised. Update both:

1. GitHub Secret `ZAJEL_ADMIN_JWT_SECRET` -- generate a new 256-bit random value:
   ```bash
   openssl rand -base64 32
   ```
2. Cloudflare Workers secret (synced in pr-pipeline.yml line 1228):
   ```bash
   printf '%s' "$NEW_SECRET" | npx wrangler secret put ZAJEL_ADMIN_JWT_SECRET -c wrangler.jsonc --env qa
   ```
3. Redeploy both production VPS and QA VPS to pick up the new secret.

---

## 4. Files to Modify

| File | Change |
|------|--------|
| `.github/workflows/deploy-vps.yml` | Replace `start.sh` creation with `.env` file approach (Step 1) |
| `.github/workflows/pr-pipeline.yml` | Replace `start-qa.sh` creation with `.env` file approach (Step 2) |
| `packages/server-vps/.gitignore` | New file -- prevent accidental commit of `.env` (Step 4) |

No application code changes are required. The server's `config.ts` already calls `dotenv.config()` at startup, which loads `.env` from the current working directory.

---

## 5. Verification Steps

### 5.1 Pre-Deployment Verification

1. **Confirm dotenv loads from cwd**: Review `packages/server-vps/src/config.ts` line 10 -- `config()` from dotenv loads `.env` relative to `process.cwd()`. PM2's `--cwd` flag sets the working directory, so `.env` at `/opt/zajel/server-vps/.env` will be found.

2. **Test locally**: In `packages/server-vps/`, create a `.env` with test values and run `node dist/index.js`. Verify the config is loaded correctly.

### 5.2 Post-Deployment Verification (Production)

Run these checks via SSH after deploying the remediated workflow:

```bash
# 1. Verify .env exists with correct permissions
ls -la /opt/zajel/server-vps/.env
# Expected: -rw------- 1 deploy deploy ... .env

# 2. Verify start.sh no longer exists
test ! -f /opt/zajel/server-vps/start.sh && echo "PASS: start.sh removed" || echo "FAIL: start.sh still exists"

# 3. Verify .env is not world-readable
OTHER_PERMS=$(stat -c '%a' /opt/zajel/server-vps/.env | cut -c3)
[ "$OTHER_PERMS" = "0" ] && echo "PASS: .env not world-readable" || echo "FAIL: .env is world-readable"

# 4. Verify the server is running and healthy
curl -sf http://localhost:80/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS: healthy' if d.get('status')=='healthy' else 'FAIL')"

# 5. Verify admin dashboard is functional (if JWT secret is configured)
# The admin module logs "Admin dashboard enabled at /admin/" on startup
pm2 logs zajel-server --lines 50 --nostream | grep -q "Admin dashboard enabled" && echo "PASS: admin enabled" || echo "WARN: admin not enabled"

# 6. Verify PM2 dump does not contain the secret
grep -q "ZAJEL_ADMIN_JWT_SECRET" ~/.pm2/dump.pm2 2>/dev/null && echo "FAIL: secret in PM2 dump" || echo "PASS: PM2 dump clean"

# 7. Verify no other world-readable files contain the secret
find /opt/zajel -type f -perm -o=r -exec grep -l "ZAJEL_ADMIN_JWT_SECRET" {} \; 2>/dev/null
# Expected: no output
```

### 5.3 Post-Deployment Verification (QA)

Same checks as production, adjusted for QA paths:

```bash
ls -la /opt/zajel/server-vps-qa/.env
# Expected: -rw------- 1 deploy deploy ... .env

test ! -f /opt/zajel/server-vps-qa/start-qa.sh && echo "PASS" || echo "FAIL"

curl -sf -k "https://localhost:8443/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print('PASS' if d.get('status')=='healthy' else 'FAIL')"
```

### 5.4 CI Pipeline Verification

After merging the workflow changes:

1. Trigger a production deploy via push to `main` (or `workflow_dispatch`).
2. Open a PR to trigger the QA VPS deploy job.
3. Verify both deploy jobs succeed.
4. Verify the health check steps pass in the GitHub Actions logs.
5. Search the GitHub Actions logs for the literal string value of `ZAJEL_ADMIN_JWT_SECRET` -- it must not appear. GitHub masks secrets in logs, but the `cat start-qa.sh` fallback path (now removed) was a vector for leakage.

### 5.5 Regression Check

After secret rotation (Step 3.6):

1. Log into the admin dashboard via the CF Workers frontend.
2. Verify the JWT token is accepted by the VPS admin API.
3. Verify the VPS admin WebSocket connection works (`/admin/ws`).

---

## 6. Alternative Approaches Considered

### 6.1 systemd Environment Files (EnvironmentFile=)

systemd supports `EnvironmentFile=/etc/zajel/server.env` in unit files, with the file restricted to `0600`. This is the gold standard for Linux daemon secret management.

**Why not chosen**: The current deployment uses PM2, not systemd. Migrating to systemd is a larger change that affects restart behavior, log management, and the PM2 `pm2 save`/`pm2 startup` workflow. This could be a future improvement but is out of scope for this remediation.

### 6.2 PM2 Ecosystem File with `env` Block

PM2 supports `ecosystem.config.js` with environment variables:

```js
module.exports = {
  apps: [{
    name: 'zajel-server',
    script: 'dist/index.js',
    env: {
      ZAJEL_ADMIN_JWT_SECRET: '...',
    }
  }]
};
```

**Why not chosen**: PM2 caches ecosystem file contents in `~/.pm2/dump.pm2`, which creates the same plaintext-on-disk problem. Additionally, PM2's `pm2 save` serializes the full environment to the dump file. The dotenv approach avoids PM2 ever seeing the secret.

### 6.3 HashiCorp Vault or Cloud Secret Manager

The application could fetch secrets at runtime from a secret manager (Vault, AWS Secrets Manager, etc.) rather than reading from disk.

**Why not chosen**: Adds significant infrastructure complexity (Vault server, authentication bootstrapping, network dependency at startup). Appropriate for larger deployments but overkill for a single-VPS setup. The `.env` file with restrictive permissions is a proportionate control for the current threat model.

### 6.4 Passing Secrets via PM2 `--env` Flag or Environment

PM2 can receive environment variables from the parent shell:

```bash
ZAJEL_ADMIN_JWT_SECRET=xxx pm2 start dist/index.js --name zajel-server --update-env
```

**Why not chosen**: PM2's `pm2 save` serializes the process's environment to `~/.pm2/dump.pm2`, including any environment variables present at start time. On `pm2 resurrect` (after reboot), PM2 restores from this dump. The secret would end up in the dump file. The dotenv approach keeps the secret out of PM2's process metadata entirely.

---

## 7. Summary of Security Improvements

| Before | After |
|--------|-------|
| JWT secret in world-readable `start.sh` (0755) | JWT secret in owner-only `.env` (0600) |
| Secret visible via `cat start.sh` to any local user | Secret readable only by the deploy user |
| Secret cached in PM2 dump file | Secret loaded by dotenv at runtime, not in PM2 metadata |
| `cat start-qa.sh` in CI failure path leaks secret to logs | Failure path uses `grep -v` to redact secrets |
| Bash wrapper script adds unnecessary attack surface | PM2 launches Node directly, simpler process tree |
| No file permission verification | Explicit permission check with fallback `chmod` |
| No cleanup of old secrets on deploy | `shred` + `rm` of legacy scripts on deploy |
