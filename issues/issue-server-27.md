# [MEDIUM] maxConnections value not validated in relay registration

**Area**: Server
**File**: packages/server/src/websocket-handler.js:112, packages/server/src/relay-registry.js:22
**Type**: Security

**Description**: The `maxConnections` parameter in peer registration defaults to 20 but is never validated:
```js
const { peerId, maxConnections = 20, publicKey } = message;
```
A client can send `maxConnections: 0`, `maxConnections: -1`, `maxConnections: Infinity`, `maxConnections: "string"`, or `maxConnections: 999999999`.

In `getAvailableRelays`, the capacity is calculated as:
```js
const capacity = peer.connectedCount / peer.maxConnections;
```
- If `maxConnections` is 0, this produces `Infinity` or `NaN`.
- If `maxConnections` is negative, the capacity ratio is negative, which always passes the `< 0.5` check.
- If `maxConnections` is extremely large, the peer always appears to have spare capacity.

Similarly, `connectedCount` in `updateLoad` is not validated, allowing negative values.

**Impact**: A malicious peer can manipulate its perceived capacity to always be selected as a relay (by setting `maxConnections` to a huge number) or to cause division-by-zero/NaN issues in capacity calculations.

**Fix**: Validate both values:
```js
const maxConn = parseInt(maxConnections, 10);
if (!Number.isFinite(maxConn) || maxConn < 1 || maxConn > 1000) {
  this.sendError(ws, 'maxConnections must be between 1 and 1000');
  return;
}
```
