# [MEDIUM] Single global Durable Object instance is a single point of failure

**Area**: Server
**File**: packages/server/src/index.js:89,119,126
**Type**: Best Practice

**Description**: All three Durable Object types use a single "global" instance:
```js
const id = env.SERVER_REGISTRY.idFromName('global');
const id = env.ATTESTATION_REGISTRY.idFromName('global');
```
This means all server registrations, all attestation operations, and all relay/rendezvous operations are serialized through a single Durable Object instance per type.

Cloudflare Durable Objects process requests sequentially within a single instance. All concurrent requests are queued.

**Impact**:
- **Scalability bottleneck**: Under load, all requests queue behind each other. A slow storage operation blocks all concurrent requests.
- **Single point of failure**: If the global DO instance crashes (e.g., due to memory exhaustion from the unbounded storage issues), the entire service is down.
- **Geographic latency**: The DO runs in a single location. Clients far from that location experience higher latency.
- **Blast radius**: Any bug or attack against one client affects all clients through the shared instance.

**Fix**:
1. For `ServerRegistryDO` and `AttestationRegistryDO`, sharding by region or first character of the ID could distribute load.
2. For `RelayRegistryDO`, consider sharding by geographic region or peer ID prefix.
3. Use the global instance as a coordination point but distribute work to per-shard instances.
