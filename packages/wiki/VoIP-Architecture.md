# VoIP Architecture

Zajel supports voice and video calls using WebRTC media streams. Calls are established over the signaling server and then transition to direct peer-to-peer media transport.

---

## Call Setup Sequence

```mermaid
sequenceDiagram
    participant Alice as Alice (Caller)
    participant Server as Signaling Server
    participant Bob as Bob (Callee)

    Alice->>Alice: Request local media<br/>(audio always, video optional)
    Alice->>Alice: Create RTCPeerConnection<br/>(Google STUN servers)
    Alice->>Alice: Add local audio/video tracks
    Alice->>Alice: Create SDP offer
    Alice->>Server: call_offer(peerId: Bob, sdp, withVideo)
    Note over Alice: Start 60s ringing timeout

    Server->>Bob: call_offer from Alice

    Note over Bob: Show incoming call dialog

    alt Bob accepts
        Bob->>Bob: Request local media
        Bob->>Bob: Create RTCPeerConnection
        Bob->>Bob: Set remote description (Alice's offer)
        Bob->>Bob: Add local audio/video tracks
        Bob->>Bob: Create SDP answer
        Bob->>Server: call_answer(peerId: Alice, sdp)
        Server->>Alice: call_answer from Bob

        Alice->>Alice: Set remote description (Bob's answer)

        Note over Alice,Bob: ICE candidate exchange

        Alice->>Server: ice_candidate
        Server->>Bob: ice_candidate
        Bob->>Server: ice_candidate
        Server->>Alice: ice_candidate

        Note over Alice,Bob: Media streams flow directly P2P
        Note over Alice: Cancel ringing timeout
    else Bob declines
        Bob->>Server: call_reject(reason: "declined")
        Server->>Alice: call_reject
        Note over Alice: Cancel ringing timeout<br/>Show "Call declined"
    else Timeout (60s)
        Note over Alice: Auto-hangup
        Alice->>Server: call_reject(reason: "timeout")
        Server->>Bob: call_reject
    end
```

---

## Call States

```mermaid
stateDiagram-v2
    [*] --> Idle

    Idle --> Outgoing: startCall()
    Idle --> Incoming: Receive call_offer

    Outgoing --> Connecting: Peer answers
    Outgoing --> Ended: Timeout (60s) /<br/>Peer rejects

    Incoming --> Connecting: acceptCall()
    Incoming --> Ended: rejectCall()

    Connecting --> Connected: ICE connected<br/>Media flowing
    Connecting --> Ended: ICE failed /<br/>Timeout (10s)

    Connected --> Ended: hangUp() /<br/>Peer hangs up /<br/>ICE disconnect (10s)

    Ended --> Idle: Cleanup complete
```

### State Descriptions

| State | Description |
|-------|-------------|
| **Idle** | No call in progress |
| **Outgoing** | SDP offer sent, waiting for answer. 60s ringing timeout. |
| **Incoming** | SDP offer received, showing incoming call dialog |
| **Connecting** | SDP answer exchanged, ICE negotiation in progress |
| **Connected** | Media streams flowing. Call duration timer running. |
| **Ended** | Call terminated. Resources being cleaned up. |

---

## Media Service

### Audio Processing

The media service provides configurable audio processing:

| Feature | Description | Default |
|---------|-------------|---------|
| Noise suppression | Reduce background noise | Enabled |
| Echo cancellation | Prevent echo feedback | Enabled |
| Auto gain control | Normalize volume levels | Enabled |

Audio constraints are applied via `getUserMedia`:
```
audio: {
  noiseSuppression: true/false,
  echoCancellation: true/false,
  autoGainControl: true/false
}
```

### Video Configuration

| Parameter | Value |
|-----------|-------|
| Resolution | 720p ideal |
| Frame rate | 30fps |
| Mirror mode | Enabled for local preview (front camera) |
| Camera switch | Front/back toggle on mobile |

### Device Management

The media service enumerates available devices:
- Audio input devices (microphones)
- Audio output devices (speakers/headphones)
- Video input devices (cameras)

Users can select specific devices from the in-call settings sheet.

### Background Blur

Video calls support background blur for privacy:
- Configurable blur strength (0.0 to 1.0)
- Can be enabled/disabled during a call
- Processed on-device before sending

---

## ICE Candidate Handling

ICE (Interactive Connectivity Establishment) candidates are used for NAT traversal:

1. **STUN servers**: Google's public STUN servers (`stun.l.google.com:19302`, `stun1.l.google.com:19302`)
2. **Candidate queuing**: If ICE candidates arrive before the remote description is set, they are queued (max 100 candidates)
3. **Queue flush**: Once the remote description is set, all queued candidates are added
4. **Reconnection**: If ICE disconnects during a call, the system waits 10 seconds for reconnection before ending the call

---

## Timeout Configuration

| Timeout | Duration | Purpose |
|---------|----------|---------|
| Ringing | 60 seconds | Auto-hangup if callee does not answer |
| ICE reconnection | 10 seconds | Grace period for ICE recovery |
| ICE gathering | 30 seconds | Maximum time for ICE candidate gathering |
| Cleanup delay | 500 milliseconds | Allow final packets before resource cleanup |
| Max pending ICE | 100 candidates | Prevent memory exhaustion from ICE floods |

---

## Android Foreground Service

On Android, active calls run as a foreground service with a persistent notification. This prevents the OS from killing the app while a call is in progress. The foreground service is started when a call connects and stopped when it ends. On other platforms, this is a no-op.

---

## Resource Cleanup

When a call ends, the following resources are cleaned up:

1. Ringing timeout timer cancelled
2. Reconnection timeout timer cancelled
3. RTCPeerConnection closed
4. Local media tracks stopped
5. Pending ICE candidate queue cleared
6. Call state reset to Idle
7. Android foreground notification removed

---

## Signaling Messages

| Message | Direction | Fields |
|---------|-----------|--------|
| `call_offer` | Caller -> Server -> Callee | peerId, sdp, withVideo |
| `call_answer` | Callee -> Server -> Caller | peerId, sdp |
| `call_reject` | Either -> Server -> Other | peerId, reason (busy/declined/timeout) |
| `call_hangup` | Either -> Server -> Other | peerId |
| `ice_candidate` | Either -> Server -> Other | peerId, candidate (JSON) |
