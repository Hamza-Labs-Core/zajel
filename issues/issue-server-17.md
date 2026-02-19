# [MEDIUM] Build token timestamp allows 1-year window enabling replay attacks

**Area**: Server
**File**: packages/server/src/durable-objects/attestation-registry-do.js:187-195
**Type**: Security

**Description**: The build token timestamp validation allows tokens up to 1 year old:
```js
const tokenAge = Date.now() - timestamp;
if (tokenAge > 365 * 24 * 60 * 60 * 1000) {
  return this.jsonResponse({ error: 'Build token expired' }, 403, corsHeaders);
}
```
Additionally, there is no protection against future-dated timestamps. A token with `timestamp: Date.now() + 365 * 24 * 60 * 60 * 1000` would pass validation and remain valid for 2 years.

**Impact**: A compromised build token remains usable for an entire year, giving an attacker a very long window to register rogue devices. If a token's signing key is rotated, old tokens from the compromised key still work. Tokens with future timestamps extend this window even further.

**Fix**:
1. Reduce the token validity window to a reasonable period (e.g., 7 days or 30 days).
2. Add a check for future-dated timestamps:
```js
const tokenAge = Date.now() - timestamp;
if (tokenAge > 30 * 24 * 60 * 60 * 1000 || tokenAge < -60 * 1000) {
  return this.jsonResponse({ error: 'Build token expired or invalid timestamp' }, 403, corsHeaders);
}
```
3. Consider maintaining a revocation list for compromised tokens.
