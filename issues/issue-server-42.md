# [LOW] endpoint field in server registration not validated for format or scheme

**Area**: Server
**File**: packages/server/src/durable-objects/server-registry-do.js:62-87
**Type**: Security

**Description**: The `endpoint` field in server registration is stored as-is without validation:
```js
const { serverId, endpoint, publicKey, region } = body;
if (!serverId || !endpoint || !publicKey) { ... }
```
There is no validation that `endpoint` is:
- A valid URL
- Uses HTTPS (not HTTP or other schemes)
- Points to a reasonable hostname (not localhost, internal IPs, etc.)
- Has a reasonable length

Since `GET /servers` returns these endpoints to clients, who presumably connect to them, an attacker can register endpoints pointing to malicious servers or internal infrastructure.

**Impact**:
- **SSRF amplification**: An attacker registers an endpoint like `http://169.254.169.254/latest/meta-data/` (AWS metadata endpoint). Clients that automatically connect to listed endpoints would unwittingly probe internal services.
- **Phishing**: Registering endpoints on attacker-controlled domains.
- **XSS via stored data**: If endpoints are ever rendered in a web UI without sanitization.

**Fix**: Validate the endpoint format:
```js
try {
  const url = new URL(endpoint);
  if (!['https:', 'wss:'].includes(url.protocol)) {
    return error('Endpoint must use HTTPS or WSS');
  }
  if (['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname) ||
      url.hostname.startsWith('10.') || url.hostname.startsWith('192.168.')) {
    return error('Endpoint must not point to private addresses');
  }
} catch {
  return error('Invalid endpoint URL');
}
```
