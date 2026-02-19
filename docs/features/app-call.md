# App - Call (VoIP) Features

## Call UI Screen
### Main Call Screen
- **Location**: `packages/app/lib/features/call/call_screen.dart:L10-338`
- **Description**: Full-screen call interface displaying remote video or avatar placeholder, local preview, call state, and controls

### Remote Video Display
- **Location**: `packages/app/lib/features/call/call_screen.dart:L146-154`
- **Description**: Displays remote peer video or avatar placeholder when video unavailable

### Local Video Preview
- **Location**: `packages/app/lib/features/call/call_screen.dart:L156-177`
- **Description**: Corner preview of local camera (mirror mode, rounded corners)

### Call State Status Overlay
- **Location**: `packages/app/lib/features/call/call_screen.dart:L179-257`
- **Description**: Shows call status (Calling, Connecting, Connected with duration, Ended)

### Call Duration Timer
- **Location**: `packages/app/lib/features/call/call_screen.dart:L116-135`
- **Description**: Tracks and formats call duration (MM:SS or H:MM:SS format)

### Call Control Buttons
- **Location**: `packages/app/lib/features/call/call_screen.dart:L260-310`
- **Description**: Mute, Video toggle, Camera switch, Device settings, Hangup

### In-Call Device Settings Sheet
- **Location**: `packages/app/lib/features/call/call_screen.dart:L379-572`
- **Description**: Draggable bottom sheet for device/audio processing configuration

## Incoming Call Dialog
### Incoming Call UI
- **Location**: `packages/app/lib/features/call/incoming_call_dialog.dart:L3-127`
- **Description**: Dialog shown when receiving incoming call with caller info and accept/reject options

### Caller Avatar Display
- **Location**: `packages/app/lib/features/call/incoming_call_dialog.dart:L52-63`
- **Description**: Shows avatar with NetworkImage or initial fallback

### Caller Information
- **Location**: `packages/app/lib/features/call/incoming_call_dialog.dart:L64-79`
- **Description**: Displays caller name and call type (audio/video)

### Call Action Buttons
- **Location**: `packages/app/lib/features/call/incoming_call_dialog.dart:L82-116`
- **Description**: Accept (audio), Accept with Video, Decline buttons

## VoIP Service (Core)
### Call State Management
- **Location**: `packages/app/lib/core/network/voip_service.dart:L14-32`
- **Description**: Enum with states: idle, outgoing, incoming, connecting, connected, ended

### Call Info Model
- **Location**: `packages/app/lib/core/network/voip_service.dart:L34-75`
- **Description**: Tracks call ID, peer ID, video flag, state, start time, remote stream; provides duration calculation

### Outgoing Call Initiation
- **Location**: `packages/app/lib/core/network/voip_service.dart:L191-236`
- **Description**: Start call with peer ID and video flag, creates peer connection, adds local tracks, creates and sends SDP offer with 60s ringing timeout

### Incoming Call Handling
- **Location**: `packages/app/lib/core/network/voip_service.dart:L473-510`
- **Description**: Receives call offer, validates peer connection state, creates peer connection, sets remote description, processes pending ICE candidates

### Call Answer
- **Location**: `packages/app/lib/core/network/voip_service.dart:L244-282`
- **Description**: Accepts incoming call with optional video, requests local media, adds tracks to peer connection, creates and sends SDP answer

### Call Rejection
- **Location**: `packages/app/lib/core/network/voip_service.dart:L284-304`
- **Description**: Sends call reject with optional reason ('busy', 'declined', 'timeout')

### Call Hangup
- **Location**: `packages/app/lib/core/network/voip_service.dart:L306-317`
- **Description**: Ends active call and notifies peer

### Media Controls
- **Location**: `packages/app/lib/core/network/voip_service.dart:L319-371`
- **Description**: Toggle audio mute, toggle video on/off, switch between cameras; validates controls only during active call states

### Peer Connection Management
- **Location**: `packages/app/lib/core/network/voip_service.dart:L373-461`
- **Description**: Creates RTCPeerConnection with ICE servers (Google STUN), handles ICE candidates with queueing, monitors connection state, implements 10s reconnection timeout

### ICE Candidate Handling
- **Location**: `packages/app/lib/core/network/voip_service.dart:L559-596`
- **Description**: Decodes JSON ICE candidate from signaling message, queues candidates if remote description not set (max 100), adds candidates once ready

### Resource Cleanup
- **Location**: `packages/app/lib/core/network/voip_service.dart:L627-667`
- **Description**: Cancels timers, closes peer connection, stops media tracks, clears pending ICE candidates

## Media Service (Core)
### Media Access Control
- **Location**: `packages/app/lib/core/media/media_service.dart:L192-262`
- **Description**: Requests user media (audio always, video optional) with configurable audio constraints and video constraints (720p ideal, 30fps)

### Audio Processing
- **Location**: `packages/app/lib/core/media/media_service.dart:L136-175`
- **Description**: Noise suppression, echo cancellation, and automatic gain control configuration

### Device Management
- **Location**: `packages/app/lib/core/media/media_service.dart:L442-510`
- **Description**: Enumerate all media devices, get available audio inputs/outputs, get available video inputs, select specific device

### Camera Switching
- **Location**: `packages/app/lib/core/media/media_service.dart:L311-328`
- **Description**: Front/back camera switching support on mobile platforms

### Background Blur Processing
- **Location**: `packages/app/lib/core/media/background_blur_processor.dart:L5-60`
- **Description**: Manages background blur settings for video calls with enable/disable and strength control (0.0-1.0)

## Call Signaling
### Call Signaling Messages
- **Location**: `packages/app/lib/core/network/signaling_client.dart:L416-480`
- **Description**: Send call offer, answer, reject, hangup, and ICE candidates via signaling server

## Call Foreground Service
### Android Foreground Notification
- **Location**: `packages/app/lib/core/notifications/call_foreground_service.dart:L7-61`
- **Description**: Android foreground service notification for active calls, no-op on other platforms

## Call Constants
### Timeout Configuration
- **Location**: `packages/app/lib/core/constants.dart:L95-114`
- **Description**: Ringing timeout (60s), reconnection timeout (10s), ICE gathering timeout (30s), max pending ICE candidates (100), default STUN servers
