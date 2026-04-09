# Plan: Cross-Server Channel Message Relay

## Problem

Channel messages (chunk_announce) only reach subscribers on the **same** VPS server. When a channel owner is on Server A and a subscriber is on Server B, the subscriber never receives chunk_available notifications. This breaks channels in a multi-server federation.

## Current Architecture

```
Server A                          Server B
├── Channel owner (Linux)         ├── Channel subscriber (Windows)
├── chunk_announce → local only   ├── Never gets chunk_available
└── Federation (gossip only)      └── Federation (gossip only)
```

- `ChannelHandler` tracks owners and subscribers in local maps only
- `chunk_announce` in `handler.ts` broadcasts `chunk_available` to `channelHandler.getSubscribers(channelId)` — local WebSockets only
- Federation layer handles gossip membership but no channel messages

## Solution: Federation Channel Relay

### Phase 1: Channel Registration Gossip

When a client subscribes to or owns a channel, the server gossips this to the federation so other servers know where subscribers and owners are.

**Server-side changes (`server-vps`):**

1. **New federation message types:**
   - `channel-owner-announce { channelId, serverId, endpoint }` — "I have the owner of this channel"
   - `channel-subscriber-announce { channelId, serverId, endpoint }` — "I have subscribers for this channel"
   - `channel-unsubscribe-announce { channelId, serverId }` — cleanup on disconnect

2. **ChannelHandler extensions:**
   - `remoteSubscribers: Map<channelId, Set<{serverId, endpoint}>>` — track which servers have subscribers
   - `remoteOwners: Map<channelId, {serverId, endpoint}>` — track which server has the owner
   - On local `channel-subscribe`: gossip `channel-subscriber-announce` to federation
   - On local `channel-owner-register`: gossip `channel-owner-announce` to federation
   - On client disconnect: gossip `channel-unsubscribe-announce`

### Phase 2: Cross-Server Chunk Relay

When a chunk is announced on a server that has subscribers on other servers, forward the announcement.

**Server-side changes:**

3. **handler.ts `handleChunkAnnounce`:**
   - After notifying local subscribers, check `channelHandler.remoteSubscribers`
   - For each remote server with subscribers, send via federation transport:
     ```
     federation-chunk-relay {
       channelId, chunkIds, sourceServerId, sourcePeerId
     }
     ```

4. **Federation transport handler:**
   - On receiving `federation-chunk-relay`, look up local subscribers for that channelId
   - Send `chunk_available { channelId, chunkIds }` to each local subscriber WebSocket

### Phase 3: Chunk Fetch Relay

When a subscriber on Server B receives `chunk_available` and requests the chunk, the request needs to reach the owner on Server A.

5. **`chunk_request` cross-server forwarding:**
   - If the chunk source is not local, forward `chunk_request` via federation to the server that announced it
   - The remote server delivers the request to the chunk owner
   - Owner sends `chunk_data` back through the same relay path

### File Changes

| File | Change |
|------|--------|
| `server-vps/src/client/channel-handler.ts` | Add `remoteSubscribers`, `remoteOwners` maps; gossip on subscribe/owner-register/disconnect |
| `server-vps/src/client/handler.ts` | Forward `chunk_announce` to remote subscriber servers |
| `server-vps/src/federation/federation-manager.ts` | Add `channel-*-announce` and `federation-chunk-relay` message handlers |
| `server-vps/src/federation/transport.ts` | Add relay message types |

### Risks

- **Gossip overhead**: Every channel subscription creates federation messages. Mitigate with batching (announce all channels on connect, not one-by-one).
- **Stale routes**: Server crash leaves stale subscriber records. Use TTL + heartbeat refresh.
- **Duplicate delivery**: Subscriber on multiple servers via redirect may get duplicates. Deduplicate by chunkId on client side (already done).

### Testing

- Unit test: `ChannelHandler` with mock federation — verify gossip on subscribe/unsubscribe
- E2E test: Two VPS servers, owner on A, subscriber on B — verify chunk delivery
- Existing E2E (Android emulator + headless) validates single-server channels still work
