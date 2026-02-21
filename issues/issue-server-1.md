# [CRITICAL] Wildcard CORS allows any origin to access all API endpoints

**Area**: Server
**File**: packages/server/src/index.js:29
**Type**: Security

**Description**: The server sets `Access-Control-Allow-Origin: *` on every response, including authenticated endpoints like server registration, deletion, attestation, and admin operations. This allows any website on the internet to make cross-origin requests to the API and read responses. While the bootstrap/attestation endpoints use secret-based auth, wildcard CORS combined with `Authorization` in `Access-Control-Allow-Headers` means malicious sites can attempt credential-bearing requests.

**Impact**: Any malicious website can interact with the API on behalf of a user who has the page open. If session tokens or API keys are stored in browser-accessible storage, an attacker's site can exfiltrate them. This is particularly dangerous for the admin endpoints (`POST /attest/versions`, `POST /attest/upload-reference`) which rely on `Authorization` headers -- a phishing page could relay stolen credentials via CORS.

**Fix**: Replace the wildcard `*` with an explicit allowlist of trusted origins. At minimum:
```js
const ALLOWED_ORIGINS = ['https://zajel.hamzalabs.dev', 'https://signal.zajel.hamzalabs.dev'];
const origin = request.headers.get('Origin');
const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
const corsHeaders = { 'Access-Control-Allow-Origin': corsOrigin, ... };
```
If the API is only consumed by native apps (not browsers), consider removing CORS headers entirely or restricting to development origins only.
