# Task 05: Web VoIP Service

## Status: NOT STARTED
## Depends On: 03_WEB_MEDIA, 04_WEB_SIGNALING

## Owner Files (Only edit these)
- `packages/web-client/src/lib/voip.ts` (create new)

## Task Description
Create the VoIPService that orchestrates calls using MediaService and SignalingService.

## Requirements

### 1. Create `voip.ts`

```typescript
import { MediaService } from './media';
import { SignalingService } from './signaling';
import { CALL } from './constants';

export type CallState = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'ended';

export interface CallInfo {
  callId: string;
  peerId: string;
  withVideo: boolean;
  state: CallState;
  startTime?: number;
  remoteStream?: MediaStream;
}

export interface VoIPEvents {
  'state-change': (state: CallState, call: CallInfo | null) => void;
  'remote-stream': (stream: MediaStream) => void;
  'error': (error: Error) => void;
}

export class VoIPService {
  private peerConnection: RTCPeerConnection | null = null;
  private currentCall: CallInfo | null = null;
  private ringingTimeout: number | null = null;

  constructor(
    private mediaService: MediaService,
    private signaling: SignalingService,
  ) {
    this.setupSignalingHandlers();
  }

  /**
   * Start an outgoing call
   */
  async startCall(peerId: string, withVideo: boolean): Promise<string>;

  /**
   * Accept an incoming call
   */
  async acceptCall(callId: string, withVideo: boolean): Promise<void>;

  /**
   * Reject an incoming call
   */
  rejectCall(callId: string, reason?: 'busy' | 'declined'): void;

  /**
   * End the current call
   */
  hangup(): void;

  /**
   * Toggle mute (delegates to MediaService)
   */
  toggleMute(): boolean;

  /**
   * Toggle video (delegates to MediaService)
   */
  toggleVideo(): boolean;

  /**
   * Get current call info
   */
  getCurrentCall(): CallInfo | null;

  /**
   * Subscribe to events
   */
  on<K extends keyof VoIPEvents>(event: K, handler: VoIPEvents[K]): void;
}
```

### 2. Implementation Details

**startCall:**
1. Generate UUID for callId
2. Set state to 'outgoing'
3. Request media via MediaService
4. Create RTCPeerConnection
5. Add local tracks to connection
6. Create and set local description (offer)
7. Send offer via SignalingService
8. Start ringing timeout
9. Return callId

**acceptCall:**
1. Set state to 'connecting'
2. Request media via MediaService
3. Create RTCPeerConnection
4. Add local tracks
5. Set remote description (the offer)
6. Create and set local description (answer)
7. Send answer via SignalingService

**RTCPeerConnection setup:**
```typescript
private createPeerConnection(): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  });

  pc.onicecandidate = (event) => {
    if (event.candidate && this.currentCall) {
      this.signaling.sendCallIce(
        this.currentCall.callId,
        this.currentCall.peerId,
        event.candidate,
      );
    }
  };

  pc.ontrack = (event) => {
    this.currentCall!.remoteStream = event.streams[0];
    this.emit('remote-stream', event.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      this.setState('connected');
      this.currentCall!.startTime = Date.now();
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      this.hangup();
    }
  };

  return pc;
}
```

**Signaling handlers:**
```typescript
private setupSignalingHandlers(): void {
  this.signaling.on('call:offer', this.handleOffer.bind(this));
  this.signaling.on('call:answer', this.handleAnswer.bind(this));
  this.signaling.on('call:reject', this.handleReject.bind(this));
  this.signaling.on('call:hangup', this.handleHangup.bind(this));
  this.signaling.on('call:ice', this.handleIce.bind(this));
}
```

### 3. Cleanup

**hangup:**
1. Clear ringing timeout
2. Stop all media tracks
3. Close peer connection
4. Send hangup message
5. Reset state to 'idle'

## Acceptance Criteria
- [ ] VoIPService class created
- [ ] Can initiate outgoing calls
- [ ] Can receive and accept incoming calls
- [ ] Can reject calls
- [ ] Can hangup calls
- [ ] ICE candidates exchanged properly
- [ ] Remote stream events emitted
- [ ] Proper cleanup on call end
- [ ] Ringing timeout works
- [ ] Unit tests

## Notes
- This is the main orchestration service
- UI (Task 06) will use this service
- Keep state management clean and predictable
