# Admin Dashboard Setup

## Prerequisites

- Wrangler CLI installed (`npm install -g wrangler`)
- Access to Cloudflare account
- VPS server running Zajel

## Step 1: Generate JWT Secret

```bash
openssl rand -base64 32
```

Save this secret - it will be used in both places below.

## Step 2: Deploy CF Workers Dashboard

```bash
cd packages/admin-cf

# Install dependencies
npm install

# Set the JWT secret (enter when prompted)
wrangler secret put ZAJEL_ADMIN_JWT_SECRET

# Deploy to Cloudflare
wrangler deploy
```

Note the deployed URL (e.g., `https://zajel-admin.mahmoud-s-darwish.workers.dev`)

## Step 3: Initialize First Admin User

```bash
# Replace with your deployed URL
curl -X POST https://zajel-admin.mahmoud-s-darwish.workers.dev/admin/api/auth/init \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "your-secure-password-min-12-chars"}'
```

## Step 4: Configure VPS Server

Add to your VPS environment (choose one method):

### Option A: Environment file (.env)
```bash
ZAJEL_ADMIN_JWT_SECRET=<same-secret-from-step-1>
ZAJEL_CF_ADMIN_URL=https://zajel-admin.mahmoud-s-darwish.workers.dev
```

### Option B: Systemd service
```ini
# /etc/systemd/system/zajel.service
[Service]
Environment="ZAJEL_ADMIN_JWT_SECRET=<secret>"
Environment="ZAJEL_CF_ADMIN_URL=https://zajel-admin.mahmoud-s-darwish.workers.dev"
```

### Option C: GitHub Secrets (for CI/CD)
1. Go to repo → Settings → Secrets and variables → Actions
2. Add secret: `ZAJEL_ADMIN_JWT_SECRET`
3. Reference in workflow: `${{ secrets.ZAJEL_ADMIN_JWT_SECRET }}`

## Step 5: Restart VPS Server

```bash
# If using systemd
sudo systemctl restart zajel

# Or restart your process manager
```

## Step 6: Verify Setup

1. Open CF Dashboard: `https://zajel-admin.mahmoud-s-darwish.workers.dev/admin/`
2. Login with credentials from Step 3
3. Click on a server card to open its VPS dashboard
4. Verify real-time metrics are updating

## Troubleshooting

### "Admin module not initialized" on VPS
- Check `ZAJEL_ADMIN_JWT_SECRET` is set
- Restart the VPS server

### "Invalid or expired token"
- Ensure both secrets are identical
- JWT expires after 15 minutes - login again

### Server cards show "offline"
- Check VPS `/stats` endpoint is accessible
- Verify VPS is registered with bootstrap server

## Security Notes

- JWT tokens expire after 15 minutes
- Passwords require minimum 12 characters
- Rate limited: 5 login attempts per minute per IP
- Use HTTPS in production
