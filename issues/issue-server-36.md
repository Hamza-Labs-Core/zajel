# [LOW] SignalingRoom and RelayRegistryDO exported but SignalingRoom not routed

**Area**: Server
**File**: packages/server/src/index.js:20-22, packages/server/wrangler.jsonc:37
**Type**: Bug

**Description**: The `SignalingRoom` class is still imported and code exists in `signaling-room.js`, but looking at `wrangler.jsonc`, the migration history shows:
```json
{ "tag": "v3", "new_classes": ["ServerRegistryDO"], "deleted_classes": ["SignalingRoom", "RelayRegistryDO"] }
```
`SignalingRoom` and `RelayRegistryDO` were deleted in migration v3. However:
1. `index.js` does not export `SignalingRoom` (it only exports `ServerRegistryDO` and `AttestationRegistryDO`).
2. `signaling-room.js`, `relay-registry-do.js`, `relay-registry.js`, `rendezvous-registry.js`, `chunk-index.js`, and `websocket-handler.js` still exist as code files.
3. No routes in `index.js` forward to `RelayRegistryDO`.

The `wrangler.jsonc` bindings only include `SERVER_REGISTRY` and `ATTESTATION_REGISTRY` -- there is no binding for `RelayRegistryDO` or `SignalingRoom`.

**Impact**: Dead code: The signaling room, relay registry, rendezvous registry, chunk index, and WebSocket handler files exist but are not deployed or reachable in the current configuration. While this is not a runtime security issue, dead code increases the attack surface for future misconfigurations and makes auditing harder.

**Fix**: Either:
1. Remove the dead code files if they are no longer needed.
2. Or add proper bindings and routes if they are still intended to be used.
3. Document the current architecture clearly to avoid confusion.
