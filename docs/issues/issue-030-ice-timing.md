# Issue #30: ICE Candidate Timing

## Summary

ICE candidates may be added before `setRemoteDescription()` is called, causing errors. The current implementation has a race condition where ICE candidates can arrive and be applied before the remote description has been set.

## File Analyzed

- `/home/meywd/zajel/packages/web-client/src/lib/webrtc.ts`

## Current Flow Analysis

### 1. Connection Initiation Flow

**Initiator (creates offer):**
```
1. onPairMatched -> webrtc.connect(peerCode, isInitiator=true)
2. RTCPeerConnection created
3. createOffer() -> setLocalDescription(offer)
4. sendOffer() to peer
5. ICE gathering starts, candidates sent as discovered
6. Wait for answer from peer
7. handleAnswer() -> setRemoteDescription(answer)
```

**Responder (creates answer):**
```
1. onPairMatched -> webrtc.connect(peerCode, isInitiator=false)
2. RTCPeerConnection created
3. Wait for offer
4. handleOffer() -> setRemoteDescription(offer), createAnswer(), setLocalDescription(answer)
5. sendAnswer() to initiator
6. ICE gathering starts, candidates sent as discovered
```

### 2. ICE Candidate Handling (Lines 109-125)

```typescript
async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
  if (!this.pc) {
    // Queue candidate if connection not ready, but limit queue size
    if (this.pendingCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
      console.warn('ICE candidate queue full, dropping oldest candidate');
      this.pendingCandidates.shift();
    }
    this.pendingCandidates.push(candidate);
    return;
  }

  try {
    await this.pc.addIceCandidate(candidate);
  } catch (e) {
    console.warn('Failed to add ICE candidate:', e);
  }
}
```

### 3. Pending Candidates Processing (Lines 88-92)

```typescript
// Add any pending ICE candidates
for (const candidate of this.pendingCandidates) {
  await this.pc.addIceCandidate(candidate);
}
this.pendingCandidates = [];
```

## Identified Issues

### Issue 1: Missing Remote Description Check

The `handleIceCandidate()` method checks if `this.pc` exists but does NOT check if `remoteDescription` has been set:

```typescript
if (!this.pc) {
  // Queue if no connection
}
// BUG: Proceeds to add candidate even without remote description
await this.pc.addIceCandidate(candidate);
```

**Problem**: When `this.pc` exists but `this.pc.remoteDescription` is null, calling `addIceCandidate()` will fail with:
- "Failed to execute 'addIceCandidate' on 'RTCPeerConnection': Error processing ICE candidate"

### Issue 2: Race Condition in connect()

In the `connect()` method, pending candidates are processed at the end:

```typescript
async connect(peerCode: string, isInitiator: boolean): Promise<void> {
  // ...creates RTCPeerConnection...

  if (isInitiator) {
    // Creates offer, sets local description, sends offer
    // NOTE: remote description NOT set yet
  }

  // BUG: Processes pending candidates here
  for (const candidate of this.pendingCandidates) {
    await this.pc.addIceCandidate(candidate);  // Will fail - no remote description
  }
}
```

For the **initiator**, remote description is only set later when `handleAnswer()` is called. This means:
1. `connect()` is called with `isInitiator=true`
2. Offer is created and sent
3. Pending candidates are processed (FAILS - no remote description)
4. Later, `handleAnswer()` sets remote description

### Issue 3: Timing Window

There's a timing window where:
1. Peer connection is created (`this.pc` exists)
2. ICE candidates arrive from peer
3. `handleIceCandidate()` tries to add them immediately
4. But `setRemoteDescription()` hasn't been called yet

**Scenario for Initiator**:
```
Time 0: connect() called, RTCPeerConnection created
Time 1: createOffer(), setLocalDescription()
Time 2: sendOffer() to peer
Time 3: ICE candidate arrives from peer (fast network)
Time 4: handleIceCandidate() called - this.pc exists
Time 5: addIceCandidate() FAILS - no remoteDescription
Time 6: handleAnswer() finally called
```

**Scenario for Responder**:
```
Time 0: connect() called, RTCPeerConnection created
Time 1: pending candidates processed - FAILS if any queued
Time 2: handleOffer() called later
Time 3: setRemoteDescription(offer) - now candidates would work
```

## Proposed Fix

### Solution: Check for Remote Description Before Adding ICE Candidates

Modify `handleIceCandidate()` to queue candidates when remote description is not set:

```typescript
async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
  // Queue if connection not ready OR remote description not set
  if (!this.pc || !this.pc.remoteDescription) {
    if (this.pendingCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
      console.warn('ICE candidate queue full, dropping oldest candidate');
      this.pendingCandidates.shift();
    }
    this.pendingCandidates.push(candidate);
    return;
  }

  try {
    await this.pc.addIceCandidate(candidate);
  } catch (e) {
    console.warn('Failed to add ICE candidate:', e);
  }
}
```

### Solution: Process Pending Candidates After Remote Description is Set

Move pending candidate processing to `handleOffer()` and `handleAnswer()`:

```typescript
async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
  if (!this.pc) return;

  await this.pc.setRemoteDescription(offer);

  // Now process pending candidates
  await this.processPendingCandidates();

  const answer = await this.pc.createAnswer();
  await this.pc.setLocalDescription(answer);
  this.signaling.sendAnswer(this.peerCode, answer);
}

async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
  if (!this.pc) return;
  await this.pc.setRemoteDescription(answer);

  // Now process pending candidates
  await this.processPendingCandidates();
}

private async processPendingCandidates(): Promise<void> {
  for (const candidate of this.pendingCandidates) {
    try {
      await this.pc?.addIceCandidate(candidate);
    } catch (e) {
      console.warn('Failed to add pending ICE candidate:', e);
    }
  }
  this.pendingCandidates = [];
}
```

### Solution: Remove Premature Processing in connect()

Remove the candidate processing from `connect()` since it runs before remote description is available:

```typescript
async connect(peerCode: string, isInitiator: boolean): Promise<void> {
  this.peerCode = peerCode;
  this.close();

  this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // ... event handlers ...

  if (isInitiator) {
    // Create data channels and offer
    // ...
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.sendOffer(peerCode, offer);
  }

  // REMOVED: Pending candidate processing
  // Candidates will be processed when setRemoteDescription is called
}
```

## Complete Fixed Code

```typescript
async connect(peerCode: string, isInitiator: boolean): Promise<void> {
  this.peerCode = peerCode;
  this.close();

  this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // ICE candidate handling
  this.pc.onicecandidate = (event) => {
    if (event.candidate) {
      this.signaling.sendIceCandidate(this.peerCode, event.candidate.toJSON());
    }
  };

  // Connection state
  this.pc.onconnectionstatechange = () => {
    if (this.pc) {
      this.events.onStateChange(this.pc.connectionState);
    }
  };

  // Data channel handling for responder
  this.pc.ondatachannel = (event) => {
    const channel = event.channel;
    if (channel.label === MESSAGE_CHANNEL) {
      this.messageChannel = channel;
      this.setupMessageChannel(channel);
    } else if (channel.label === FILE_CHANNEL) {
      this.fileChannel = channel;
      this.setupFileChannel(channel);
    }
  };

  if (isInitiator) {
    // Create data channels as initiator
    this.messageChannel = this.pc.createDataChannel(MESSAGE_CHANNEL, {
      ordered: true,
    });
    this.setupMessageChannel(this.messageChannel);

    this.fileChannel = this.pc.createDataChannel(FILE_CHANNEL, {
      ordered: true,
    });
    this.setupFileChannel(this.fileChannel);

    // Create and send offer
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.sendOffer(peerCode, offer);
  }

  // NOTE: Pending candidates NOT processed here
  // They will be processed when remote description is set
}

async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
  if (!this.pc) return;

  await this.pc.setRemoteDescription(offer);

  // Process any pending ICE candidates now that remote description is set
  await this.processPendingCandidates();

  const answer = await this.pc.createAnswer();
  await this.pc.setLocalDescription(answer);
  this.signaling.sendAnswer(this.peerCode, answer);
}

async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
  if (!this.pc) return;
  await this.pc.setRemoteDescription(answer);

  // Process any pending ICE candidates now that remote description is set
  await this.processPendingCandidates();
}

async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
  // Queue candidate if connection not ready OR remote description not set
  if (!this.pc || !this.pc.remoteDescription) {
    if (this.pendingCandidates.length >= MAX_PENDING_ICE_CANDIDATES) {
      console.warn('ICE candidate queue full, dropping oldest candidate');
      this.pendingCandidates.shift();
    }
    this.pendingCandidates.push(candidate);
    return;
  }

  try {
    await this.pc.addIceCandidate(candidate);
  } catch (e) {
    console.warn('Failed to add ICE candidate:', e);
  }
}

private async processPendingCandidates(): Promise<void> {
  for (const candidate of this.pendingCandidates) {
    try {
      await this.pc?.addIceCandidate(candidate);
    } catch (e) {
      console.warn('Failed to add pending ICE candidate:', e);
    }
  }
  this.pendingCandidates = [];
}
```

## Correct ICE Candidate Flow After Fix

### Initiator Flow (Fixed)
```
1. connect(peerCode, true) - creates RTCPeerConnection
2. createOffer() -> setLocalDescription(offer)
3. sendOffer()
4. ICE candidates arrive -> queued (no remoteDescription)
5. handleAnswer(answer) -> setRemoteDescription(answer)
6. processPendingCandidates() -> addIceCandidate() succeeds
```

### Responder Flow (Fixed)
```
1. connect(peerCode, false) - creates RTCPeerConnection
2. handleOffer(offer) -> setRemoteDescription(offer)
3. processPendingCandidates() -> empties queue
4. createAnswer() -> setLocalDescription(answer)
5. sendAnswer()
6. Future ICE candidates -> addIceCandidate() succeeds immediately
```

## Risk Assessment

| Severity | Impact | Likelihood |
|----------|--------|------------|
| Medium   | Connection failures on fast networks | Medium |

**Symptoms**:
- Console warnings: "Failed to add ICE candidate"
- Connections may take longer or fail on fast networks
- More likely to occur with low-latency connections where candidates arrive quickly

## Testing Recommendations

1. Test with simulated network latency (Chrome DevTools Network throttling)
2. Test rapid reconnection scenarios
3. Add logging to track candidate queuing and processing
4. Monitor for "Failed to add ICE candidate" errors in production

## References

- [WebRTC: addIceCandidate](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/addIceCandidate)
- [WebRTC Perfect Negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
- [ICE Candidate Trickling](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)

## Research: How Other Apps Solve This

### 1. WebRTC Standard: Proper ICE Candidate Handling Order

#### RFC 8838 - Trickle ICE Specification

The [RFC 8838 Trickle ICE specification](https://www.rfc-editor.org/rfc/rfc8838) defines the standard for incremental candidate provisioning:

**Key Requirements:**
1. **Ordering**: Each candidate must be delivered exactly once and in the same order it was conveyed
2. **State Management**: Checklists must remain in Running state during active gathering
3. **End-of-Candidates**: After conveying end-of-candidates, no new candidates may be trickled in that session
4. **Generation Tracking**: Candidates must be correlated to a specific ICE session via ufrag to handle ICE restarts

**When Candidates Can Be Added:**
- Candidates can be exchanged incrementally as soon as they become available
- A Trickle ICE agent MUST NOT pair a local candidate until it has been trickled to the remote party

#### W3C WebRTC Specification Requirement

The [W3C WebRTC spec](https://w3c.github.io/webrtc-pc/) requires that `addIceCandidate()` throws an `InvalidStateError` when called without a remote description. From [GitHub issue #2519](https://github.com/w3c/webrtc-pc/issues/2519):

- Calling `addIceCandidate()` before `setRemoteDescription()` fails in ~0.197% of calls (most common failure reason)
- The spec maintainers consider queuing ICE candidates an "anti-pattern" because it obscures signaling protocol violations
- Despite developer experience concerns, the strict requirement was maintained

#### The `canTrickleIceCandidates` Property

Per [MDN documentation](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/canTrickleIceCandidates):
- This property is only set **after** calling `setRemoteDescription()`
- If the remote peer doesn't support trickle ICE, you must wait for `iceGatheringState` to become "completed" before sending the offer

---

### 2. Signal (RingRTC) Implementation

Signal's [RingRTC](https://github.com/signalapp/ringrtc) is their middleware library for video/voice calling built on top of WebRTC.

**Key Implementation Details:**

1. **Custom WebRTC Fork**: Signal maintains a [custom WebRTC fork](https://github.com/signalapp/webrtc) with:
   - ICE forking support
   - Custom Rust FFI for RingRTC
   - Security patches and feature modifications

2. **SFU Architecture**: For group calls, Signal wrote a custom SFU in Rust that implements:
   - ICE, SRTP, transport-cc, and googcc protocols
   - Scales to 40+ participants
   - End-to-end encryption in RingRTC layer

3. **Trickle ICE Support**: JSEP (JavaScript Session Establishment Protocol) in RingRTC:
   - Allows incremental candidate provisioning after initial offer
   - Callee can begin acting on the call without waiting for all candidates
   - Reduces connection establishment latency significantly

---

### 3. Kurento Media Server ICE Handling

[Kurento documentation](https://doc-kurento.readthedocs.io/en/latest/user/troubleshooting.html) provides detailed ICE handling guidance:

**Trickle ICE Process:**

```javascript
// 1. Subscribe to candidate events BEFORE gathering
webRtcEndpoint.on('IceCandidateFound', (event) => {
  // Send candidate to remote peer
});

// 2. Start gathering
webRtcEndpoint.gatherCandidates();

// 3. Wait for IceGatheringDone if using full ICE (non-trickle)
```

**Key Events:**
- `IceCandidateFound`: Emitted for each discovered candidate
- `IceGatheringDone`: All candidates gathered (for full ICE mode)
- `IceComponentStateChange`: Network connection state changes
- `NewCandidatePairSelected`: New candidate pair selected (can change during session)

**Full ICE vs Trickle ICE:**
- For traditional (non-trickle) ICE: call `gatherCandidates()`, then wait for `IceGatheringDone` before handling SDP
- SDPs are typically sent without ICE candidates initially, following Trickle ICE optimization

**ICE-TCP Configuration:**
- Kurento allows enabling/disabling ICE-TCP via configuration
- Disabling TCP (when UDP is guaranteed) provides faster session establishment

---

### 4. Jitsi (lib-jitsi-meet) ICE Candidate Management

From [lib-jitsi-meet GitHub issues](https://github.com/jitsi/lib-jitsi-meet/issues/476):

**Edge Browser Special Handling:**
```javascript
// Edge doesn't support Trickle ICE
// Must signal empty candidate {} to start ICE procedures
// After empty candidate, addRemoteCandidate() calls are ignored

// Solution in JingleSessionPC.js:
if (isEdge) {
  peerconnection.addIceCandidate({});  // Signals end of candidates
}
```

**P2P vs Server Considerations:**
- Server mode: All candidates exist in initial SDP
- P2P mode: Remote candidates arrive at any time, requiring careful handling

**Configuration Options:**
- `webrtcIceTcpDisable`: Filter out TCP candidates
- `webrtcIceUdpDisable`: Filter out UDP candidates
- `iceTransportPolicy`: Control ICE transport ("all" or "relay")

---

### 5. libwebrtc / Browser Reference Implementation

#### Internal Queue Behavior

Per [MDN Perfect Negotiation docs](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation):

> RTCPeerConnection implements a queue internally, where only one of these asynchronous operations may run at the same time. This will put any addIceCandidate calls third in line, by which time things will be in the expected "have-remote-offer" state.

**Pending Descriptions:**
- `pendingLocalDescription`: Contains offer/answer under consideration + local ICE candidates gathered since creation
- `pendingRemoteDescription`: Contains remote ICE candidates provided via `addIceCandidate()`

#### Perfect Negotiation Pattern

The [Perfect Negotiation pattern](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation) solves race conditions:

```javascript
let makingOffer = false;
let ignoreOffer = false;

pc.onicecandidate = ({ candidate }) => signaler.send({ candidate });

signaler.onmessage = async ({ data: { description, candidate } }) => {
  try {
    if (description) {
      const readyForOffer = !makingOffer &&
        (pc.signalingState === "stable" || isSettingRemoteAnswerPending);
      const offerCollision = description.type === "offer" && !readyForOffer;

      ignoreOffer = !polite && offerCollision;
      if (ignoreOffer) return;

      await pc.setRemoteDescription(description);
      if (description.type === "offer") {
        await pc.setLocalDescription();
        signaler.send({ description: pc.localDescription });
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!ignoreOffer) throw err;  // Suppress errors for ignored offers
      }
    }
  } catch (err) {
    console.error(err);
  }
};
```

**Key Mechanisms:**
- **Polite/Impolite Peers**: Asymmetric roles for deterministic collision handling
- **`makingOffer` Flag**: Prevents signaling state races (state changes asynchronously)
- **`ignoreOffer` Flag**: Suppresses ICE candidate errors for rejected offers

---

### 6. Common Library Patterns

#### simple-peer Library

From [GetStream ICE Candidate Tutorial](https://getstream.io/resources/projects/webrtc/basics/ice-candidates/):

```javascript
// simple-peer caches candidates until remote description is set
// See: https://github.com/feross/simple-peer/blob/master/index.js#L198

class SimplePeer {
  _pendingCandidates = [];

  addIceCandidate(candidate) {
    if (!this._pc.remoteDescription) {
      this._pendingCandidates.push(candidate);
      return;
    }
    this._pc.addIceCandidate(candidate);
  }

  // Called after setRemoteDescription
  _drainPendingCandidates() {
    for (const candidate of this._pendingCandidates) {
      this._pc.addIceCandidate(candidate);
    }
    this._pendingCandidates = [];
  }
}
```

#### Pion WebRTC (Go)

From [Pion discussions](https://github.com/pion/webrtc/discussions/2653):

**Recommended Pattern:**
1. Queue incoming ICE candidates in a slice
2. Only add candidates after `SetRemoteDescription()` completes
3. Use ufrag to correlate candidates to correct ICE generation

---

### 7. mediasoup SFU Approach

From [mediasoup forums](https://mediasoup.discourse.group/t/trickle-ice-and-or-waitng-for-ice-candidates/4204):

**Different Model:**
- mediasoup client library doesn't use trickle ICE
- No calls to `addIceCandidate()` in the client
- Server's public address is sufficient for ICE negotiation
- Browser typically sees successful candidate as "prflx" (peer reflexive)

**Why This Works:**
- SFU has known, stable transport addresses
- Candidates are included in initial SDP offer/answer
- No need for incremental candidate exchange with server

---

### 8. LiveKit Implementation

From [LiveKit documentation](https://docs.livekit.io/reference/internals/client-protocol/):

**Dual PeerConnection Model:**
- Subscriber PeerConnection: Always open upon connection
- Publisher PeerConnection: Established only when publishing

**ICE Handling:**
- Server initiates subscriber PeerConnection with offer
- Client and server exchange ICE candidates via trickle
- Recommends trickle over waiting for gathering complete (faster startup)

---

### 9. ICE Restart Handling

#### Ufrag-Based Generation Tracking

From [MDN RTCIceCandidate.usernameFragment](https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidate/usernameFragment):

```javascript
// Each ICE generation has unique ufrag
// Use ufrag to match candidates to correct generation

// During ICE restart:
// - currentLocalDescription has ufrag "foo"
// - pendingLocalDescription has ufrag "bar"

// Candidates with ufrag "foo" -> add to currentLocalDescription
// Candidates with ufrag "bar" -> add to pendingLocalDescription
```

**Best Practices:**
- Trigger ICE restart 3-4 seconds after connection state becomes "disconnected" (don't wait 30s for "failed")
- Use `createOffer({ iceRestart: true })` to generate new ufrag/password
- Filter obsolete candidates by checking ufrag

---

### 10. Race Condition Prevention Summary

| Pattern | Mechanism | Used By |
|---------|-----------|---------|
| **Candidate Queue** | Buffer candidates until remoteDescription set | simple-peer, Pion, Kurento-utils |
| **Perfect Negotiation** | Polite/impolite peers, makingOffer flag | MDN reference, modern browsers |
| **Dual Description** | Separate pending/current descriptions | libwebrtc internal |
| **Ufrag Matching** | Correlate candidates to ICE generation | All implementations |
| **ignoreOffer Flag** | Suppress errors for rejected collision offers | Perfect Negotiation |
| **Event-Based Gathering** | Subscribe to events before gatherCandidates() | Kurento, mediasoup |

---

### 11. Recommendations for Zajel

Based on this research, the proposed fix in this issue aligns with industry best practices:

1. **Queue candidates when `remoteDescription` is null** - Used by simple-peer, Pion, and many production implementations

2. **Process queue after `setRemoteDescription()`** - Move candidate processing to `handleOffer()` and `handleAnswer()`

3. **Consider Perfect Negotiation** for future improvements:
   - Add polite/impolite peer roles
   - Use `makingOffer` flag to detect races
   - Suppress candidate errors for ignored offers

4. **ICE Restart Awareness**:
   - Consider tracking ufrag to handle restarts properly
   - Filter candidates from old ICE generations

5. **Logging**: Add debug logging for:
   - Candidates queued vs immediately added
   - Queue drain events
   - Failed candidate additions with context

---

### References

- [RFC 8838: Trickle ICE](https://www.rfc-editor.org/rfc/rfc8838)
- [MDN: Perfect Negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
- [MDN: canTrickleIceCandidates](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/canTrickleIceCandidates)
- [W3C WebRTC Spec Issue #2519](https://github.com/w3c/webrtc-pc/issues/2519)
- [Pion WebRTC Discussion #2653](https://github.com/pion/webrtc/discussions/2653)
- [Signal RingRTC](https://github.com/signalapp/ringrtc)
- [Kurento Troubleshooting](https://doc-kurento.readthedocs.io/en/latest/user/troubleshooting.html)
- [lib-jitsi-meet Issue #476](https://github.com/jitsi/lib-jitsi-meet/issues/476)
- [LiveKit Client Protocol](https://docs.livekit.io/reference/internals/client-protocol/)
- [GetStream ICE Candidate Tutorial](https://getstream.io/resources/projects/webrtc/basics/ice-candidates/)
