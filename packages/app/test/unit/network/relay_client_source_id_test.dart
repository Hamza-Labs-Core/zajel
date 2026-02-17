import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/network/relay_client.dart';
import 'package:zajel/core/network/webrtc_service.dart';
import 'package:zajel/core/network/signaling_client.dart';

// Mock classes
class MockWebRTCService extends Mock implements WebRTCService {}

class MockSignalingClient extends Mock implements SignalingClient {}

void main() {
  group('RelayClient Source ID Management', () {
    late RelayClient client;
    late MockWebRTCService mockWebRTC;
    late MockSignalingClient mockSignaling;

    setUp(() {
      mockWebRTC = MockWebRTCService();
      mockSignaling = MockSignalingClient();

      when(() => mockWebRTC.onMessage).thenReturn(null);
      when(() => mockWebRTC.onConnectionStateChange).thenReturn(null);
      when(() => mockWebRTC.signalingEvents).thenAnswer((_) => const Stream.empty());
      when(() => mockWebRTC.closeConnection(any())).thenAnswer((_) async {});
      when(() => mockSignaling.isConnected).thenReturn(true);

      client = RelayClient(
        webrtcService: mockWebRTC,
        signalingClient: mockSignaling,
      );
    });

    tearDown(() {
      client.dispose();
    });

    group('mySourceId', () {
      test('should generate unique source ID on initialization', () {
        expect(client.mySourceId, isNotEmpty);
        expect(client.mySourceId.length, greaterThan(10));
      });

      test('should generate different IDs for different clients', () {
        final client2 = RelayClient(
          webrtcService: mockWebRTC,
          signalingClient: mockSignaling,
        );

        expect(client.mySourceId, isNot(equals(client2.mySourceId)));

        client2.dispose();
      });

      test('should maintain consistent source ID across sessions', () {
        final sourceId1 = client.mySourceId;

        // Create new client simulating app restart with saved state
        final client2 = RelayClient(
          webrtcService: mockWebRTC,
          signalingClient: mockSignaling,
          savedSourceId: sourceId1,
        );

        expect(client2.mySourceId, equals(sourceId1));

        client2.dispose();
      });

      test('should only contain alphanumeric characters', () {
        expect(client.mySourceId, matches(RegExp(r'^[a-zA-Z0-9]+$')));
      });
    });

    group('registerSourceId', () {
      test('should register peer source IDs', () {
        client.registerSourceId('peer1', 'peer1_source_xyz');

        expect(client.getSourceId('peer1'), equals('peer1_source_xyz'));
        expect(client.getPeerIdBySourceId('peer1_source_xyz'), equals('peer1'));
      });

      test('should update existing source ID mapping', () {
        client.registerSourceId('peer1', 'old_source');
        client.registerSourceId('peer1', 'new_source');

        expect(client.getSourceId('peer1'), equals('new_source'));
        expect(client.getPeerIdBySourceId('new_source'), equals('peer1'));
        expect(client.getPeerIdBySourceId('old_source'), isNull);
      });

      test('should handle multiple peer registrations', () {
        client.registerSourceId('peer1', 'source_1');
        client.registerSourceId('peer2', 'source_2');
        client.registerSourceId('peer3', 'source_3');

        expect(client.getSourceId('peer1'), equals('source_1'));
        expect(client.getSourceId('peer2'), equals('source_2'));
        expect(client.getSourceId('peer3'), equals('source_3'));
      });
    });

    group('unregisterSourceId', () {
      test('should remove source ID mapping', () {
        client.registerSourceId('peer1', 'source_1');
        expect(client.getSourceId('peer1'), equals('source_1'));

        client.unregisterSourceId('peer1');

        expect(client.getSourceId('peer1'), isNull);
        expect(client.getPeerIdBySourceId('source_1'), isNull);
      });

      test('should handle unregistering non-existent peer', () {
        // Should not throw
        client.unregisterSourceId('non_existent_peer');
      });
    });

    group('getSourceId', () {
      test('should return null for unknown peer', () {
        expect(client.getSourceId('unknown_peer'), isNull);
      });

      test('should return registered source ID', () {
        client.registerSourceId('peer1', 'source_abc');

        expect(client.getSourceId('peer1'), equals('source_abc'));
      });
    });

    group('getPeerIdBySourceId', () {
      test('should return null for unknown source ID', () {
        expect(client.getPeerIdBySourceId('unknown_source'), isNull);
      });

      test('should return peer ID for registered source ID', () {
        client.registerSourceId('peer1', 'source_abc');

        expect(client.getPeerIdBySourceId('source_abc'), equals('peer1'));
      });
    });

    group('handlePeerHandshake', () {
      test('should register source ID from handshake', () {
        final handshake = {'sourceId': 'peer1_source_xyz'};

        client.handlePeerHandshake('peer1', handshake);

        expect(client.getSourceId('peer1'), equals('peer1_source_xyz'));
        expect(client.getPeerIdBySourceId('peer1_source_xyz'), equals('peer1'));
      });

      test('should handle handshake without sourceId', () {
        final handshake = <String, dynamic>{};

        // Should not throw
        client.handlePeerHandshake('peer1', handshake);

        expect(client.getSourceId('peer1'), isNull);
      });

      test('should handle null sourceId in handshake', () {
        final handshake = {'sourceId': null};

        // Should not throw
        client.handlePeerHandshake('peer1', handshake);

        expect(client.getSourceId('peer1'), isNull);
      });
    });

    group('getAllRegisteredPeers', () {
      test('should return empty list when no peers registered', () {
        expect(client.getAllRegisteredPeers(), isEmpty);
      });

      test('should return all registered peer IDs', () {
        client.registerSourceId('peer1', 'source_1');
        client.registerSourceId('peer2', 'source_2');
        client.registerSourceId('peer3', 'source_3');

        final peers = client.getAllRegisteredPeers();
        expect(peers, hasLength(3));
        expect(peers, containsAll(['peer1', 'peer2', 'peer3']));
      });
    });

    group('getAllRegisteredSourceIds', () {
      test('should return empty list when no source IDs registered', () {
        expect(client.getAllRegisteredSourceIds(), isEmpty);
      });

      test('should return all registered source IDs', () {
        client.registerSourceId('peer1', 'source_1');
        client.registerSourceId('peer2', 'source_2');

        final sourceIds = client.getAllRegisteredSourceIds();
        expect(sourceIds, hasLength(2));
        expect(sourceIds, containsAll(['source_1', 'source_2']));
      });
    });

    group('clearAllSourceIdMappings', () {
      test('should clear all mappings', () {
        client.registerSourceId('peer1', 'source_1');
        client.registerSourceId('peer2', 'source_2');

        client.clearAllSourceIdMappings();

        expect(client.getAllRegisteredPeers(), isEmpty);
        expect(client.getAllRegisteredSourceIds(), isEmpty);
      });
    });

    group('isSourceIdRegistered', () {
      test('should return false for unregistered source ID', () {
        expect(client.isSourceIdRegistered('unknown_source'), isFalse);
      });

      test('should return true for registered source ID', () {
        client.registerSourceId('peer1', 'source_1');

        expect(client.isSourceIdRegistered('source_1'), isTrue);
      });
    });

    group('source ID persistence', () {
      test('should export source ID mappings', () {
        client.registerSourceId('peer1', 'source_1');
        client.registerSourceId('peer2', 'source_2');

        final exported = client.exportSourceIdMappings();

        expect(exported, isA<Map<String, String>>());
        expect(exported['peer1'], equals('source_1'));
        expect(exported['peer2'], equals('source_2'));
      });

      test('should import source ID mappings', () {
        final mappings = {
          'peer1': 'source_1',
          'peer2': 'source_2',
        };

        client.importSourceIdMappings(mappings);

        expect(client.getSourceId('peer1'), equals('source_1'));
        expect(client.getSourceId('peer2'), equals('source_2'));
        expect(client.getPeerIdBySourceId('source_1'), equals('peer1'));
        expect(client.getPeerIdBySourceId('source_2'), equals('peer2'));
      });
    });

    group('WebRTC message integration', () {
      test('should send handshake with our source ID on connection', () async {
        final sentMessages = <(String, String)>[];

        when(() => mockWebRTC.sendMessage(any(), any()))
            .thenAnswer((invocation) {
          final peerId = invocation.positionalArguments[0] as String;
          final message = invocation.positionalArguments[1] as String;
          sentMessages.add((peerId, message));
          return Future.value();
        });
        when(() => mockWebRTC.createOffer(any()))
            .thenAnswer((_) async => {'type': 'offer', 'sdp': 'mock_sdp'});

        final relay = RelayInfo(peerId: 'relay1', publicKey: 'pk1');
        await client.connectToRelays([relay]);

        // Check that handshake was sent
        expect(sentMessages.any((m) {
          try {
            final json = jsonDecode(m.$2) as Map<String, dynamic>;
            return json['type'] == 'relay_handshake' &&
                json['sourceId'] == client.mySourceId;
          } catch (_) {
            return false;
          }
        }), isTrue);
      });
    });
  });
}
