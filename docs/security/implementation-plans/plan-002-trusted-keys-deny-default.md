# Implementation Plan 002: Flip Empty Trusted Keys Default to Deny

**Story Reference:** `story-002-trusted-keys-deny-default.md`
**Priority:** IMMEDIATE
**Severity:** CRITICAL
**Component:** packages/server (CF Workers)
**Created:** 2026-03-03

---

## 1. Summary

The current build signature verification logic in `ServerRegistryDO` uses a "fail-open" security anti-pattern: when no trusted build signing keys are configured, ANY server presenting a valid Ed25519 signature (signed with any key, including attacker-controlled keys) receives `buildVerified: true`. This defeats the entire purpose of build verification.

**Current Behavior:**
```javascript
const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);
```
The `trustedKeys.length === 0` condition short-circuits to `true`, allowing all valid signatures when no trusted keys are configured.

**Expected Behavior:**
When no trusted keys are configured, builds should be **denied by default**. Only servers signed with explicitly trusted keys should receive `buildVerified: true`.

**Security Impact:**
- Attackers can register servers that appear verified in public listings
- The `buildVerified` flag becomes meaningless (proves only "someone signed something")
- Window of vulnerability exists between deployment and key configuration
- Heartbeat re-verification has the same bug, allowing indefinite verification bypass

This fix changes the default from allow-all to deny-all, making verification opt-in rather than automatic.

---

## 2. Files to Modify

### 2.1 Source Code Changes

| File | Lines | Description |
|------|-------|-------------|
| `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` | 586 | Fix `keyTrusted` in `registerServer()` |
| `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` | 751 | Fix `keyTrusted` in `heartbeat()` |
| `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` | 590-598 | Add audit log for no-keys-configured case |

### 2.2 Test Files to Modify

| File | Lines | Description |
|------|-------|-------------|
| `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js` | 220-238 | Update test "should accept any valid signature when TRUSTED_BUILD_KEYS is not configured" |
| `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js` | New | Add test "should deny when no trusted keys configured (deny-default)" |
| `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js` | New | Add test "should log audit warning when no trusted keys configured" |
| `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js` | New | Add test "heartbeat should deny when no trusted keys configured" |

---

## 3. Implementation Steps

### Step 1: Fix `registerServer()` Key Verification Logic

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Location:** Line 586

**Before:**
```javascript
const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);
```

**After:**
```javascript
const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);
```

**Rationale:**
- Change `||` to `&&` to require both conditions: keys must be configured AND the provided key must be in the trusted set
- Change `=== 0` to `> 0` to flip the logic from "allow if empty" to "deny if empty"

---

### Step 2: Fix `heartbeat()` Key Verification Logic

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Location:** Line 751

**Before:**
```javascript
const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
```

**After:**
```javascript
const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
```

**Rationale:**
- Same fix as Step 1, applied to the heartbeat code path
- Ensures servers cannot maintain `buildVerified: true` through heartbeats when no trusted keys are configured

---

### Step 3: Add Audit Logging for No-Keys-Configured Case

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Location:** After line 586 (in `registerServer()`)

**Before:**
```javascript
    if (buildHash && buildSignature && buildSigningKey) {
      // Verify the Ed25519 signature over the build hash
      const sigValid = await BuildVerifier.verifySignature(buildHash, buildSignature, buildSigningKey);

      // Check if the signing key is trusted (DO storage first, env var fallback)
      const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
      const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);

      buildVerified = sigValid && keyTrusted;

      this.logger.info('[audit] Build signature checked', {
        action: 'build_verify',
        serverId,
        buildHash: buildHash.slice(0, 12),
        signatureValid: sigValid,
        keyTrusted,
        buildVerified,
        buildVersion,
      });
    }
```

**After:**
```javascript
    if (buildHash && buildSignature && buildSigningKey) {
      // Verify the Ed25519 signature over the build hash
      const sigValid = await BuildVerifier.verifySignature(buildHash, buildSignature, buildSigningKey);

      // Check if the signing key is trusted (DO storage first, env var fallback)
      const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
      const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);

      buildVerified = sigValid && keyTrusted;

      // Audit log when no trusted keys are configured
      if (trustedKeys.length === 0) {
        this.logger.warn('[audit] Build verification skipped: no trusted keys configured', {
          action: 'build_verify_no_keys',
          serverId,
          buildHash: buildHash.slice(0, 12),
          signatureValid: sigValid,
        });
      }

      this.logger.info('[audit] Build signature checked', {
        action: 'build_verify',
        serverId,
        buildHash: buildHash.slice(0, 12),
        signatureValid: sigValid,
        keyTrusted,
        buildVerified,
        buildVersion,
      });
    }
```

**Rationale:**
- Emit a warning-level audit log when build verification is attempted but no trusted keys are configured
- Helps operators detect misconfiguration
- Provides visibility into when servers are being denied due to missing key configuration

---

### Step 4: Add Audit Logging for Heartbeat No-Keys Case

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Location:** After line 751 (in `heartbeat()`)

**Before:**
```javascript
    // Re-verify build signature if provided in heartbeat
    if (typeof body.buildHash === 'string' && typeof body.buildSignature === 'string' && typeof body.buildSigningKey === 'string') {
      const sigValid = await BuildVerifier.verifySignature(body.buildHash, body.buildSignature, body.buildSigningKey);
      const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
      const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
      server.buildVerified = sigValid && keyTrusted;
      server.buildHash = body.buildHash;

      // Detect build hash change (possible hot-swap attack)
      const prevHash = server.buildHash;
      if (prevHash && prevHash !== body.buildHash) {
        this.logger.info('[anomaly] Build hash changed between heartbeats', {
          action: 'build_hash_changed',
          serverId,
          previousHash: prevHash.slice(0, 12),
          newHash: body.buildHash.slice(0, 12),
        });
      }
```

**After:**
```javascript
    // Re-verify build signature if provided in heartbeat
    if (typeof body.buildHash === 'string' && typeof body.buildSignature === 'string' && typeof body.buildSigningKey === 'string') {
      const sigValid = await BuildVerifier.verifySignature(body.buildHash, body.buildSignature, body.buildSigningKey);
      const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
      const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
      server.buildVerified = sigValid && keyTrusted;
      server.buildHash = body.buildHash;

      // Audit log when no trusted keys are configured
      if (trustedKeys.length === 0) {
        this.logger.warn('[audit] Build verification skipped in heartbeat: no trusted keys configured', {
          action: 'heartbeat_build_verify_no_keys',
          serverId,
          buildHash: body.buildHash.slice(0, 12),
          signatureValid: sigValid,
        });
      }

      // Detect build hash change (possible hot-swap attack)
      const prevHash = server.buildHash;
      if (prevHash && prevHash !== body.buildHash) {
        this.logger.info('[anomaly] Build hash changed between heartbeats', {
          action: 'build_hash_changed',
          serverId,
          previousHash: prevHash.slice(0, 12),
          newHash: body.buildHash.slice(0, 12),
        });
      }
```

**Rationale:**
- Same audit logging as registration, but for heartbeat path
- Consistent observability across both code paths

---

## 4. Test Plan

### 4.1 Update Existing Test (Change Expected Behavior)

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`

**Test:** Line 220-238 - "should accept any valid signature when TRUSTED_BUILD_KEYS is not configured"

**Change Required:**
This test currently expects `buildVerified: true` when no keys are configured. After the fix, it should expect `buildVerified: false`.

**Before:**
```javascript
    it('should accept any valid signature when TRUSTED_BUILD_KEYS is not configured', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      const buildHash = 'e'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:any-key-server',
        endpoint: 'wss://anykey.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      const entry = await mockState.storage.get('server:ed25519:any-key-server');
      expect(entry.buildVerified).toBe(true); // OLD BEHAVIOR: allow-all
    });
```

**After:**
```javascript
    it('should deny when no trusted keys configured (deny-default)', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      const buildHash = 'e'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:any-key-server',
        endpoint: 'wss://anykey.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      const entry = await mockState.storage.get('server:ed25519:any-key-server');

      // NEW BEHAVIOR: deny-default when no trusted keys configured
      expect(entry.buildVerified).toBe(false);
      expect(response.status).toBe(200); // Registration still succeeds
    });
```

---

### 4.2 Add New Test: Deny Default with Unsigned Build

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`

**Location:** After line 238 (in "Trusted Key Enforcement" describe block)

```javascript
    it('should deny build verification when no trusted keys and valid signature provided', async () => {
      const registry = new ServerRegistryDO(mockState, {});

      const buildHash = 'f'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      const request = createRequest('POST', '/servers', {
        serverId: 'ed25519:deny-default-server',
        endpoint: 'wss://deny.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);

      const entry = await mockState.storage.get('server:ed25519:deny-default-server');

      // Signature is valid but key is not trusted (no keys configured)
      expect(entry.buildVerified).toBe(false);
      expect(entry.buildHash).toBe(buildHash);
    });
```

---

### 4.3 Add New Test: Audit Logging for No Keys

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`

**Location:** After the test added in 4.2

```javascript
    it('should log audit warning when no trusted keys configured', async () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const registry = new ServerRegistryDO(mockState, {});
      registry.logger = mockLogger;

      const buildHash = 'g'.repeat(64);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:audit-log-server',
        endpoint: 'wss://audit.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      // Should emit warning about no trusted keys
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[audit] Build verification skipped: no trusted keys configured',
        expect.objectContaining({
          action: 'build_verify_no_keys',
          serverId: 'ed25519:audit-log-server',
        })
      );

      // Should still emit the regular audit log
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[audit] Build signature checked',
        expect.objectContaining({
          action: 'build_verify',
          buildVerified: false,
          keyTrusted: false,
        })
      );
    });
```

---

### 4.4 Add New Test: Heartbeat Deny Default

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`

**Location:** In "Heartbeat Build Re-verification" describe block (after line 328)

```javascript
    it('should deny in heartbeat when no trusted keys configured', async () => {
      const registry = new ServerRegistryDO(mockState, {});
      const buildHash = 'hhhh'.repeat(16);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      // Register first (will have buildVerified: false due to no keys)
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:heartbeat-deny',
        endpoint: 'wss://hbdeny.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      let entry = await mockState.storage.get('server:ed25519:heartbeat-deny');
      expect(entry.buildVerified).toBe(false);

      // Heartbeat with same build signature
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:heartbeat-deny',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      entry = await mockState.storage.get('server:ed25519:heartbeat-deny');

      // Should still be unverified after heartbeat
      expect(entry.buildVerified).toBe(false);
    });
```

---

### 4.5 Add New Test: Verify Re-verification on Next Heartbeat

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`

**Location:** After test added in 4.4

```javascript
    it('should re-verify to false when trusted keys are removed', async () => {
      const registry = new ServerRegistryDO(mockState, {
        CI_UPLOAD_SECRET: 'ci-secret-123',
      });
      const authHeaders = { Authorization: 'Bearer ci-secret-123' };

      // Upload trusted key first
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [keypair.publicKeyBase64],
      }, authHeaders));

      const buildHash = 'iiii'.repeat(16);
      const signature = await signBuildHash(keypair.privateKey, buildHash);

      // Register with trusted key
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:reverify-server',
        endpoint: 'wss://reverify.example.com',
        publicKey: 'test-key',
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      let entry = await mockState.storage.get('server:ed25519:reverify-server');
      expect(entry.buildVerified).toBe(true);

      // Remove all trusted keys
      await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
        keys: [],
      }, authHeaders));

      // Heartbeat should re-verify and flip to false
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:reverify-server',
        connections: 5,
        relayConnections: 3,
        signalingConnections: 2,
        buildHash,
        buildSignature: signature,
        buildSigningKey: keypair.publicKeyBase64,
      }));

      entry = await mockState.storage.get('server:ed25519:reverify-server');
      expect(entry.buildVerified).toBe(false);
    });
```

---

### 4.6 Integration Test: E2E Server Registration Flow

**File:** `/home/meywd/zajel-ddos/packages/server/tests/e2e/integration.test.js`

**Location:** Add new test in main describe block

```javascript
  it('should deny build verification for servers when no trusted keys configured', async () => {
    const mockState = new MockState();
    const doInstance = new ServerRegistryDO(mockState, {});
    const env = createMockEnv(doInstance);

    // Generate a test keypair
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    const publicKeyBase64 = btoa(String.fromCharCode(...spki.slice(-32)));

    const buildHash = 'a'.repeat(64);
    const data = new TextEncoder().encode(buildHash);
    const signature = await crypto.subtle.sign('Ed25519', keyPair.privateKey, data);
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

    // Register server with valid build signature but no trusted keys configured
    const registerRequest = new Request('https://test.workers.dev/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId: 'ed25519:integration-deny-test',
        endpoint: 'wss://integration.example.com',
        publicKey: 'test-integration-key',
        buildHash,
        buildSignature: signatureBase64,
        buildSigningKey: publicKeyBase64,
      }),
    });

    const registerResponse = await worker.fetch(registerRequest, env);
    expect(registerResponse.status).toBe(200);

    // List servers and verify buildVerified is false
    const listRequest = new Request('https://test.workers.dev/servers', {
      method: 'GET',
    });

    const listResponse = await worker.fetch(listRequest, env);
    const data = await listResponse.json();

    const server = data.servers.find(s => s.serverId === 'ed25519:integration-deny-test');
    expect(server).toBeDefined();
    expect(server.buildVerified).toBe(false);
  });
```

---

### 4.7 Test Execution Plan

Run tests in the following order:

1. **Unit Tests First:**
   ```bash
   npm run test --workspace=packages/server -- tests/unit/build-signing.test.js
   ```
   Expected: All tests pass with new deny-default behavior

2. **Integration Tests:**
   ```bash
   npm run test --workspace=packages/server -- tests/e2e/integration.test.js
   ```
   Expected: E2E test passes with deny-default behavior

3. **Full Test Suite:**
   ```bash
   npm run test --workspace=packages/server
   ```
   Expected: All server tests pass

---

## 5. Rollback Risk Assessment

### 5.1 Risk Level: LOW

**Why Low Risk:**
- This is a logic change that makes verification more strict, not less
- The change only affects the interpretation of an empty trusted key set
- Existing deployments with `TRUSTED_BUILD_KEYS` configured are NOT affected
- The fix is a 2-character change (`||` → `&&`, `=== 0` → `> 0`) in two locations
- Easy to revert if unexpected issues arise

### 5.2 Potential Impacts

| Impact | Severity | Mitigation |
|--------|----------|------------|
| Deployments with no keys configured will see all servers with `buildVerified: false` | LOW | This is the **intended** behavior; operators should configure keys |
| Existing servers registered before the fix with `buildVerified: true` will flip to `false` on next heartbeat | LOW | This is correct; they were incorrectly verified |
| Audit logs will emit warnings for unconfigured deployments | LOW | This provides helpful visibility |

### 5.3 Backwards Compatibility

- **Storage Format:** No changes to storage format or data structures
- **API Responses:** No changes to response schemas; `buildVerified` field already exists
- **Environment Variables:** No new env vars required; uses existing `TRUSTED_BUILD_KEYS` and `CI_UPLOAD_SECRET`
- **Trusted Keys Management:** Existing `POST /servers/trusted-keys` endpoint unchanged

### 5.4 Rollback Procedure

If rollback is needed:

1. Revert the two logic changes in `server-registry-do.js`:
   ```bash
   git revert <commit-hash>
   ```

2. Deploy the reverted version:
   ```bash
   npm run deploy --workspace=packages/server
   ```

3. Servers will revert to allow-all behavior on next heartbeat

**Rollback Time Estimate:** 5 minutes (single commit revert + deploy)

---

## 6. Dependencies on Other Stories

### 6.1 No Hard Dependencies

This story is **self-contained** and does not depend on other security stories.

### 6.2 Related Stories (Future Work)

While not required, the following stories would complement this fix:

- **Story 001** (if exists): Rate limiting for registration endpoint
  - **Why Related:** Prevents attackers from flooding the registry with rogue servers
  - **Impact on This Story:** None; this story works independently

- **Story 003** (if exists): Attestation or hardware-backed signing
  - **Why Related:** Further strengthens build verification beyond Ed25519 signatures
  - **Impact on This Story:** None; this story establishes the deny-default baseline

- **Story 004** (if exists): Automatic key rotation
  - **Why Related:** Helps operators manage trusted keys over time
  - **Impact on This Story:** None; this story fixes the immediate security gap

### 6.3 Stories That Depend on This One

Any future stories that rely on `buildVerified` being a meaningful trust signal will benefit from this fix:

- Server reputation scoring
- Automatic server discovery filtering
- Federation trust policies
- Client-side server selection

---

## 7. Deployment Strategy

### 7.1 Pre-Deployment Checklist

- [ ] All unit tests pass locally
- [ ] Integration tests pass locally
- [ ] Code reviewed and approved
- [ ] Audit logging verified in local tests
- [ ] No regression in other build-signing tests

### 7.2 Deployment Steps

1. **Merge to main branch:**
   ```bash
   git checkout main
   git merge feat/fix-build-verify-deny-default
   ```

2. **Deploy to Cloudflare Workers:**
   ```bash
   npm run deploy --workspace=packages/server
   ```

3. **Verify deployment:**
   - Check Cloudflare Workers logs for successful deployment
   - Verify version number updated

4. **Monitor for warnings:**
   - Watch for audit logs: `build_verify_no_keys` and `heartbeat_build_verify_no_keys`
   - These indicate deployments without trusted keys configured

### 7.3 Post-Deployment Verification

1. **Test deny-default behavior:**
   ```bash
   curl -X POST https://bootstrap.zajel.example.com/servers \
     -H "Content-Type: application/json" \
     -d '{
       "serverId": "ed25519:test-deny",
       "endpoint": "wss://test.example.com",
       "publicKey": "test-key",
       "buildHash": "aaaa...aaaa",
       "buildSignature": "valid-signature",
       "buildSigningKey": "valid-public-key"
     }'
   ```
   Expected: Response includes server but `buildVerified: false`

2. **Test with trusted keys:**
   - Upload trusted keys via `POST /servers/trusted-keys`
   - Register server with matching key
   - Expected: `buildVerified: true`

3. **Monitor Cloudflare Workers logs:**
   - Check for `[audit] Build verification skipped` warnings
   - Indicates deployments that need key configuration

### 7.4 Operator Communication

Send notice to operators:

> **Action Required: Configure Trusted Build Keys**
>
> A security fix has been deployed to the bootstrap service that changes build verification to deny-by-default. If you have not yet configured trusted build signing keys, all servers will show `buildVerified: false`.
>
> To configure trusted keys:
> 1. Set the `TRUSTED_BUILD_KEYS` environment variable, OR
> 2. Upload keys via `POST /servers/trusted-keys` with `CI_UPLOAD_SECRET`
>
> See [build-signing documentation] for details.

---

## 8. Success Criteria

### 8.1 Functional Requirements

- [x] When `trustedKeys.length === 0`, `buildVerified` is `false` for all servers
- [x] When `trustedKeys.length > 0`, only servers with keys in the trusted set get `buildVerified: true`
- [x] Both `registerServer` and `heartbeat` use deny-default logic
- [x] Audit log warning emitted when no trusted keys configured
- [x] Existing tests updated to reflect new behavior
- [x] New tests added to prevent regression

### 8.2 Security Requirements

- [x] Attackers cannot register servers with `buildVerified: true` when no keys configured
- [x] Self-signed builds are rejected unless signing key is trusted
- [x] Heartbeat re-verification also denies when no keys configured
- [x] Operators have visibility via audit logs when keys are missing

### 8.3 Testing Requirements

- [x] Unit test: `buildVerified` is `false` when no trusted keys
- [x] Unit test: `buildVerified` is `true` when key is trusted
- [x] Unit test: `buildVerified` is `false` when key is NOT trusted
- [x] Unit test: Heartbeat denies when no trusted keys
- [x] Unit test: Audit log emitted when no keys configured
- [x] Integration test: E2E registration with deny-default

---

## 9. Notes and Caveats

### 9.1 Development/Testing Environments

Developers who previously relied on the allow-all behavior for local testing will need to:

1. Set `TRUSTED_BUILD_KEYS` env var with their test key, OR
2. Accept `buildVerified: false` in tests

**Recommended Approach:**
Add a test key to `.dev.vars` for local development:
```bash
TRUSTED_BUILD_KEYS=<your-test-public-key-base64>
```

### 9.2 Graceful Migration for Existing Deployments

Existing servers with `buildVerified: true` from the old allow-all behavior will automatically flip to `false` on their next heartbeat if their key is not in the trusted set. This is the correct behavior.

If operators want to preserve verification status for legitimate servers:
1. Extract the `buildSigningKey` from existing verified servers
2. Upload those keys via `POST /servers/trusted-keys`
3. Servers will re-verify to `true` on next heartbeat

### 9.3 Monitoring and Alerts

Consider setting up alerts for:
- High frequency of `build_verify_no_keys` audit logs (indicates misconfiguration)
- Sudden drop in `buildVerified: true` servers after deployment (indicates keys need configuration)

### 9.4 Future Enhancements

After this fix, consider:
- **Startup health check:** Warn if `TRUSTED_BUILD_KEYS` and `CI_UPLOAD_SECRET` are both unset
- **Metrics dashboard:** Track % of servers with `buildVerified: true` over time
- **Automatic key rotation:** CI pipeline to rotate trusted keys periodically

---

## 10. Sign-Off

- **Implementation Plan Author:** Claude Sonnet 4.5
- **Date Created:** 2026-03-03
- **Story Reference:** `story-002-trusted-keys-deny-default.md`
- **Estimated Implementation Time:** 2 hours (code + tests + deployment)
- **Risk Level:** LOW
- **Approval Required From:** Security Team, Backend Team Lead

---

## Appendix A: Code Diff Summary

```diff
--- a/packages/server/src/durable-objects/server-registry-do.js
+++ b/packages/server/src/durable-objects/server-registry-do.js
@@ -583,11 +583,18 @@

       // Check if the signing key is trusted (DO storage first, env var fallback)
       const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
-      const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);
+      const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(buildSigningKey, trustedKeys);

       buildVerified = sigValid && keyTrusted;

+      // Audit log when no trusted keys are configured
+      if (trustedKeys.length === 0) {
+        this.logger.warn('[audit] Build verification skipped: no trusted keys configured', {
+          action: 'build_verify_no_keys',
+          serverId,
+          buildHash: buildHash.slice(0, 12),
+          signatureValid: sigValid,
+        });
+      }
+
       this.logger.info('[audit] Build signature checked', {
@@ -748,10 +755,17 @@
     if (typeof body.buildHash === 'string' && typeof body.buildSignature === 'string' && typeof body.buildSigningKey === 'string') {
       const sigValid = await BuildVerifier.verifySignature(body.buildHash, body.buildSignature, body.buildSigningKey);
       const trustedKeys = await BuildVerifier.loadTrustedKeys(this.state.storage, this.env.TRUSTED_BUILD_KEYS, this.env.CI_UPLOAD_SECRET);
-      const keyTrusted = trustedKeys.length === 0 || BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
+      const keyTrusted = trustedKeys.length > 0 && BuildVerifier.isTrustedKey(body.buildSigningKey, trustedKeys);
       server.buildVerified = sigValid && keyTrusted;
       server.buildHash = body.buildHash;

+      // Audit log when no trusted keys are configured
+      if (trustedKeys.length === 0) {
+        this.logger.warn('[audit] Build verification skipped in heartbeat: no trusted keys configured', {
+          action: 'heartbeat_build_verify_no_keys',
+          serverId,
+          buildHash: body.buildHash.slice(0, 12),
+          signatureValid: sigValid,
+        });
+      }
+
       // Detect build hash change (possible hot-swap attack)
```

**Total Lines Changed:** ~20 lines
**Files Modified:** 1 (plus test files)
**Complexity:** Low (boolean logic change + audit logging)

---

**END OF IMPLEMENTATION PLAN**
