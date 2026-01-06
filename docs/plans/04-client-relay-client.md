# Client Implementation Plan: Relay Client

## Overview
Implement the relay client that:
1. Connects to relay peers via WebRTC
2. Acts as a relay for other peers (introduction forwarding)
3. Manages relay connections and load reporting
4. Handles introduction requests and responses

## Architecture

```
RelayClient
├── Connection Management
│   ├── connectToRelays(relayList) → void
│   ├── ensureConnectedToRelay(relayId) → void
│   └── disconnectRelay(relayId) → void
├── Introduction Protocol
│   ├── sendIntroduction(relayId, targetSourceId, payload) → void
│   └── handleIntroductionRequest(from, request) → void
├── Load Management
│   ├── reportLoad() → void
│   └── updateLocalLoad(count) → void
├── Properties
│   ├── mySourceId → String
│   ├── listenPort → int
│   └── getConnectedRelayIds() → List<String>
└── Event Streams
    ├── onIntroduction → Stream<IntroductionEvent>
    └── onRelayStateChange → Stream<RelayStateEvent>
```

## TDD Test Cases

### 1. Connection Management Tests

```dart
// test/core/network/relay_client_test.dart

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/network/relay_client.dart';
import 'package:zajel/core/network/webrtc_service.dart';

class MockWebRTCService extends Mock implements WebRTCService {}
class MockSignalingClient extends Mock implements SignalingClient {}

void main() {
  group('RelayClient', () {
    late RelayClient client;
    late MockWebRTCService mockWebRTC;
    late MockSignalingClient mockSignaling;

    setUp(() {
      mockWebRTC = MockWebRTCService();
      mockSignaling = MockSignalingClient();

      client = RelayClient(
        webrtcService: mockWebRTC,
        signalingClient: mockSignaling,
        maxRelayConnections: 10,
      );
    });

    group('connectToRelays', () {
      test('should connect to all provided relays', () async {
        // Arrange
        final relays = [
          RelayInfo(peerId: 'relay1', publicKey: 'pk1'),
          RelayInfo(peerId: 'relay2', publicKey: 'pk2'),
          RelayInfo(peerId: 'relay3', publicKey: 'pk3'),
        ];

        when(() => mockWebRTC.createConnection(any())).thenAnswer((_) async => MockRTCConnection());

        // Act
        await client.connectToRelays(relays);

        // Assert
        verify(() => mockWebRTC.createConnection(any())).called(3);
        expect(client.getConnectedRelayIds(), containsAll(['relay1', 'relay2', 'relay3']));
      });

      test('should respect maxRelayConnections limit', () async {
        // Arrange
        final relays = List.generate(15, (i) => RelayInfo(peerId: 'relay$i', publicKey: 'pk$i'));
        when(() => mockWebRTC.createConnection(any())).thenAnswer((_) async => MockRTCConnection());

        // Act
        await client.connectToRelays(relays);

        // Assert
        expect(client.getConnectedRelayIds().length, 10); // maxRelayConnections
      });

      test('should skip already connected relays', () async {
        // Arrange
        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');
        when(() => mockWebRTC.createConnection(any())).thenAnswer((_) async => MockRTCConnection());

        await client.connectToRelays([relay]);

        // Act - try to connect again
        await client.connectToRelays([relay]);

        // Assert - should only connect once
        verify(() => mockWebRTC.createConnection('relay1')).called(1);
      });

      test('should handle connection failures gracefully', () async {
        // Arrange
        final relays = [
          RelayInfo(peerId: 'relay1', publicKey: 'pk1'),
          RelayInfo(peerId: 'relay2', publicKey: 'pk2'),
        ];

        when(() => mockWebRTC.createConnection('relay1')).thenThrow(Exception('Connection failed'));
        when(() => mockWebRTC.createConnection('relay2')).thenAnswer((_) async => MockRTCConnection());

        // Act
        await client.connectToRelays(relays);

        // Assert - should connect to relay2 despite relay1 failure
        expect(client.getConnectedRelayIds(), contains('relay2'));
        expect(client.getConnectedRelayIds(), isNot(contains('relay1')));
      });
    });

    group('ensureConnectedToRelay', () {
      test('should connect if not already connected', () async {
        // Arrange
        when(() => mockWebRTC.createConnection(any())).thenAnswer((_) async => MockRTCConnection());
        when(() => mockSignaling.getRelayInfo('relay1')).thenAnswer((_) async =>
          RelayInfo(peerId: 'relay1', publicKey: 'pk1'));

        // Act
        await client.ensureConnectedToRelay('relay1');

        // Assert
        verify(() => mockWebRTC.createConnection('relay1')).called(1);
      });

      test('should not reconnect if already connected', () async {
        // Arrange
        when(() => mockWebRTC.createConnection(any())).thenAnswer((_) async => MockRTCConnection());

        // Connect first
        await client.connectToRelays([RelayInfo(peerId: 'relay1', publicKey: 'pk1')]);

        // Act
        await client.ensureConnectedToRelay('relay1');

        // Assert - only called once (initial connect)
        verify(() => mockWebRTC.createConnection('relay1')).called(1);
      });
    });

    group('disconnectRelay', () {
      test('should close connection and remove from list', () async {
        // Arrange
        final mockConnection = MockRTCConnection();
        when(() => mockWebRTC.createConnection(any())).thenAnswer((_) async => mockConnection);
        when(() => mockConnection.close()).thenAnswer((_) async {});

        await client.connectToRelays([RelayInfo(peerId: 'relay1', publicKey: 'pk1')]);

        // Act
        await client.disconnectRelay('relay1');

        // Assert
        verify(() => mockConnection.close()).called(1);
        expect(client.getConnectedRelayIds(), isNot(contains('relay1')));
      });
    });
  });
}
```

### 2. Introduction Protocol Tests

```dart
// test/core/network/relay_client_introduction_test.dart

void main() {
  group('RelayClient Introduction Protocol', () {
    // ... setup ...

    group('sendIntroduction', () {
      test('should send introduction request to relay', () async {
        // Arrange
        await client.connectToRelays([RelayInfo(peerId: 'relay1', publicKey: 'pk1')]);

        // Act
        await client.sendIntroduction(
          relayId: 'relay1',
          targetSourceId: 'target_source_123',
          encryptedPayload: 'encrypted_connection_info',
        );

        // Assert
        verify(() => mockWebRTC.sendData('relay1', any())).called(1);

        // Verify message format
        final captured = verify(() => mockWebRTC.sendData('relay1', captureAny())).captured.single;
        final msg = jsonDecode(captured);
        expect(msg['type'], 'introduction_request');
        expect(msg['targetSourceId'], 'target_source_123');
        expect(msg['payload'], 'encrypted_connection_info');
        expect(msg['fromSourceId'], client.mySourceId);
      });

      test('should throw if not connected to relay', () async {
        // Act & Assert
        expect(
          () => client.sendIntroduction(
            relayId: 'unknown_relay',
            targetSourceId: 'target',
            encryptedPayload: 'payload',
          ),
          throwsA(isA<RelayNotConnectedException>()),
        );
      });
    });

    group('handleIntroductionRequest (as relay)', () {
      test('should forward to connected target', () async {
        // Arrange - connect two peers to us (we're the relay)
        await client.connectToRelays([
          RelayInfo(peerId: 'alice', publicKey: 'pk_alice'),
          RelayInfo(peerId: 'bob', publicKey: 'pk_bob'),
        ]);

        // Register alice's source ID
        client.registerSourceId('alice', 'alice_source_123');

        // Act - bob sends introduction for alice
        final request = IntroductionRequest(
          fromSourceId: 'bob_source_456',
          targetSourceId: 'alice_source_123',
          payload: 'encrypted_for_alice',
        );

        await client.handleIntroductionRequest('bob', request);

        // Assert - should forward to alice
        verify(() => mockWebRTC.sendData('alice', any())).called(1);
      });

      test('should respond with error if target not found', () async {
        // Arrange
        await client.connectToRelays([RelayInfo(peerId: 'bob', publicKey: 'pk_bob')]);

        // Act
        final request = IntroductionRequest(
          fromSourceId: 'bob_source_456',
          targetSourceId: 'unknown_source',
          payload: 'encrypted',
        );

        await client.handleIntroductionRequest('bob', request);

        // Assert - should send error back to bob
        final captured = verify(() => mockWebRTC.sendData('bob', captureAny())).captured.single;
        final msg = jsonDecode(captured);
        expect(msg['type'], 'introduction_error');
        expect(msg['error'], 'target_not_found');
      });
    });

    group('handleIntroductionResponse', () {
      test('should emit event when receiving introduction', () async {
        // Arrange
        final events = <IntroductionEvent>[];
        client.onIntroduction.listen(events.add);

        // Act - receive introduction from relay
        final response = IntroductionResponse(
          fromSourceId: 'alice_source_123',
          payload: 'encrypted_alice_info',
        );

        await client.handleIntroductionResponse('relay1', response);

        // Assert
        expect(events, hasLength(1));
        expect(events[0].fromSourceId, 'alice_source_123');
        expect(events[0].payload, 'encrypted_alice_info');
      });
    });
  });
}
```

### 3. Load Management Tests

```dart
// test/core/network/relay_client_load_test.dart

void main() {
  group('RelayClient Load Management', () {
    // ... setup ...

    group('reportLoad', () {
      test('should report current connection count to server', () async {
        // Arrange
        await client.connectToRelays([
          RelayInfo(peerId: 'relay1', publicKey: 'pk1'),
          RelayInfo(peerId: 'relay2', publicKey: 'pk2'),
        ]);

        // Simulate some peers connected to us (we're relaying for them)
        client.updateLocalLoad(5);

        // Act
        await client.reportLoad();

        // Assert
        verify(() => mockSignaling.send(any())).called(1);

        final captured = verify(() => mockSignaling.send(captureAny())).captured.single;
        expect(captured['type'], 'update_load');
        expect(captured['connectedCount'], 5);
      });
    });

    group('updateLocalLoad', () {
      test('should track peers using us as relay', () async {
        // Act
        client.updateLocalLoad(3);

        // Assert
        expect(client.currentLoad, 3);
      });

      test('should auto-report when load changes significantly', () async {
        // Arrange
        client.autoReportThreshold = 5;

        // Act - small change
        client.updateLocalLoad(2);

        // Assert - no auto-report
        verifyNever(() => mockSignaling.send(any()));

        // Act - larger change
        client.updateLocalLoad(10);

        // Assert - should auto-report
        verify(() => mockSignaling.send(any())).called(1);
      });
    });

    group('periodic load reporting', () {
      test('should report load periodically', () async {
        // Arrange
        fakeAsync((async) {
          client.startPeriodicLoadReporting(interval: Duration(seconds: 30));

          // Act - advance time
          async.elapse(Duration(minutes: 2));

          // Assert - should report 4 times (every 30 seconds for 2 minutes)
          verify(() => mockSignaling.send(any())).called(4);
        });
      });
    });
  });
}
```

### 4. Source ID Management Tests

```dart
// test/core/network/relay_client_source_id_test.dart

void main() {
  group('RelayClient Source ID Management', () {
    // ... setup ...

    test('should generate unique source ID on initialization', () {
      // Assert
      expect(client.mySourceId, isNotEmpty);
      expect(client.mySourceId.length, greaterThan(10));
    });

    test('should maintain consistent source ID across sessions', () {
      // Arrange
      final sourceId1 = client.mySourceId;

      // Act - create new client (simulating app restart with saved state)
      final client2 = RelayClient(
        webrtcService: mockWebRTC,
        signalingClient: mockSignaling,
        savedSourceId: sourceId1,
      );

      // Assert
      expect(client2.mySourceId, sourceId1);
    });

    test('should register peer source IDs when they connect', () async {
      // Arrange
      await client.connectToRelays([RelayInfo(peerId: 'peer1', publicKey: 'pk1')]);

      // Act - peer sends their source ID
      client.handlePeerHandshake('peer1', {'sourceId': 'peer1_source_xyz'});

      // Assert
      expect(client.getSourceId('peer1'), 'peer1_source_xyz');
      expect(client.getPeerIdBySourceId('peer1_source_xyz'), 'peer1');
    });
  });
}
```

## Implementation

```dart
// lib/core/network/relay_client.dart

import 'dart:async';
import 'dart:convert';
import 'package:uuid/uuid.dart';
import 'package:zajel/core/network/webrtc_service.dart';
import 'package:zajel/core/network/signaling_client.dart';

/// Client for managing relay connections and introduction protocol.
class RelayClient {
  final WebRTCService _webrtcService;
  final SignalingClient _signalingClient;
  final int maxRelayConnections;

  final Map<String, RelayConnection> _relayConnections = {};
  final Map<String, String> _sourceIdToPeerId = {};
  final Map<String, String> _peerIdToSourceId = {};

  late final String mySourceId;
  int _currentLoad = 0;
  int autoReportThreshold = 5;
  Timer? _loadReportTimer;

  final _introductionController = StreamController<IntroductionEvent>.broadcast();
  final _stateController = StreamController<RelayStateEvent>.broadcast();

  Stream<IntroductionEvent> get onIntroduction => _introductionController.stream;
  Stream<RelayStateEvent> get onRelayStateChange => _stateController.stream;

  int get currentLoad => _currentLoad;
  int get listenPort => 0; // From WebRTC service

  RelayClient({
    required WebRTCService webrtcService,
    required SignalingClient signalingClient,
    this.maxRelayConnections = 10,
    String? savedSourceId,
  })  : _webrtcService = webrtcService,
        _signalingClient = signalingClient {
    mySourceId = savedSourceId ?? _generateSourceId();
    _setupMessageHandling();
  }

  /// Connect to a list of relay peers.
  Future<void> connectToRelays(List<RelayInfo> relays) async {
    final toConnect = relays
        .where((r) => !_relayConnections.containsKey(r.peerId))
        .take(maxRelayConnections - _relayConnections.length)
        .toList();

    for (final relay in toConnect) {
      try {
        await _connectToRelay(relay);
      } catch (e) {
        print('Failed to connect to relay ${relay.peerId}: $e');
      }
    }
  }

  /// Ensure connection to a specific relay.
  Future<void> ensureConnectedToRelay(String relayId) async {
    if (_relayConnections.containsKey(relayId)) {
      return;
    }

    final relayInfo = await _signalingClient.getRelayInfo(relayId);
    if (relayInfo != null) {
      await _connectToRelay(relayInfo);
    }
  }

  /// Disconnect from a relay.
  Future<void> disconnectRelay(String relayId) async {
    final connection = _relayConnections.remove(relayId);
    if (connection != null) {
      await connection.close();
      _sourceIdToPeerId.removeWhere((k, v) => v == relayId);
      _peerIdToSourceId.remove(relayId);

      _stateController.add(RelayStateEvent(
        relayId: relayId,
        state: RelayConnectionState.disconnected,
      ));
    }
  }

  /// Get list of connected relay IDs.
  List<String> getConnectedRelayIds() {
    return _relayConnections.keys.toList();
  }

  /// Get a random connected relay ID.
  String? getCurrentRelayId() {
    if (_relayConnections.isEmpty) return null;
    final ids = getConnectedRelayIds();
    return ids[DateTime.now().millisecondsSinceEpoch % ids.length];
  }

  /// Send an introduction request through a relay.
  Future<void> sendIntroduction({
    required String relayId,
    required String targetSourceId,
    required String encryptedPayload,
  }) async {
    final connection = _relayConnections[relayId];
    if (connection == null) {
      throw RelayNotConnectedException(relayId);
    }

    final message = jsonEncode({
      'type': 'introduction_request',
      'fromSourceId': mySourceId,
      'targetSourceId': targetSourceId,
      'payload': encryptedPayload,
    });

    await _webrtcService.sendData(relayId, message);
  }

  /// Handle an introduction request (when we're the relay).
  Future<void> handleIntroductionRequest(String fromPeerId, IntroductionRequest request) async {
    // Find the target peer
    final targetPeerId = _sourceIdToPeerId[request.targetSourceId];

    if (targetPeerId == null || !_relayConnections.containsKey(targetPeerId)) {
      // Target not connected to us
      await _sendIntroductionError(fromPeerId, 'target_not_found');
      return;
    }

    // Forward the introduction to the target
    final forwardMessage = jsonEncode({
      'type': 'introduction_forward',
      'fromSourceId': request.fromSourceId,
      'payload': request.payload,
    });

    await _webrtcService.sendData(targetPeerId, forwardMessage);
  }

  /// Handle an introduction response/forward.
  Future<void> handleIntroductionResponse(String fromRelayId, IntroductionResponse response) async {
    _introductionController.add(IntroductionEvent(
      fromSourceId: response.fromSourceId,
      payload: response.payload,
      relayId: fromRelayId,
    ));
  }

  /// Register a peer's source ID.
  void registerSourceId(String peerId, String sourceId) {
    _sourceIdToPeerId[sourceId] = peerId;
    _peerIdToSourceId[peerId] = sourceId;
  }

  /// Get source ID for a peer.
  String? getSourceId(String peerId) => _peerIdToSourceId[peerId];

  /// Get peer ID by source ID.
  String? getPeerIdBySourceId(String sourceId) => _sourceIdToPeerId[sourceId];

  /// Update local load (peers using us as relay).
  void updateLocalLoad(int count) {
    final previousLoad = _currentLoad;
    _currentLoad = count;

    // Auto-report if change is significant
    if ((count - previousLoad).abs() >= autoReportThreshold) {
      reportLoad();
    }
  }

  /// Report current load to server.
  Future<void> reportLoad() async {
    await _signalingClient.send({
      'type': 'update_load',
      'peerId': mySourceId,
      'connectedCount': _currentLoad,
    });
  }

  /// Start periodic load reporting.
  void startPeriodicLoadReporting({Duration interval = const Duration(seconds: 30)}) {
    _loadReportTimer?.cancel();
    _loadReportTimer = Timer.periodic(interval, (_) => reportLoad());
  }

  /// Handle peer handshake (receive their source ID).
  void handlePeerHandshake(String peerId, Map<String, dynamic> handshake) {
    final sourceId = handshake['sourceId'] as String?;
    if (sourceId != null) {
      registerSourceId(peerId, sourceId);
    }
  }

  Future<void> _connectToRelay(RelayInfo relay) async {
    final connection = await _webrtcService.createConnection(relay.peerId);

    _relayConnections[relay.peerId] = RelayConnection(
      peerId: relay.peerId,
      publicKey: relay.publicKey,
      connection: connection,
      connectedAt: DateTime.now(),
    );

    // Send our handshake with source ID
    await _webrtcService.sendData(relay.peerId, jsonEncode({
      'type': 'relay_handshake',
      'sourceId': mySourceId,
    }));

    _stateController.add(RelayStateEvent(
      relayId: relay.peerId,
      state: RelayConnectionState.connected,
    ));
  }

  void _setupMessageHandling() {
    _webrtcService.onDataReceived.listen((event) {
      _handleRelayMessage(event.peerId, event.data);
    });
  }

  void _handleRelayMessage(String peerId, String data) {
    final msg = jsonDecode(data) as Map<String, dynamic>;
    final type = msg['type'] as String;

    switch (type) {
      case 'relay_handshake':
        handlePeerHandshake(peerId, msg);
        break;
      case 'introduction_request':
        handleIntroductionRequest(peerId, IntroductionRequest.fromJson(msg));
        break;
      case 'introduction_forward':
        handleIntroductionResponse(peerId, IntroductionResponse.fromJson(msg));
        break;
      case 'introduction_error':
        // Handle error
        break;
    }
  }

  Future<void> _sendIntroductionError(String peerId, String error) async {
    await _webrtcService.sendData(peerId, jsonEncode({
      'type': 'introduction_error',
      'error': error,
    }));
  }

  String _generateSourceId() {
    return const Uuid().v4().replaceAll('-', '').substring(0, 16);
  }

  void dispose() {
    _loadReportTimer?.cancel();
    _introductionController.close();
    _stateController.close();

    for (final connection in _relayConnections.values) {
      connection.close();
    }
    _relayConnections.clear();
  }
}

// Data classes
class RelayInfo {
  final String peerId;
  final String publicKey;
  final double? capacity;

  RelayInfo({required this.peerId, required this.publicKey, this.capacity});
}

class RelayConnection {
  final String peerId;
  final String publicKey;
  final dynamic connection;
  final DateTime connectedAt;

  RelayConnection({
    required this.peerId,
    required this.publicKey,
    required this.connection,
    required this.connectedAt,
  });

  Future<void> close() async {
    // Close WebRTC connection
  }
}

class IntroductionRequest {
  final String fromSourceId;
  final String targetSourceId;
  final String payload;

  IntroductionRequest({
    required this.fromSourceId,
    required this.targetSourceId,
    required this.payload,
  });

  factory IntroductionRequest.fromJson(Map<String, dynamic> json) {
    return IntroductionRequest(
      fromSourceId: json['fromSourceId'],
      targetSourceId: json['targetSourceId'],
      payload: json['payload'],
    );
  }
}

class IntroductionResponse {
  final String fromSourceId;
  final String payload;

  IntroductionResponse({required this.fromSourceId, required this.payload});

  factory IntroductionResponse.fromJson(Map<String, dynamic> json) {
    return IntroductionResponse(
      fromSourceId: json['fromSourceId'],
      payload: json['payload'],
    );
  }
}

class IntroductionEvent {
  final String fromSourceId;
  final String payload;
  final String relayId;

  IntroductionEvent({
    required this.fromSourceId,
    required this.payload,
    required this.relayId,
  });
}

class RelayStateEvent {
  final String relayId;
  final RelayConnectionState state;

  RelayStateEvent({required this.relayId, required this.state});
}

enum RelayConnectionState { connecting, connected, disconnected, failed }

class RelayNotConnectedException implements Exception {
  final String relayId;
  RelayNotConnectedException(this.relayId);
  @override
  String toString() => 'Not connected to relay: $relayId';
}
```

## File Structure

```
packages/app/lib/core/network/
├── relay_client.dart           # Main implementation
├── relay_models.dart           # Data classes
└── relay_exceptions.dart       # Exceptions

packages/app/test/core/network/
├── relay_client_test.dart
├── relay_client_introduction_test.dart
├── relay_client_load_test.dart
└── relay_client_source_id_test.dart
```
