# Client Implementation Plan: Rendezvous Service

## Overview
Implement the rendezvous service that:
1. Registers meeting points with the signaling server
2. Handles dead drop creation and retrieval
3. Manages live matching notifications
4. Coordinates reconnection to trusted peers

## Architecture

```
RendezvousService
├── Dependencies
│   ├── MeetingPointService
│   ├── CryptoService
│   ├── TrustedPeersStorage
│   └── SignalingServerConnection
├── Public API
│   ├── registerForPeer(peerId) → RendezvousResult
│   ├── registerForAllPeers() → Map<String, RendezvousResult>
│   └── handleMatch(match) → void
├── Dead Drop Management
│   ├── createDeadDrop(peerId) → EncryptedPayload
│   └── decryptDeadDrop(drop, peerId) → ConnectionInfo
└── Event Streams
    ├── onPeerFound → Stream<PeerFoundEvent>
    └── onDeadDropReceived → Stream<DeadDropEvent>
```

## TDD Test Cases

### 1. Registration Tests

```dart
// test/core/network/rendezvous_service_test.dart

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/network/rendezvous_service.dart';
import 'package:zajel/core/network/meeting_point_service.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';
import 'package:zajel/core/network/signaling_client.dart';

class MockMeetingPointService extends Mock implements MeetingPointService {}
class MockCryptoService extends Mock implements CryptoService {}
class MockTrustedPeersStorage extends Mock implements TrustedPeersStorage {}
class MockSignalingClient extends Mock implements SignalingClient {}

void main() {
  group('RendezvousService', () {
    late RendezvousService service;
    late MockMeetingPointService mockMeetingPoint;
    late MockCryptoService mockCrypto;
    late MockTrustedPeersStorage mockTrustedPeers;
    late MockSignalingClient mockSignaling;

    setUp(() {
      mockMeetingPoint = MockMeetingPointService();
      mockCrypto = MockCryptoService();
      mockTrustedPeers = MockTrustedPeersStorage();
      mockSignaling = MockSignalingClient();

      service = RendezvousService(
        meetingPointService: mockMeetingPoint,
        cryptoService: mockCrypto,
        trustedPeersStorage: mockTrustedPeers,
        signalingClient: mockSignaling,
      );
    });

    group('registerForPeer', () {
      test('should derive meeting points and register with server', () async {
        // Arrange
        final myPubkey = Uint8List.fromList(List.generate(32, (i) => i));
        final theirPubkey = Uint8List.fromList(List.generate(32, (i) => i + 100));
        final sharedSecret = Uint8List.fromList(List.generate(32, (i) => i * 2));

        when(() => mockCrypto.getPublicKeyBytes()).thenAnswer((_) async => myPubkey);
        when(() => mockTrustedPeers.getPublicKeyBytes('peer1')).thenAnswer((_) async => theirPubkey);
        when(() => mockCrypto.getSessionKeyBytes('peer1')).thenAnswer((_) async => sharedSecret);
        when(() => mockMeetingPoint.deriveDailyPoints(any(), any())).thenReturn(['day_1', 'day_2', 'day_3']);
        when(() => mockMeetingPoint.deriveHourlyTokens(any())).thenReturn(['hr_1', 'hr_2', 'hr_3']);
        when(() => mockCrypto.encryptForPeer(any(), any())).thenAnswer((_) async => 'encrypted_drop');
        when(() => mockSignaling.registerRendezvous(any())).thenAnswer((_) async => RendezvousResult(
          liveMatches: [],
          deadDrops: [],
        ));

        // Act
        final result = await service.registerForPeer('peer1');

        // Assert
        verify(() => mockSignaling.registerRendezvous(any())).called(1);
        expect(result, isA<RendezvousResult>());
      });

      test('should include dead drop in registration', () async {
        // Arrange
        setupMocks();
        RendezvousRegistration? capturedRegistration;
        when(() => mockSignaling.registerRendezvous(any())).thenAnswer((invocation) async {
          capturedRegistration = invocation.positionalArguments[0];
          return RendezvousResult(liveMatches: [], deadDrops: []);
        });

        // Act
        await service.registerForPeer('peer1');

        // Assert
        expect(capturedRegistration?.deadDrop, isNotNull);
        expect(capturedRegistration?.dailyPoints, hasLength(3));
        expect(capturedRegistration?.hourlyTokens, hasLength(3));
      });

      test('should handle peer not found error', () async {
        // Arrange
        when(() => mockCrypto.getPublicKeyBytes()).thenAnswer((_) async => Uint8List(32));
        when(() => mockTrustedPeers.getPublicKeyBytes('unknown')).thenAnswer((_) async => null);

        // Act & Assert
        expect(
          () => service.registerForPeer('unknown'),
          throwsA(isA<PeerNotFoundException>()),
        );
      });

      test('should work without shared secret (daily points only)', () async {
        // Arrange
        when(() => mockCrypto.getPublicKeyBytes()).thenAnswer((_) async => Uint8List(32));
        when(() => mockTrustedPeers.getPublicKeyBytes('peer1')).thenAnswer((_) async => Uint8List(32));
        when(() => mockCrypto.getSessionKeyBytes('peer1')).thenAnswer((_) async => null);
        when(() => mockMeetingPoint.deriveDailyPoints(any(), any())).thenReturn(['day_1', 'day_2', 'day_3']);
        when(() => mockCrypto.encryptForPeer(any(), any())).thenAnswer((_) async => 'encrypted');
        when(() => mockSignaling.registerRendezvous(any())).thenAnswer((_) async =>
          RendezvousResult(liveMatches: [], deadDrops: []));

        // Act
        final result = await service.registerForPeer('peer1');

        // Assert
        verify(() => mockMeetingPoint.deriveDailyPoints(any(), any())).called(1);
        verifyNever(() => mockMeetingPoint.deriveHourlyTokens(any()));
      });
    });

    group('registerForAllPeers', () {
      test('should register for all trusted peers', () async {
        // Arrange
        when(() => mockTrustedPeers.getAllPeerIds()).thenAnswer((_) async => ['peer1', 'peer2', 'peer3']);
        setupMocksForPeer('peer1');
        setupMocksForPeer('peer2');
        setupMocksForPeer('peer3');

        // Act
        final results = await service.registerForAllPeers();

        // Assert
        expect(results.keys, containsAll(['peer1', 'peer2', 'peer3']));
        verify(() => mockSignaling.registerRendezvous(any())).called(3);
      });

      test('should continue with other peers if one fails', () async {
        // Arrange
        when(() => mockTrustedPeers.getAllPeerIds()).thenAnswer((_) async => ['peer1', 'peer2']);
        setupMocksForPeer('peer1');
        when(() => mockTrustedPeers.getPublicKeyBytes('peer2')).thenAnswer((_) async => null);

        // Act
        final results = await service.registerForAllPeers();

        // Assert
        expect(results.containsKey('peer1'), true);
        expect(results.containsKey('peer2'), false);
      });
    });
  });
}
```

### 2. Dead Drop Tests

```dart
// test/core/network/rendezvous_dead_drop_test.dart

void main() {
  group('RendezvousService Dead Drops', () {
    // ... setup ...

    group('createDeadDrop', () {
      test('should create encrypted dead drop with connection info', () async {
        // Arrange
        when(() => mockCrypto.getPublicKeyBase64()).thenAnswer((_) async => 'my_pubkey_base64');
        when(() => mockRelayClient.getCurrentRelayId()).thenReturn('relay_123');
        when(() => mockRelayClient.mySourceId).thenReturn('source_456');
        when(() => mockNetworkInfo.getPublicIp()).thenAnswer((_) async => '1.2.3.4');
        when(() => mockRelayClient.listenPort).thenReturn(12345);

        String? capturedPlaintext;
        when(() => mockCrypto.encryptForPeer('peer1', any())).thenAnswer((invocation) async {
          capturedPlaintext = invocation.positionalArguments[1];
          return 'encrypted_payload';
        });

        // Act
        final encrypted = await service.createDeadDrop('peer1');

        // Assert
        expect(encrypted, 'encrypted_payload');
        expect(capturedPlaintext, isNotNull);

        final parsed = jsonDecode(capturedPlaintext!);
        expect(parsed['pubkey'], 'my_pubkey_base64');
        expect(parsed['relay'], 'relay_123');
        expect(parsed['sourceId'], 'source_456');
        expect(parsed['ip'], '1.2.3.4');
        expect(parsed['port'], 12345);
        expect(parsed['timestamp'], isNotNull);
      });

      test('should include relay fallbacks', () async {
        // Arrange
        when(() => mockRelayClient.getConnectedRelayIds()).thenReturn(['r1', 'r2', 'r3']);
        // ... other mocks ...

        String? capturedPlaintext;
        when(() => mockCrypto.encryptForPeer(any(), any())).thenAnswer((invocation) async {
          capturedPlaintext = invocation.positionalArguments[1];
          return 'encrypted';
        });

        // Act
        await service.createDeadDrop('peer1');

        // Assert
        final parsed = jsonDecode(capturedPlaintext!);
        expect(parsed['fallbackRelays'], hasLength(greaterThan(0)));
      });
    });

    group('decryptDeadDrop', () {
      test('should decrypt and parse connection info', () async {
        // Arrange
        final deadDropPayload = jsonEncode({
          'pubkey': 'their_pubkey',
          'relay': 'relay_abc',
          'sourceId': 'source_xyz',
          'ip': '5.6.7.8',
          'port': 54321,
          'timestamp': DateTime.now().toIso8601String(),
        });

        when(() => mockCrypto.decrypt('encrypted_drop')).thenAnswer((_) async => deadDropPayload);

        // Act
        final info = await service.decryptDeadDrop('encrypted_drop', 'peer1');

        // Assert
        expect(info.publicKey, 'their_pubkey');
        expect(info.relayId, 'relay_abc');
        expect(info.sourceId, 'source_xyz');
        expect(info.ip, '5.6.7.8');
        expect(info.port, 54321);
      });

      test('should handle decryption failure', () async {
        // Arrange
        when(() => mockCrypto.decrypt(any())).thenThrow(CryptoException('Decryption failed'));

        // Act & Assert
        expect(
          () => service.decryptDeadDrop('bad_payload', 'peer1'),
          throwsA(isA<DeadDropDecryptionException>()),
        );
      });

      test('should detect stale dead drop', () async {
        // Arrange
        final oldTimestamp = DateTime.now().subtract(Duration(hours: 25)).toIso8601String();
        final deadDropPayload = jsonEncode({
          'pubkey': 'key',
          'relay': 'relay',
          'sourceId': 'source',
          'ip': '1.2.3.4',
          'port': 12345,
          'timestamp': oldTimestamp,
        });

        when(() => mockCrypto.decrypt(any())).thenAnswer((_) async => deadDropPayload);

        // Act
        final info = await service.decryptDeadDrop('encrypted', 'peer1');

        // Assert
        expect(info.isStale, true);
        expect(info.age.inHours, greaterThan(24));
      });
    });
  });
}
```

### 3. Match Handling Tests

```dart
// test/core/network/rendezvous_match_test.dart

void main() {
  group('RendezvousService Match Handling', () {
    // ... setup ...

    group('handleLiveMatch', () {
      test('should emit event and initiate connection', () async {
        // Arrange
        final match = LiveMatch(peerId: 'peer1', relayId: 'relay_abc');
        final events = <PeerFoundEvent>[];
        service.onPeerFound.listen(events.add);

        // Act
        await service.handleLiveMatch(match);

        // Assert
        expect(events, hasLength(1));
        expect(events[0].peerId, 'peer1');
        expect(events[0].connectionType, ConnectionType.live);
      });
    });

    group('handleDeadDrop', () {
      test('should decrypt and emit event', () async {
        // Arrange
        final drop = DeadDrop(
          peerId: 'peer1',
          encryptedPayload: 'encrypted_data',
          relayId: 'relay_xyz',
        );

        when(() => mockCrypto.decrypt(any())).thenAnswer((_) async => jsonEncode({
          'pubkey': 'key',
          'relay': 'relay',
          'sourceId': 'source',
          'ip': '1.2.3.4',
          'port': 12345,
          'timestamp': DateTime.now().toIso8601String(),
        }));

        final events = <DeadDropEvent>[];
        service.onDeadDropReceived.listen(events.add);

        // Act
        await service.handleDeadDrop(drop, 'peer1');

        // Assert
        expect(events, hasLength(1));
        expect(events[0].connectionInfo.ip, '1.2.3.4');
      });

      test('should try direct connection for fresh dead drop', () async {
        // Arrange
        final freshTimestamp = DateTime.now().toIso8601String();
        when(() => mockCrypto.decrypt(any())).thenAnswer((_) async => jsonEncode({
          'pubkey': 'key',
          'relay': 'relay',
          'sourceId': 'source',
          'ip': '1.2.3.4',
          'port': 12345,
          'timestamp': freshTimestamp,
        }));

        // Act
        await service.handleDeadDrop(DeadDrop(
          peerId: 'peer1',
          encryptedPayload: 'enc',
          relayId: 'r1',
        ), 'peer1');

        // Assert
        verify(() => mockConnectionManager.connectDirect('1.2.3.4', 12345, any())).called(1);
      });

      test('should use relay for stale dead drop', () async {
        // Arrange
        final staleTimestamp = DateTime.now().subtract(Duration(hours: 2)).toIso8601String();
        when(() => mockCrypto.decrypt(any())).thenAnswer((_) async => jsonEncode({
          'pubkey': 'key',
          'relay': 'relay_abc',
          'sourceId': 'source_xyz',
          'ip': '1.2.3.4',
          'port': 12345,
          'timestamp': staleTimestamp,
        }));

        // Act
        await service.handleDeadDrop(DeadDrop(
          peerId: 'peer1',
          encryptedPayload: 'enc',
          relayId: 'r1',
        ), 'peer1');

        // Assert
        verify(() => mockRelayClient.sendIntroduction(
          relayId: 'relay_abc',
          targetSourceId: 'source_xyz',
          encryptedPayload: any(named: 'encryptedPayload'),
        )).called(1);
      });
    });

    group('processRendezvousResult', () {
      test('should prioritize live matches over dead drops', () async {
        // Arrange
        final result = RendezvousResult(
          liveMatches: [LiveMatch(peerId: 'peer1', relayId: 'r1')],
          deadDrops: [DeadDrop(peerId: 'peer1', encryptedPayload: 'enc', relayId: 'r2')],
        );

        // Act
        await service.processRendezvousResult('peer1', result);

        // Assert
        verify(() => mockConnectionManager.connectViaRelay('r1', any())).called(1);
        verifyNever(() => mockCrypto.decrypt(any()));
      });

      test('should fall back to dead drop if no live match', () async {
        // Arrange
        final result = RendezvousResult(
          liveMatches: [],
          deadDrops: [DeadDrop(peerId: 'peer1', encryptedPayload: 'enc', relayId: 'r2')],
        );

        setupDecryptMock();

        // Act
        await service.processRendezvousResult('peer1', result);

        // Assert
        verify(() => mockCrypto.decrypt('enc')).called(1);
      });
    });
  });
}
```

## Implementation

```dart
// lib/core/network/rendezvous_service.dart

import 'dart:async';
import 'dart:convert';
import 'package:zajel/core/network/meeting_point_service.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';
import 'package:zajel/core/network/signaling_client.dart';
import 'package:zajel/core/network/relay_client.dart';

/// Service for managing peer rendezvous via meeting points and dead drops.
class RendezvousService {
  final MeetingPointService _meetingPointService;
  final CryptoService _cryptoService;
  final TrustedPeersStorage _trustedPeersStorage;
  final SignalingClient _signalingClient;
  final RelayClient _relayClient;

  final _peerFoundController = StreamController<PeerFoundEvent>.broadcast();
  final _deadDropController = StreamController<DeadDropEvent>.broadcast();

  /// Emitted when a peer is found (live or via dead drop).
  Stream<PeerFoundEvent> get onPeerFound => _peerFoundController.stream;

  /// Emitted when a dead drop is received.
  Stream<DeadDropEvent> get onDeadDropReceived => _deadDropController.stream;

  RendezvousService({
    required MeetingPointService meetingPointService,
    required CryptoService cryptoService,
    required TrustedPeersStorage trustedPeersStorage,
    required SignalingClient signalingClient,
    required RelayClient relayClient,
  })  : _meetingPointService = meetingPointService,
        _cryptoService = cryptoService,
        _trustedPeersStorage = trustedPeersStorage,
        _signalingClient = signalingClient,
        _relayClient = relayClient {
    // Listen for match notifications from server
    _signalingClient.onRendezvousMatch.listen(_handleServerMatch);
  }

  /// Register for rendezvous with a specific trusted peer.
  Future<RendezvousResult> registerForPeer(String peerId) async {
    // Get keys
    final myPubkey = await _cryptoService.getPublicKeyBytes();
    final theirPubkey = await _trustedPeersStorage.getPublicKeyBytes(peerId);

    if (theirPubkey == null) {
      throw PeerNotFoundException(peerId);
    }

    // Derive meeting points
    final dailyPoints = _meetingPointService.deriveDailyPoints(myPubkey, theirPubkey);

    // Derive hourly tokens (if we have shared secret)
    final sharedSecret = await _cryptoService.getSessionKeyBytes(peerId);
    final hourlyTokens = sharedSecret != null
        ? _meetingPointService.deriveHourlyTokens(sharedSecret)
        : <String>[];

    // Create dead drop
    final deadDrop = await _createDeadDrop(peerId);

    // Register with server
    final registration = RendezvousRegistration(
      dailyPoints: dailyPoints,
      hourlyTokens: hourlyTokens,
      deadDrop: deadDrop,
      relayId: _relayClient.getCurrentRelayId(),
    );

    final result = await _signalingClient.registerRendezvous(registration);

    // Process any immediate matches
    await processRendezvousResult(peerId, result);

    return result;
  }

  /// Register for rendezvous with all trusted peers.
  Future<Map<String, RendezvousResult>> registerForAllPeers() async {
    final peerIds = await _trustedPeersStorage.getAllPeerIds();
    final results = <String, RendezvousResult>{};

    for (final peerId in peerIds) {
      try {
        results[peerId] = await registerForPeer(peerId);
      } catch (e) {
        // Log error but continue with other peers
        print('Failed to register for peer $peerId: $e');
      }
    }

    return results;
  }

  /// Create an encrypted dead drop payload for a peer.
  Future<String> _createDeadDrop(String peerId) async {
    final info = ConnectionInfo(
      publicKey: await _cryptoService.getPublicKeyBase64(),
      relayId: _relayClient.getCurrentRelayId(),
      sourceId: _relayClient.mySourceId,
      ip: await _getPublicIp(),
      port: _relayClient.listenPort,
      fallbackRelays: _relayClient.getConnectedRelayIds().take(3).toList(),
      timestamp: DateTime.now().toUtc(),
    );

    final plaintext = jsonEncode(info.toJson());
    return _cryptoService.encryptForPeer(peerId, plaintext);
  }

  /// Decrypt and parse a dead drop payload.
  Future<ConnectionInfo> decryptDeadDrop(String encrypted, String fromPeerId) async {
    try {
      final plaintext = await _cryptoService.decrypt(encrypted);
      final json = jsonDecode(plaintext) as Map<String, dynamic>;
      return ConnectionInfo.fromJson(json);
    } catch (e) {
      throw DeadDropDecryptionException('Failed to decrypt dead drop: $e');
    }
  }

  /// Process a rendezvous result (matches and dead drops).
  Future<void> processRendezvousResult(String peerId, RendezvousResult result) async {
    // Prioritize live matches
    if (result.liveMatches.isNotEmpty) {
      final match = result.liveMatches.first;
      _peerFoundController.add(PeerFoundEvent(
        peerId: peerId,
        connectionType: ConnectionType.live,
        relayId: match.relayId,
      ));
      return;
    }

    // Fall back to dead drops
    if (result.deadDrops.isNotEmpty) {
      final drop = result.deadDrops.first;
      await _handleDeadDrop(drop, peerId);
    }
  }

  /// Handle a dead drop.
  Future<void> _handleDeadDrop(DeadDrop drop, String peerId) async {
    final info = await decryptDeadDrop(drop.encryptedPayload, peerId);

    _deadDropController.add(DeadDropEvent(
      peerId: peerId,
      connectionInfo: info,
    ));

    // Decide connection strategy based on freshness
    if (info.isStale) {
      // Use relay - IP might have changed
      await _connectViaRelay(info);
    } else {
      // Try direct connection first
      await _connectDirect(info);
    }
  }

  /// Handle match notification from server.
  void _handleServerMatch(RendezvousMatch match) {
    _peerFoundController.add(PeerFoundEvent(
      peerId: match.peerId,
      connectionType: ConnectionType.live,
      relayId: match.relayId,
    ));
  }

  Future<String> _getPublicIp() async {
    // Implementation depends on network service
    return '0.0.0.0'; // Placeholder
  }

  Future<void> _connectDirect(ConnectionInfo info) async {
    // Delegate to connection manager
  }

  Future<void> _connectViaRelay(ConnectionInfo info) async {
    // Delegate to relay client
  }

  void dispose() {
    _peerFoundController.close();
    _deadDropController.close();
  }
}

/// Information about how to connect to a peer.
class ConnectionInfo {
  final String publicKey;
  final String relayId;
  final String sourceId;
  final String ip;
  final int port;
  final List<String> fallbackRelays;
  final DateTime timestamp;

  ConnectionInfo({
    required this.publicKey,
    required this.relayId,
    required this.sourceId,
    required this.ip,
    required this.port,
    this.fallbackRelays = const [],
    required this.timestamp,
  });

  /// Whether this info is likely stale (>1 hour old).
  bool get isStale => age > Duration(hours: 1);

  /// Age of this connection info.
  Duration get age => DateTime.now().toUtc().difference(timestamp);

  factory ConnectionInfo.fromJson(Map<String, dynamic> json) {
    return ConnectionInfo(
      publicKey: json['pubkey'] as String,
      relayId: json['relay'] as String,
      sourceId: json['sourceId'] as String,
      ip: json['ip'] as String,
      port: json['port'] as int,
      fallbackRelays: (json['fallbackRelays'] as List?)?.cast<String>() ?? [],
      timestamp: DateTime.parse(json['timestamp'] as String),
    );
  }

  Map<String, dynamic> toJson() => {
    'pubkey': publicKey,
    'relay': relayId,
    'sourceId': sourceId,
    'ip': ip,
    'port': port,
    'fallbackRelays': fallbackRelays,
    'timestamp': timestamp.toIso8601String(),
  };
}

// Additional classes...
class PeerFoundEvent {
  final String peerId;
  final ConnectionType connectionType;
  final String? relayId;

  PeerFoundEvent({
    required this.peerId,
    required this.connectionType,
    this.relayId,
  });
}

class DeadDropEvent {
  final String peerId;
  final ConnectionInfo connectionInfo;

  DeadDropEvent({required this.peerId, required this.connectionInfo});
}

enum ConnectionType { live, deadDrop }

class PeerNotFoundException implements Exception {
  final String peerId;
  PeerNotFoundException(this.peerId);
  @override
  String toString() => 'Peer not found: $peerId';
}

class DeadDropDecryptionException implements Exception {
  final String message;
  DeadDropDecryptionException(this.message);
  @override
  String toString() => message;
}
```

## File Structure

```
packages/app/lib/core/network/
├── rendezvous_service.dart      # Main service
├── rendezvous_models.dart       # Data classes
└── rendezvous_exceptions.dart   # Exceptions

packages/app/test/core/network/
├── rendezvous_service_test.dart
├── rendezvous_dead_drop_test.dart
└── rendezvous_match_test.dart
```
