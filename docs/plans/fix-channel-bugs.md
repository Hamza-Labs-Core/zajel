# Fix Channel Chunk Relay Bugs

5 critical bugs that collectively make channels completely non-functional.
The bugs exist in the **seams between components** where assumptions diverge.

---

## Bug 1: Chunk Size Mismatch — Server Rejects ALL Chunks

| Component | Constant | Value |
|-----------|----------|-------|
| `channel_service.dart:20` | `chunkSize` | **64 KB** |
| `chunk-relay.ts:34` (VPS) | `MAX_TEXT_CHUNK_PAYLOAD` | **4 KB** |
| `websocket-handler.js:9` (CF) | `MAX_TEXT_CHUNK_PAYLOAD` | **4 KB** |

**Impact:** Every `chunk_push` is rejected. No chunk ever gets cached or relayed.

**Fix:** Raise server limit to 64 KB on both servers:

- `packages/server-vps/src/client/chunk-relay.ts` line 34:
  `const MAX_TEXT_CHUNK_PAYLOAD = 64 * 1024;`
- `packages/server/src/websocket-handler.js` line 9:
  `const MAX_TEXT_CHUNK_PAYLOAD = 64 * 1024;`

No change to the Flutter app.

---

## Bug 2: `pushChunk` Missing `channelId` in Message

**File:** `packages/app/lib/features/channels/services/channel_sync_service.dart` lines 246-256

The `pushChunk` method has `channelId` as a parameter but **does not include it in the message**. The VPS validates `channelId` as required and rejects pushes without it.

**Fix:** Add `'channelId': channelId` to the message:

```dart
_sendMessage({
  'type': 'chunk_push',
  'peerId': peerId,
  'chunkId': chunkId,
  'channelId': channelId,  // ADD THIS
  'data': chunk.toJson(),
});
```

Note: `chunk.toJson()` sending the full metadata Map is the correct behavior — subscribers need the full chunk object to reconstruct, verify signatures, and store.

---

## Bug 3: `_handleChunkData` Drops Cache-Served Chunks

**File:** `packages/app/lib/features/channels/services/channel_sync_service.dart` lines 311-320

When the VPS serves from cache, `data` arrives as a String. The handler silently `return`s, discarding all cached chunks.

**Fix:** Parse JSON strings instead of dropping them. Add `import 'dart:convert';` and update:

```dart
Map<String, dynamic>? chunkData;
if (data is Map<String, dynamic>) {
  chunkData = data;
} else if (data is String) {
  // Cache-served data may be a JSON string — attempt to parse
  try {
    final decoded = jsonDecode(data);
    if (decoded is Map<String, dynamic>) {
      chunkData = decoded;
    } else {
      return;
    }
  } catch (_) {
    return;
  }
} else {
  return;
}
```

---

## Bug 4: `announceChunk` in Publish Flow Omits `channelId`

**File:** `packages/app/lib/features/channels/channel_detail_screen.dart` line 425-427

Without `channelId`, the VPS cannot notify subscribers that new chunks exist.

**Fix:**
```dart
for (final chunk in chunks) {
  syncService.announceChunk(chunk, channelId: channel.id);  // ADD channelId
}
```

**Also fix** `packages/app/lib/features/channels/services/live_stream_service.dart` line 379:
```dart
syncService.announceChunk(chunk, channelId: channelId);
```

(`channel_providers.dart:114` already passes channelId correctly.)

---

## Bug 5: VPS `chunk_push` Handler Type Mismatch

**File:** `packages/server-vps/src/client/chunk-relay.ts` — `handlePush` method

The method declares `data: string` and calls `Buffer.from(data, 'base64')`, but the client sends a JSON object. This produces garbage or throws.

**Fix:**

1. Update `handlePush` to accept `string | object`:
   - Normalize to JSON string for size validation: `const dataStr = typeof data === 'string' ? data : JSON.stringify(data);`
   - Validate `dataStr.length` against `MAX_TEXT_CHUNK_PAYLOAD`
   - Store as `Buffer.from(dataStr, 'utf-8')` (JSON string, not raw binary)
   - Forward the original `data` object to pending requesters

2. Update cache-hit serving in `handleRequest` to parse stored JSON:
   ```typescript
   let cachedData: object;
   try {
     cachedData = JSON.parse(cached.data.toString('utf-8'));
   } catch {
     cachedData = cached.data.toString('base64');  // Legacy fallback
   }
   ```

3. Update `ChunkPushMessage` interface in `handler.ts`:
   ```typescript
   data: string | Record<string, unknown>;
   ```

---

## Implementation Sequence

1. **Bug 1** (server-side): Raise `MAX_TEXT_CHUNK_PAYLOAD` on both servers to `64 * 1024`
2. **Bug 5** (VPS server): Fix `handlePush` to accept JSON objects, store/serve correctly
3. **Bug 2** (client): Add `channelId` to `pushChunk` message
4. **Bug 3** (client): Fix `_handleChunkData` to parse JSON strings
5. **Bug 4** (client): Add `channelId` to `announceChunk` calls
6. **Tests**: Update all test files

---

## Test Updates Required

### `channel_sync_service_test.dart`
- Add assertion for `channelId` in pushChunk message
- Add test for `_handleChunkData` with JSON string data (cache path)
- Add test for `_handleChunkData` with invalid string data

### `client-handler-chunks.test.ts` (VPS)
- Update size limit tests to 64KB threshold
- Add test for JSON object data in chunk_push
- Add test for cache-hit returning JSON object

### `websocket-handler-chunks.test.js` (CF Worker)
- Update size limit tests to 64KB threshold

---

## Files Changed

| File | Bug(s) | Change |
|------|--------|--------|
| `packages/server-vps/src/client/chunk-relay.ts` | 1, 5 | Raise limit, fix handlePush + cache serving |
| `packages/server/src/websocket-handler.js` | 1 | Raise limit |
| `packages/app/lib/features/channels/services/channel_sync_service.dart` | 2, 3 | Add channelId to pushChunk, parse JSON strings |
| `packages/app/lib/features/channels/channel_detail_screen.dart` | 4 | Pass channelId to announceChunk |
| `packages/app/lib/features/channels/services/live_stream_service.dart` | 4 | Pass channelId to announceChunk |
| `packages/server-vps/src/client/handler.ts` | 5 | Update ChunkPushMessage interface |

---

## Backward Compatibility

- VPS accepting `string | object` data — old clients still work
- Client parsing both string and object responses — handles both server formats
- CF Worker already flexible — stores/forwards whatever data is
- Size limit change from 4KB to 64KB — loosens constraint, backward compatible
