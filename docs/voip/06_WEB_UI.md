# Task 06: Web Call UI

## Status: NOT STARTED
## Depends On: 05_WEB_VOIP

## Owner Files (Only edit these)
- `packages/web-client/src/components/CallView.tsx` (create new)
- `packages/web-client/src/components/IncomingCallOverlay.tsx` (create new)
- `packages/web-client/src/components/ChatView.tsx` (modify - add call buttons)

## Task Description
Create the call UI components and integrate with chat view.

## Requirements

### 1. Create `IncomingCallOverlay.tsx`

Overlay shown when receiving a call:

```typescript
interface IncomingCallOverlayProps {
  callerName: string;
  callId: string;
  withVideo: boolean;
  onAccept: (withVideo: boolean) => void;
  onReject: () => void;
}

export function IncomingCallOverlay({
  callerName,
  callId,
  withVideo,
  onAccept,
  onReject,
}: IncomingCallOverlayProps) {
  // Render:
  // - Caller name/avatar
  // - "Incoming call" / "Incoming video call"
  // - Accept button (green)
  // - Accept with video button (if audio call, option to upgrade)
  // - Reject button (red)
}
```

**Design:**
- Centered modal overlay
- Dark semi-transparent background
- Caller avatar (large, centered)
- Caller name below avatar
- "Incoming call" or "Incoming video call" text
- Two buttons: Accept (green phone icon), Reject (red phone icon)

### 2. Create `CallView.tsx`

Full-screen call interface:

```typescript
interface CallViewProps {
  voipService: VoIPService;
  peerName: string;
  onClose: () => void;
}

export function CallView({ voipService, peerName, onClose }: CallViewProps) {
  const [state, setState] = useState<CallState>('connecting');
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOn, setIsVideoOn] = useState(true);

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  // Subscribe to voipService events
  // Update local/remote video srcObject
  // Timer for call duration

  // Render:
  // - Remote video (full screen background)
  // - Local video (small corner preview)
  // - Peer name
  // - Call duration (when connected)
  // - Control bar: mute, video, hangup
}
```

**Layout:**
```
┌─────────────────────────────────┐
│                                 │
│     Remote Video (fullscreen)   │
│                                 │
│  ┌──────┐                       │
│  │Local │     Peer Name         │
│  │Video │     00:00             │
│  └──────┘                       │
│                                 │
│     [Mute] [Video] [Hangup]     │
└─────────────────────────────────┘
```

**States to handle:**
- `outgoing`: "Calling..." with ringing animation
- `incoming`: Should show IncomingCallOverlay instead
- `connecting`: "Connecting..."
- `connected`: Show videos, duration timer
- `ended`: Brief "Call ended" then close

### 3. Modify ChatView.tsx

Add call buttons to chat header:

```typescript
// In chat header, add:
<button onClick={() => startCall(false)} title="Voice call">
  <PhoneIcon />
</button>
<button onClick={() => startCall(true)} title="Video call">
  <VideoIcon />
</button>
```

**Integration:**
- Import VoIPService
- Show IncomingCallOverlay when call:offer received
- Show CallView when in active call
- Handle call state changes

### 4. Styling

- Use existing design system/CSS patterns
- Smooth transitions between states
- Responsive (works on mobile web)
- Control buttons should be large enough for touch

## Acceptance Criteria
- [ ] IncomingCallOverlay shows for incoming calls
- [ ] CallView displays during active calls
- [ ] Local video preview works
- [ ] Remote video displays
- [ ] Mute button toggles audio
- [ ] Video button toggles camera
- [ ] Hangup ends call
- [ ] Duration timer counts up
- [ ] Call buttons in ChatView
- [ ] Proper state transitions
- [ ] Clean UI/UX

## Notes
- Focus on functionality first, polish later
- Test with actual WebRTC (camera/mic)
- Handle case where peer has no video (show avatar)
