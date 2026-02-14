# Plan: SignalingRoom and RelayRegistryDO exported but SignalingRoom not routed

**Issue**: issue-server-36.md
**Severity**: LOW
**Area**: Server
**Files to modify**: `packages/server/src/index.js`, potentially remove dead code files

## Analysis

Examining the current state of the codebase:

**`packages/server/wrangler.jsonc`** (lines 24-42) shows the migration history:
- v1: `new_classes: ["SignalingRoom"]`
- v2: `new_classes: ["RelayRegistryDO"]`
- v3: `new_classes: ["ServerRegistryDO"]`, `deleted_classes: ["SignalingRoom", "RelayRegistryDO"]`
- v4: `new_classes: ["AttestationRegistryDO"]`

The active DO bindings (lines 11-20) only include `SERVER_REGISTRY` (ServerRegistryDO) and `ATTESTATION_REGISTRY` (AttestationRegistryDO).

**`packages/server/src/index.js`** (lines 21-22) only exports the active DOs:
```js
export { ServerRegistryDO } from './durable-objects/server-registry-do.js';
export { AttestationRegistryDO } from './durable-objects/attestation-registry-do.js';
```

`SignalingRoom` and `RelayRegistryDO` are NOT exported from `index.js`, confirming they are dead code.

**Dead code files** that still exist:
- `packages/server/src/signaling-room.js` -- SignalingRoom DO
- `packages/server/src/durable-objects/relay-registry-do.js` -- RelayRegistryDO
- `packages/server/src/relay-registry.js` -- RelayRegistry class
- `packages/server/src/rendezvous-registry.js` -- RendezvousRegistry class
- `packages/server/src/chunk-index.js` -- ChunkIndex class
- `packages/server/src/websocket-handler.js` -- WebSocketHandler class

These files are imported by `relay-registry-do.js` (lines 8-11) and `signaling-room.js` (line 9), but since neither DO is exported or bound, none of this code is deployed.

## Fix Steps

### Option A: Remove dead code (recommended if not planning to re-enable)

1. Delete the following files:
   - `packages/server/src/signaling-room.js`
   - `packages/server/src/durable-objects/relay-registry-do.js`
   - `packages/server/src/relay-registry.js`
   - `packages/server/src/rendezvous-registry.js`
   - `packages/server/src/chunk-index.js`
   - `packages/server/src/websocket-handler.js`

2. Verify that `index.js` does not import any of these files (it currently does not).

3. Keep `logger.js` since it is a utility that could be used by the active DOs.

### Option B: Keep dead code but document it (if planning to re-enable)

1. Add a `README.md` or code comments in the dead code files marking them as inactive:
   ```js
   // NOTE: This class is currently inactive (deleted in wrangler.jsonc migration v3).
   // It is retained for potential future re-enablement.
   ```

2. Add the same note to all dependent files.

### Option C: Move dead code to a separate directory

1. Create `packages/server/src/inactive/` and move the dead code files there.
2. This makes it clear which code is active vs. inactive without deleting it.

## Testing

- For Option A: Verify that `npm run build --workspace=@zajel/server` succeeds without the deleted files.
- Verify that all active endpoints (`/servers/*`, `/attest/*`, `/health`, `/`) continue to work.
- Run existing tests to confirm no regressions.
- Verify that `wrangler deploy` succeeds (the deleted classes are already handled by the migration history).

## Risk Assessment

- **Option A (delete)**: Low risk since the code is provably unreachable. The main risk is losing the code for future reference, but it remains in git history.
- **Option B (document)**: Zero risk, but the dead code remains as a maintenance burden and audit surface.
- **Option C (move)**: Low risk, provides clear separation without losing the code.
- The migration history in `wrangler.jsonc` must NOT be modified -- it is needed by Cloudflare to track DO class transitions.
