# Task 08: Flutter Call Signaling

## Status: NOT STARTED
## Depends On: 01_PROTOCOL

## Owner Files (Only edit these)
- `packages/app/lib/core/network/signaling_client.dart`

## Task Description
Add call signaling methods to the existing Flutter SignalingClient.

## Requirements

### 1. Add Call Message Classes

```dart
// Add to existing message classes or create call_messages.dart

class CallOfferMessage {
  final String callId;
  final String targetId;
  final String sdp;
  final bool withVideo;

  CallOfferMessage({
    required this.callId,
    required this.targetId,
    required this.sdp,
    required this.withVideo,
  });

  Map<String, dynamic> toJson() => {
    'type': 'call_offer',
    'callId': callId,
    'targetId': targetId,
    'sdp': sdp,
    'withVideo': withVideo,
  };

  factory CallOfferMessage.fromJson(Map<String, dynamic> json) => CallOfferMessage(
    callId: json['callId'],
    targetId: json['targetId'],
    sdp: json['sdp'],
    withVideo: json['withVideo'],
  );
}

class CallAnswerMessage {
  final String callId;
  final String targetId;
  final String sdp;

  // ... similar pattern
}

class CallRejectMessage {
  final String callId;
  final String targetId;
  final String? reason; // 'busy' | 'declined' | 'timeout'

  // ... similar pattern
}

class CallHangupMessage {
  final String callId;
  final String targetId;

  // ... similar pattern
}

class CallIceMessage {
  final String callId;
  final String targetId;
  final String candidate; // JSON stringified RTCIceCandidate

  // ... similar pattern
}
```

### 2. Add Send Methods to SignalingClient

```dart
// Add to existing SignalingClient class:

void sendCallOffer(String callId, String targetId, String sdp, bool withVideo) {
  send(CallOfferMessage(
    callId: callId,
    targetId: targetId,
    sdp: sdp,
    withVideo: withVideo,
  ).toJson());
}

void sendCallAnswer(String callId, String targetId, String sdp) {
  send(CallAnswerMessage(
    callId: callId,
    targetId: targetId,
    sdp: sdp,
  ).toJson());
}

void sendCallReject(String callId, String targetId, {String? reason}) {
  send(CallRejectMessage(
    callId: callId,
    targetId: targetId,
    reason: reason,
  ).toJson());
}

void sendCallHangup(String callId, String targetId) {
  send(CallHangupMessage(
    callId: callId,
    targetId: targetId,
  ).toJson());
}

void sendCallIce(String callId, String targetId, RTCIceCandidate candidate) {
  send(CallIceMessage(
    callId: callId,
    targetId: targetId,
    candidate: jsonEncode(candidate.toMap()),
  ).toJson());
}
```

### 3. Add Event Streams

```dart
// Add streams for incoming call messages:

final _callOfferController = StreamController<CallOfferMessage>.broadcast();
final _callAnswerController = StreamController<CallAnswerMessage>.broadcast();
final _callRejectController = StreamController<CallRejectMessage>.broadcast();
final _callHangupController = StreamController<CallHangupMessage>.broadcast();
final _callIceController = StreamController<CallIceMessage>.broadcast();

Stream<CallOfferMessage> get onCallOffer => _callOfferController.stream;
Stream<CallAnswerMessage> get onCallAnswer => _callAnswerController.stream;
Stream<CallRejectMessage> get onCallReject => _callRejectController.stream;
Stream<CallHangupMessage> get onCallHangup => _callHangupController.stream;
Stream<CallIceMessage> get onCallIce => _callIceController.stream;
```

### 4. Handle Incoming Messages

```dart
// In the message handler:

void _handleMessage(Map<String, dynamic> json) {
  switch (json['type']) {
    // ... existing cases

    case 'call_offer':
      _callOfferController.add(CallOfferMessage.fromJson(json));
      break;
    case 'call_answer':
      _callAnswerController.add(CallAnswerMessage.fromJson(json));
      break;
    case 'call_reject':
      _callRejectController.add(CallRejectMessage.fromJson(json));
      break;
    case 'call_hangup':
      _callHangupController.add(CallHangupMessage.fromJson(json));
      break;
    case 'call_ice':
      _callIceController.add(CallIceMessage.fromJson(json));
      break;
  }
}
```

### 5. Cleanup

Dispose stream controllers in the dispose method.

## Acceptance Criteria
- [ ] All 5 message classes created
- [ ] All 5 send methods added
- [ ] All 5 event streams added
- [ ] Message handling added
- [ ] Stream controllers properly disposed
- [ ] Existing functionality unchanged
- [ ] Tests for new methods

## Notes
- Follow existing patterns in signaling_client.dart
- Keep consistent with web protocol types
- VoIPService (Task 09) will use these
