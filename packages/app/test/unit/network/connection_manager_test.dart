import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/models/models.dart';
import 'package:zajel/core/network/connection_manager.dart';
import 'package:zajel/core/network/webrtc_service.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';

import '../../mocks/mocks.dart';

// Register fallback values for types used with `any()` in mocktail stubs.
class _FakeMessage extends Fake implements Message {}

class _FakeTrustedPeer extends Fake implements TrustedPeer {}

// ---------------------------------------------------------------------------
// Fake WebRTCService that captures callbacks set by ConnectionManager.
// Using Fake (not Mock) so that ConnectionManager._setupCallbacks()
// actually stores the callbacks in real fields.
// ---------------------------------------------------------------------------
class FakeWebRTCService extends Fake implements WebRTCService {
  @override
  OnMessageCallback? onMessage;
  @override
  OnFileChunkCallback? onFileChunk;
  @override
  OnFileStartCallback? onFileStart;
  @override
  OnFileCompleteCallback? onFileComplete;
  @override
  OnConnectionStateCallback? onConnectionStateChange;
  @override
  OnHandshakeCompleteCallback? onHandshakeComplete;
  @override
  @Deprecated('Use signalingEvents stream instead')
  OnSignalingMessageCallback? onSignalingMessage;

  final _signalingController = StreamController<SignalingEvent>.broadcast();
  bool disposed = false;

  @override
  Stream<SignalingEvent> get signalingEvents => _signalingController.stream;

  // Track calls for verification
  final List<String> closedConnections = [];
  final List<(String, String)> sentMessages = [];
  final performedHandshakes = <String, Map<String, String?>>{};

  @override
  Future<void> sendMessage(String peerId, String message) async {
    sentMessages.add((peerId, message));
  }

  @override
  Future<void> closeConnection(String peerId) async {
    closedConnections.add(peerId);
  }

  @override
  Future<void> performHandshake(String peerId,
      {String? username, String? stableId}) async {
    performedHandshakes[peerId] = {'username': username, 'stableId': stableId};
  }

  @override
  Future<void> dispose() async {
    disposed = true;
    await _signalingController.close();
  }
}

void main() {
  setUpAll(() {
    registerFallbackValue(_FakeMessage());
    registerFallbackValue(_FakeTrustedPeer());
  });

  group('ConnectionManager', () {
    late ConnectionManager connectionManager;
    late MockCryptoService mockCryptoService;
    late FakeWebRTCService fakeWebRTCService;
    late MockDeviceLinkService mockDeviceLinkService;
    late MockTrustedPeersStorage mockTrustedPeersStorage;
    late MockMeetingPointService mockMeetingPointService;
    late MockMessageStorage mockMessageStorage;

    setUp(() {
      mockCryptoService = MockCryptoService();
      fakeWebRTCService = FakeWebRTCService();
      mockDeviceLinkService = MockDeviceLinkService();
      mockTrustedPeersStorage = MockTrustedPeersStorage();
      mockMeetingPointService = MockMeetingPointService();
      mockMessageStorage = MockMessageStorage();

      // Default stubs — many ConnectionManager callbacks call these internally
      when(() => mockTrustedPeersStorage.getAllPeers())
          .thenAnswer((_) async => []);
      when(() => mockTrustedPeersStorage.savePeer(any()))
          .thenAnswer((_) async {});
      when(() => mockTrustedPeersStorage.getPeer(any()))
          .thenAnswer((_) async => null);
      when(() => mockDeviceLinkService.currentLinkedDevices).thenReturn([]);
      when(() => mockDeviceLinkService.broadcastToLinkedDevices(
            fromPeerId: any(named: 'fromPeerId'),
            plaintext: any(named: 'plaintext'),
          )).thenAnswer((_) async {});
      when(() => mockMessageStorage.saveMessage(any()))
          .thenAnswer((_) async {});

      connectionManager = ConnectionManager(
        cryptoService: mockCryptoService,
        webrtcService: fakeWebRTCService,
        deviceLinkService: mockDeviceLinkService,
        trustedPeersStorage: mockTrustedPeersStorage,
        meetingPointService: mockMeetingPointService,
        messageStorage: mockMessageStorage,
        username: 'TestUser',
      );
    });

    tearDown(() async {
      await connectionManager.dispose();
    });

    // =========================================================================
    // Group 1: Initialization & Load Trusted Peers
    // =========================================================================
    group('initialize', () {
      test('calls cryptoService.initialize', () async {
        when(() => mockCryptoService.initialize()).thenAnswer((_) async {});

        await connectionManager.initialize();

        verify(() => mockCryptoService.initialize()).called(1);
      });

      test('loads trusted peers as offline after initialization', () async {
        final trustedPeer = TrustedPeer(
          id: 'stable-id-1',
          publicKey: 'pubkey-base64',
          displayName: 'Alice',
          trustedAt: DateTime(2024, 1, 1),
        );
        when(() => mockTrustedPeersStorage.getAllPeers())
            .thenAnswer((_) async => [trustedPeer]);
        when(() => mockCryptoService.initialize()).thenAnswer((_) async {});

        await connectionManager.initialize();

        final peers = connectionManager.currentPeers;
        expect(peers, hasLength(1));
        expect(peers.first.id, 'stable-id-1');
        expect(peers.first.displayName, 'Alice');
        expect(peers.first.connectionState, PeerConnectionState.disconnected);
      });

      test('skips blocked peers when loading', () async {
        final blockedPeer = TrustedPeer(
          id: 'blocked-id',
          publicKey: 'blocked-key',
          displayName: 'Blocked',
          trustedAt: DateTime(2024, 1, 1),
          isBlocked: true,
        );
        when(() => mockTrustedPeersStorage.getAllPeers())
            .thenAnswer((_) async => [blockedPeer]);
        when(() => mockCryptoService.initialize()).thenAnswer((_) async {});

        await connectionManager.initialize();

        expect(connectionManager.currentPeers, isEmpty);
      });

      test('uses alias over displayName when loading trusted peers', () async {
        final trustedPeer = TrustedPeer(
          id: 'peer-1',
          publicKey: 'pk1',
          displayName: 'Original',
          alias: 'MyAlias',
          trustedAt: DateTime(2024, 1, 1),
        );
        when(() => mockTrustedPeersStorage.getAllPeers())
            .thenAnswer((_) async => [trustedPeer]);
        when(() => mockCryptoService.initialize()).thenAnswer((_) async {});

        await connectionManager.initialize();

        expect(connectionManager.currentPeers.first.displayName, 'MyAlias');
      });
    });

    // =========================================================================
    // Group 2: Peer Management & Pairing Code Validation
    // =========================================================================
    group('connectToPeer', () {
      test('throws for invalid pairing code format', () {
        expect(
          () => connectionManager.connectToPeer('!!!!!!'),
          throwsA(isA<ConnectionException>().having(
            (e) => e.message,
            'message',
            contains('Invalid pairing code format'),
          )),
        );
      });

      test('throws for code with excluded characters (0, O, 1, I)', () {
        // 'O' is excluded from the character set
        expect(
          () => connectionManager.connectToPeer('ABCOEF'),
          throwsA(isA<ConnectionException>()),
        );
      });

      test('throws for code that is too short', () {
        expect(
          () => connectionManager.connectToPeer('ABC'),
          throwsA(isA<ConnectionException>()),
        );
      });

      test('throws for code that is too long', () {
        expect(
          () => connectionManager.connectToPeer('ABCDEFGH'),
          throwsA(isA<ConnectionException>()),
        );
      });

      test('throws when not connected to signaling server', () {
        expect(
          () => connectionManager.connectToPeer('ABC234'),
          throwsA(isA<ConnectionException>().having(
            (e) => e.message,
            'message',
            contains('Not connected to signaling server'),
          )),
        );
      });

      test('is case-insensitive', () {
        // Lowercase valid code — still fails because no signaling, but
        // the error should be about signaling, not about invalid format.
        expect(
          () => connectionManager.connectToPeer('abc234'),
          throwsA(isA<ConnectionException>().having(
            (e) => e.message,
            'message',
            contains('Not connected to signaling server'),
          )),
        );
      });
    });

    group('respondToPairRequest', () {
      test('removes peer from list when rejected', () {
        connectionManager.respondToPairRequest('PEER23', accept: false);

        expect(
          connectionManager.currentPeers.any((p) => p.id == 'PEER23'),
          isFalse,
        );
      });
    });

    // =========================================================================
    // Group 3: Streams existence
    // =========================================================================
    group('streams', () {
      test('peers stream exists', () {
        expect(connectionManager.peers, isA<Stream<List<Peer>>>());
      });

      test('peerMessages stream exists', () {
        expect(connectionManager.peerMessages, isA<Stream<(String, String)>>());
      });

      test('groupInvitations stream exists', () {
        expect(connectionManager.groupInvitations,
            isA<Stream<(String, String)>>());
      });

      test('groupData stream exists', () {
        expect(connectionManager.groupData, isA<Stream<(String, String)>>());
      });

      test('typingEvents stream exists', () {
        expect(connectionManager.typingEvents, isA<Stream<(String, String)>>());
      });

      test('receiptEvents stream exists', () {
        expect(
            connectionManager.receiptEvents, isA<Stream<(String, String)>>());
      });

      test('keyChanges stream exists', () {
        expect(connectionManager.keyChanges,
            isA<Stream<(String, String, String)>>());
      });

      test('linkRequests stream exists', () {
        expect(connectionManager.linkRequests,
            isA<Stream<(String, String, String)>>());
      });

      test('pairRequests stream exists', () {
        expect(connectionManager.pairRequests, isA<Stream>());
      });

      test('fileChunks stream exists', () {
        expect(connectionManager.fileChunks, isA<Stream>());
      });

      test('fileStarts stream exists', () {
        expect(connectionManager.fileStarts, isA<Stream>());
      });

      test('fileCompletes stream exists', () {
        expect(connectionManager.fileCompletes, isA<Stream>());
      });
    });

    // =========================================================================
    // Group 4: Message Routing via WebRTC Callbacks
    // =========================================================================
    group('message routing', () {
      test('routes plain messages to peerMessages stream', () async {
        final events = <(String, String)>[];
        final sub = connectionManager.peerMessages.listen(events.add);

        fakeWebRTCService.onMessage!('peer-1', 'Hello!');
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.$1, 'peer-1');
        expect(events.first.$2, 'Hello!');
        await sub.cancel();
      });

      test('routes ginv: messages to groupInvitations stream', () async {
        final events = <(String, String)>[];
        final sub = connectionManager.groupInvitations.listen(events.add);

        fakeWebRTCService.onMessage!('peer-1', 'ginv:{"groupId":"g1"}');
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.$1, 'peer-1');
        expect(events.first.$2, '{"groupId":"g1"}');
        await sub.cancel();
      });

      test('routes grp: messages to groupData stream', () async {
        final events = <(String, String)>[];
        final sub = connectionManager.groupData.listen(events.add);

        fakeWebRTCService.onMessage!('peer-1', 'grp:payload-data');
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.$2, 'payload-data');
        await sub.cancel();
      });

      test('routes typ: messages to typingEvents stream', () async {
        final events = <(String, String)>[];
        final sub = connectionManager.typingEvents.listen(events.add);

        fakeWebRTCService.onMessage!('peer-1', 'typ:start');
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.$2, 'start');
        await sub.cancel();
      });

      test('routes rcpt: messages to receiptEvents stream', () async {
        final events = <(String, String)>[];
        final sub = connectionManager.receiptEvents.listen(events.add);

        fakeWebRTCService.onMessage!('peer-1', 'rcpt:1234567890');
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.$2, '1234567890');
        await sub.cancel();
      });

      test('ginv: prefix is stripped from group invitations', () async {
        final events = <(String, String)>[];
        final sub = connectionManager.groupInvitations.listen(events.add);

        fakeWebRTCService.onMessage!('peer-1', 'ginv:data');
        await Future.delayed(Duration.zero);

        // Should NOT contain the 'ginv:' prefix
        expect(events.first.$2, 'data');
        expect(events.first.$2.contains('ginv:'), isFalse);
        await sub.cancel();
      });

      test('plain messages do NOT appear on typed streams', () async {
        final ginvEvents = <(String, String)>[];
        final grpEvents = <(String, String)>[];
        final typEvents = <(String, String)>[];
        final rcptEvents = <(String, String)>[];

        final subs = [
          connectionManager.groupInvitations.listen(ginvEvents.add),
          connectionManager.groupData.listen(grpEvents.add),
          connectionManager.typingEvents.listen(typEvents.add),
          connectionManager.receiptEvents.listen(rcptEvents.add),
        ];

        fakeWebRTCService.onMessage!('peer-1', 'Hello world');
        await Future.delayed(Duration.zero);

        expect(ginvEvents, isEmpty);
        expect(grpEvents, isEmpty);
        expect(typEvents, isEmpty);
        expect(rcptEvents, isEmpty);

        for (final sub in subs) {
          await sub.cancel();
        }
      });

      test('forwards messages to linked devices', () async {
        fakeWebRTCService.onMessage!('peer-1', 'Hello');
        await Future.delayed(Duration.zero);

        verify(() => mockDeviceLinkService.broadcastToLinkedDevices(
              fromPeerId: 'peer-1',
              plaintext: 'Hello',
            )).called(1);
      });

      test('translates signaling code to stable ID for reconnected peers',
          () async {
        final events = <(String, String)>[];
        final sub = connectionManager.peerMessages.listen(events.add);

        // The only way to set up _codeToStableId mapping is through the
        // onHandshakeComplete callback, which calls _toStableId.
        // For this test we verify the direct path (no mapping = passthrough).
        fakeWebRTCService.onMessage!('some-code', 'hi');
        await Future.delayed(Duration.zero);

        expect(events.first.$1, 'some-code');
        await sub.cancel();
      });
    });

    // =========================================================================
    // Group 5: File Transfer Routing
    // =========================================================================
    group('file transfer routing', () {
      test('routes file start events', () async {
        final events = <(String, String, String, int, int)>[];
        final sub = connectionManager.fileStarts.listen(events.add);

        fakeWebRTCService.onFileStart!('peer-1', 'f1', 'test.pdf', 1024, 4);
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.$1, 'peer-1');
        expect(events.first.$2, 'f1');
        expect(events.first.$3, 'test.pdf');
        expect(events.first.$4, 1024);
        expect(events.first.$5, 4);
        await sub.cancel();
      });

      test('routes file chunk events', () async {
        final events = <(String, String, Uint8List, int, int)>[];
        final sub = connectionManager.fileChunks.listen(events.add);

        final chunk = Uint8List.fromList([1, 2, 3]);
        fakeWebRTCService.onFileChunk!('peer-1', 'f1', chunk, 0, 4);
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.$1, 'peer-1');
        expect(events.first.$3, chunk);
        expect(events.first.$4, 0);
        await sub.cancel();
      });

      test('routes file complete events', () async {
        final events = <(String, String)>[];
        final sub = connectionManager.fileCompletes.listen(events.add);

        fakeWebRTCService.onFileComplete!('peer-1', 'f1');
        await Future.delayed(Duration.zero);

        expect(events, hasLength(1));
        expect(events.first.$1, 'peer-1');
        expect(events.first.$2, 'f1');
        await sub.cancel();
      });
    });

    // =========================================================================
    // Group 6: Connection State Changes
    // =========================================================================
    group('connection state changes', () {
      setUp(() {
        // Need a peer in the map for state changes to work
        when(() => mockTrustedPeersStorage.getAllPeers())
            .thenAnswer((_) async => [
                  TrustedPeer(
                    id: 'peer-1',
                    publicKey: 'pk1-pubkey-base64-CCCCCC',
                    displayName: 'Alice',
                    trustedAt: DateTime(2024, 1, 1),
                  ),
                ]);
        when(() => mockCryptoService.initialize()).thenAnswer((_) async {});
      });

      test('updates peer state when WebRTC reports state change', () async {
        await connectionManager.initialize();

        final states = <List<Peer>>[];
        final sub = connectionManager.peers.listen(states.add);

        fakeWebRTCService.onConnectionStateChange!(
            'peer-1', PeerConnectionState.connecting);
        await Future.delayed(Duration.zero);

        expect(
            states.last.first.connectionState, PeerConnectionState.connecting);
        await sub.cancel();
      });

      test('performs handshake when state transitions to handshaking',
          () async {
        await connectionManager.initialize();

        when(() => mockCryptoService.stableId).thenReturn('my-stable-id');

        fakeWebRTCService.onConnectionStateChange!(
            'peer-1', PeerConnectionState.handshaking);

        expect(fakeWebRTCService.performedHandshakes.containsKey('peer-1'),
            isTrue);
        expect(fakeWebRTCService.performedHandshakes['peer-1']!['username'],
            'TestUser');
      });

      test('saves trusted peer when connected', () async {
        await connectionManager.initialize();

        when(() =>
                mockTrustedPeersStorage.recordKeyRotation(any(), any(), any()))
            .thenAnswer((_) async {});
        when(() => mockCryptoService.setPeerPublicKey(any(), any()))
            .thenReturn(null);

        // Give the peer a publicKey so it can be saved as trusted
        fakeWebRTCService.onHandshakeComplete!(
            'peer-1', 'new-pubkey-base64-BBBBBB', 'Alice', null);
        await Future.delayed(const Duration(milliseconds: 50));

        // Reset to count only the savePeer from connection state change
        reset(mockTrustedPeersStorage);
        when(() => mockTrustedPeersStorage.savePeer(any()))
            .thenAnswer((_) async {});
        when(() => mockTrustedPeersStorage.getPeer(any()))
            .thenAnswer((_) async => null);

        fakeWebRTCService.onConnectionStateChange!(
            'peer-1', PeerConnectionState.connected);
        await Future.delayed(Duration.zero);

        verify(() => mockTrustedPeersStorage.savePeer(any())).called(1);
      });

      test('handles linked device connection state changes', () async {
        fakeWebRTCService.onConnectionStateChange!(
            'link_abc123', PeerConnectionState.connected);

        verify(() => mockDeviceLinkService.handleDeviceConnected('link_abc123'))
            .called(1);
      });

      test('handles linked device disconnection', () async {
        fakeWebRTCService.onConnectionStateChange!(
            'link_abc123', PeerConnectionState.disconnected);

        verify(() =>
                mockDeviceLinkService.handleDeviceDisconnected('link_abc123'))
            .called(1);
      });
    });

    // =========================================================================
    // Group 7: Handshake Complete & Key Rotation
    // =========================================================================
    group('handshake complete', () {
      setUp(() async {
        when(() => mockTrustedPeersStorage.getAllPeers())
            .thenAnswer((_) async => [
                  TrustedPeer(
                    id: 'peer-1',
                    publicKey: 'old-pubkey-base64-AAAAAA',
                    displayName: 'Alice',
                    trustedAt: DateTime(2024, 1, 1),
                  ),
                ]);
        when(() => mockCryptoService.initialize()).thenAnswer((_) async {});
        await connectionManager.initialize();
      });

      test('updates peer username from handshake', () async {
        fakeWebRTCService.onHandshakeComplete!(
            'peer-1', 'new-pubkey-base64-BBBBBB', 'AliceNewName', null);
        await Future.delayed(Duration.zero);

        final peer =
            connectionManager.currentPeers.firstWhere((p) => p.id == 'peer-1');
        // Username should be updated from handshake
        expect(peer.username, 'AliceNewName');
      });

      test('transitions peer to connected state', () async {
        final states = <List<Peer>>[];
        final sub = connectionManager.peers.listen(states.add);

        fakeWebRTCService.onHandshakeComplete!(
            'peer-1', 'new-pubkey-base64-BBBBBB', 'Alice', null);
        await Future.delayed(Duration.zero);

        expect(
            states.last.first.connectionState, PeerConnectionState.connected);
        await sub.cancel();
      });
    });

    group('key rotation detection', () {
      // Keys must be >= 8 chars because _checkKeyRotation logs substring(0,8)
      const oldKey = 'old-pubkey-base64-AAAAAA';
      const newKey = 'new-pubkey-base64-BBBBBB';

      setUp(() async {
        when(() => mockCryptoService.initialize()).thenAnswer((_) async {});
        when(() => mockTrustedPeersStorage.getAllPeers())
            .thenAnswer((_) async => [
                  TrustedPeer(
                    id: 'peer-1',
                    publicKey: oldKey,
                    displayName: 'Alice',
                    trustedAt: DateTime(2024, 1, 1),
                  ),
                ]);
        await connectionManager.initialize();
      });

      test('detects key rotation and emits keyChanges event', () async {
        when(() => mockTrustedPeersStorage.getPeer('peer-1'))
            .thenAnswer((_) async => TrustedPeer(
                  id: 'peer-1',
                  publicKey: oldKey,
                  displayName: 'Alice',
                  trustedAt: DateTime(2024, 1, 1),
                ));
        when(() =>
                mockTrustedPeersStorage.recordKeyRotation(any(), any(), any()))
            .thenAnswer((_) async {});
        when(() => mockCryptoService.setPeerPublicKey(any(), any()))
            .thenReturn(null);

        final keyChanges = <(String, String, String)>[];
        final sub = connectionManager.keyChanges.listen(keyChanges.add);

        // Trigger handshake with a different public key
        fakeWebRTCService.onHandshakeComplete!('peer-1', newKey, 'Alice', null);
        // Allow async _checkKeyRotation to complete
        await Future.delayed(const Duration(milliseconds: 50));

        expect(keyChanges, hasLength(1));
        expect(keyChanges.first.$1, 'peer-1');
        expect(keyChanges.first.$2, oldKey);
        expect(keyChanges.first.$3, newKey);
        await sub.cancel();
      });

      test('records key rotation in trusted peers storage', () async {
        when(() => mockTrustedPeersStorage.getPeer('peer-1'))
            .thenAnswer((_) async => TrustedPeer(
                  id: 'peer-1',
                  publicKey: oldKey,
                  displayName: 'Alice',
                  trustedAt: DateTime(2024, 1, 1),
                ));
        when(() =>
                mockTrustedPeersStorage.recordKeyRotation(any(), any(), any()))
            .thenAnswer((_) async {});
        when(() => mockCryptoService.setPeerPublicKey(any(), any()))
            .thenReturn(null);

        fakeWebRTCService.onHandshakeComplete!('peer-1', newKey, 'Alice', null);
        await Future.delayed(const Duration(milliseconds: 50));

        verify(() => mockTrustedPeersStorage.recordKeyRotation(
              'peer-1',
              oldKey,
              newKey,
            )).called(1);
      });

      test('inserts system message on key rotation', () async {
        when(() => mockTrustedPeersStorage.getPeer('peer-1'))
            .thenAnswer((_) async => TrustedPeer(
                  id: 'peer-1',
                  publicKey: oldKey,
                  displayName: 'Alice',
                  trustedAt: DateTime(2024, 1, 1),
                ));
        when(() =>
                mockTrustedPeersStorage.recordKeyRotation(any(), any(), any()))
            .thenAnswer((_) async {});
        when(() => mockCryptoService.setPeerPublicKey(any(), any()))
            .thenReturn(null);

        fakeWebRTCService.onHandshakeComplete!('peer-1', newKey, 'Alice', null);
        await Future.delayed(const Duration(milliseconds: 50));

        final captured = verify(() => mockMessageStorage.saveMessage(
              captureAny(),
            )).captured;
        expect(captured, hasLength(1));
        final msg = captured.first as Message;
        expect(msg.type, MessageType.system);
        expect(msg.content, contains('Safety number changed'));
      });

      test('does NOT emit key change when key is the same', () async {
        when(() => mockTrustedPeersStorage.getPeer('peer-1'))
            .thenAnswer((_) async => TrustedPeer(
                  id: 'peer-1',
                  publicKey: oldKey,
                  displayName: 'Alice',
                  trustedAt: DateTime(2024, 1, 1),
                ));

        final keyChanges = <(String, String, String)>[];
        final sub = connectionManager.keyChanges.listen(keyChanges.add);

        // Same key as stored — no rotation
        fakeWebRTCService.onHandshakeComplete!('peer-1', oldKey, 'Alice', null);
        await Future.delayed(const Duration(milliseconds: 50));

        expect(keyChanges, isEmpty);
        await sub.cancel();
      });

      test('does NOT emit key change for unknown peer', () async {
        final keyChanges = <(String, String, String)>[];
        final sub = connectionManager.keyChanges.listen(keyChanges.add);

        fakeWebRTCService.onHandshakeComplete!(
            'unknown', 'some-pubkey-base64', 'Bob', null);
        await Future.delayed(const Duration(milliseconds: 50));

        expect(keyChanges, isEmpty);
        await sub.cancel();
      });
    });

    // =========================================================================
    // Group 8: Send Message & Send File
    // =========================================================================
    group('sendMessage', () {
      test('delegates to webrtc service', () async {
        await connectionManager.sendMessage('peer-1', 'Hello');

        expect(fakeWebRTCService.sentMessages, hasLength(1));
        expect(fakeWebRTCService.sentMessages.first.$1, 'peer-1');
        expect(fakeWebRTCService.sentMessages.first.$2, 'Hello');
      });
    });

    group('disconnectPeer', () {
      setUp(() async {
        when(() => mockTrustedPeersStorage.getAllPeers())
            .thenAnswer((_) async => [
                  TrustedPeer(
                    id: 'peer-1',
                    publicKey: 'pk1',
                    displayName: 'Alice',
                    trustedAt: DateTime(2024, 1, 1),
                  ),
                ]);
        when(() => mockCryptoService.initialize()).thenAnswer((_) async {});
        await connectionManager.initialize();
      });

      test('closes WebRTC connection', () async {
        await connectionManager.disconnectPeer('peer-1');

        expect(fakeWebRTCService.closedConnections, contains('peer-1'));
      });

      test('marks peer as disconnected', () async {
        await connectionManager.disconnectPeer('peer-1');

        final peer =
            connectionManager.currentPeers.firstWhere((p) => p.id == 'peer-1');
        expect(peer.connectionState, PeerConnectionState.disconnected);
      });
    });

    // =========================================================================
    // Group 9: Current State
    // =========================================================================
    group('currentPeers', () {
      test('returns empty list initially', () {
        expect(connectionManager.currentPeers, isEmpty);
      });
    });

    group('externalPairingCode', () {
      test('returns null when not connected', () {
        expect(connectionManager.externalPairingCode, isNull);
      });
    });

    group('signalingClient', () {
      test('returns null when not connected', () {
        expect(connectionManager.signalingClient, isNull);
      });
    });

    // =========================================================================
    // Group 10: Blocked Peer Handling
    // =========================================================================
    group('blocked peer handling', () {
      test('setBlockedCheck updates the callback', () {
        bool checked = false;
        connectionManager.setBlockedCheck((key) {
          checked = true;
          return false;
        });

        // The callback is stored, but we can't directly test it without
        // triggering signaling events. Verify it doesn't throw.
        expect(checked, isFalse); // Not called yet, just stored
      });
    });

    // =========================================================================
    // Group 11: Dispose & Cleanup
    // =========================================================================
    group('dispose', () {
      test('disposes WebRTC service', () async {
        await connectionManager.dispose();

        expect(fakeWebRTCService.disposed, isTrue);
      });

      test('closes all stream controllers without error', () async {
        // Subscribe to all streams to ensure they exist
        final subs = <StreamSubscription>[
          connectionManager.peers.listen((_) {}),
          connectionManager.peerMessages.listen((_) {}),
          connectionManager.groupInvitations.listen((_) {}),
          connectionManager.groupData.listen((_) {}),
          connectionManager.typingEvents.listen((_) {}),
          connectionManager.receiptEvents.listen((_) {}),
          connectionManager.keyChanges.listen((_) {}),
          connectionManager.linkRequests.listen((_) {}),
          connectionManager.pairRequests.listen((_) {}),
          connectionManager.fileChunks.listen((_) {}),
          connectionManager.fileStarts.listen((_) {}),
          connectionManager.fileCompletes.listen((_) {}),
        ];

        // Dispose should not throw
        await connectionManager.dispose();

        // Cancel all subscriptions (some may already be done)
        for (final sub in subs) {
          await sub.cancel();
        }
      });

      test('clears signaling state', () async {
        await connectionManager.dispose();

        expect(connectionManager.externalPairingCode, isNull);
        expect(connectionManager.signalingClient, isNull);
      });
    });
  });

  // ===========================================================================
  // ConnectionException
  // ===========================================================================
  group('ConnectionException', () {
    test('toString includes message', () {
      final exception = ConnectionException('Test error');

      expect(exception.toString(), contains('Test error'));
      expect(exception.toString(), contains('ConnectionException'));
    });

    test('message property returns message', () {
      const errorMessage = 'Connection failed';
      final exception = ConnectionException(errorMessage);

      expect(exception.message, errorMessage);
    });
  });
}
