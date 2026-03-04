# [MEDIUM] peerId not validated for format or length in WebSocket handler

**Area**: Server
**File**: packages/server/src/websocket-handler.js:112-114
**Type**: Security

**Description**: The `handleRegister` method only checks that `peerId` is truthy:
```js
if (!peerId) {
  this.sendError(ws, 'Missing required field: peerId');
  return;
}
```
There is no validation of:
- Type (could be a number, object, or array -- `JSON.parse` allows all JSON types)
- Maximum length (could be megabytes long)
- Character set
- Format

The same lack of validation applies to `peerId` in `handleUpdateLoad`, `handleRegisterRendezvous`, `handleChunkAnnounce`, `handleChunkRequest`, and `handleHeartbeat`.

**Impact**:
- A very long peerId string as a Map key consumes excess memory.
- Non-string values as Map keys can cause unexpected behavior.
- Special characters could potentially cause issues in logging or downstream processing.

**Fix**: Add type and format validation:
```js
if (!peerId || typeof peerId !== 'string' || peerId.length > 128 || !/^[\w-]+$/.test(peerId)) {
  this.sendError(ws, 'Invalid peerId: must be 1-128 alphanumeric characters');
  return;
}
```
