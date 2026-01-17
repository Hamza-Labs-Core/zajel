# Task 03: Web Media Service

## Status: NOT STARTED
## Depends On: Nothing (can start immediately)

## Owner Files (Only edit these)
- `packages/web-client/src/lib/media.ts` (create new)

## Task Description
Create a MediaService class to manage camera and microphone access.

## Requirements

### 1. Create `media.ts`

```typescript
export interface MediaState {
  hasAudio: boolean;
  hasVideo: boolean;
  audioMuted: boolean;
  videoMuted: boolean;
}

export class MediaService {
  private localStream: MediaStream | null = null;
  private audioMuted = false;
  private videoMuted = false;

  /**
   * Request media access from user
   * @param video - true for video call, false for audio only
   * @returns MediaStream with requested tracks
   */
  async requestMedia(video: boolean): Promise<MediaStream>;

  /**
   * Toggle audio mute state
   * @returns new muted state
   */
  toggleMute(): boolean;

  /**
   * Toggle video on/off
   * @returns new video state (true = video on)
   */
  toggleVideo(): boolean;

  /**
   * Switch between front/back camera (mobile)
   */
  async switchCamera(): Promise<void>;

  /**
   * Stop all media tracks and release resources
   */
  stopAllTracks(): void;

  /**
   * Get current media state
   */
  getState(): MediaState;

  /**
   * Get the local MediaStream (for display in UI)
   */
  getLocalStream(): MediaStream | null;
}
```

### 2. Implementation Details

**requestMedia:**
```typescript
const constraints: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
  },
  video: video ? {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    facingMode: 'user',
  } : false,
};
this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
```

**toggleMute:**
```typescript
this.audioMuted = !this.audioMuted;
this.localStream?.getAudioTracks().forEach(track => {
  track.enabled = !this.audioMuted;
});
return this.audioMuted;
```

**switchCamera:**
- Get current video track
- Stop it
- Request new stream with opposite facingMode
- Replace track in stream

### 3. Error Handling

- Throw clear errors for permission denied
- Handle device not found
- Handle browser not supporting getUserMedia

## Acceptance Criteria
- [ ] MediaService class created
- [ ] All methods implemented
- [ ] Proper cleanup in stopAllTracks
- [ ] Error handling for common cases
- [ ] Unit tests (mock navigator.mediaDevices)

## Notes
- This service is independent of signaling
- Can be tested in isolation
- Used by VoIPService (Task 05)
