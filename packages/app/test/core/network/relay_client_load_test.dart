import 'package:flutter_test/flutter_test.dart';
import 'package:fake_async/fake_async.dart';
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/network/relay_client.dart';
import 'package:zajel/core/network/webrtc_service.dart';
import 'package:zajel/core/network/signaling_client.dart';

// Mock classes
class MockWebRTCService extends Mock implements WebRTCService {}

class MockSignalingClient extends Mock implements SignalingClient {}

void main() {
  group('RelayClient Load Management', () {
    late RelayClient client;
    late MockWebRTCService mockWebRTC;
    late MockSignalingClient mockSignaling;
    late List<Map<String, dynamic>> sentSignalingMessages;

    setUp(() {
      mockWebRTC = MockWebRTCService();
      mockSignaling = MockSignalingClient();
      sentSignalingMessages = [];

      when(() => mockWebRTC.onMessage).thenReturn(null);
      when(() => mockWebRTC.onConnectionStateChange).thenReturn(null);
      when(() => mockWebRTC.onSignalingMessage).thenReturn(null);
      when(() => mockWebRTC.closeConnection(any())).thenAnswer((_) async {});
      when(() => mockSignaling.isConnected).thenReturn(true);

      // Track sent signaling messages
      when(() => mockSignaling.send(any())).thenAnswer((invocation) {
        final message =
            invocation.positionalArguments[0] as Map<String, dynamic>;
        sentSignalingMessages.add(message);
        return Future.value();
      });

      client = RelayClient(
        webrtcService: mockWebRTC,
        signalingClient: mockSignaling,
        maxRelayConnections: 10,
      );
    });

    tearDown(() {
      client.dispose();
    });

    group('reportLoad', () {
      test('should report current connection count to server', () async {
        // Update local load
        client.updateLocalLoad(5);

        sentSignalingMessages.clear();

        // Report load
        await client.reportLoad();

        expect(sentSignalingMessages, hasLength(1));
        expect(sentSignalingMessages[0]['type'], equals('update_load'));
        expect(sentSignalingMessages[0]['connectedCount'], equals(5));
        expect(sentSignalingMessages[0]['sourceId'], equals(client.mySourceId));
      });

      test('should include capacity information in load report', () async {
        client.updateLocalLoad(3);
        client.setMaxCapacity(10);

        sentSignalingMessages.clear();
        await client.reportLoad();

        expect(sentSignalingMessages[0]['connectedCount'], equals(3));
        expect(sentSignalingMessages[0]['maxCapacity'], equals(10));
      });

      test('should report zero load initially', () async {
        await client.reportLoad();

        expect(sentSignalingMessages, hasLength(1));
        expect(sentSignalingMessages[0]['connectedCount'], equals(0));
      });
    });

    group('updateLocalLoad', () {
      test('should track peers using us as relay', () {
        client.updateLocalLoad(3);

        expect(client.currentLoad, equals(3));
      });

      test('should update load to new value', () {
        client.updateLocalLoad(5);
        expect(client.currentLoad, equals(5));

        client.updateLocalLoad(10);
        expect(client.currentLoad, equals(10));

        client.updateLocalLoad(2);
        expect(client.currentLoad, equals(2));
      });

      test('should auto-report when load changes significantly', () async {
        client.autoReportThreshold = 5;

        // Small change - no auto-report
        client.updateLocalLoad(2);
        await Future.delayed(Duration(milliseconds: 10));
        expect(sentSignalingMessages, isEmpty);

        // Larger change from 2 to 10 (diff = 8, > threshold)
        client.updateLocalLoad(10);
        await Future.delayed(Duration(milliseconds: 10));
        expect(sentSignalingMessages, hasLength(1));
        expect(sentSignalingMessages[0]['type'], equals('update_load'));
      });

      test('should auto-report when load decreases significantly', () async {
        client.autoReportThreshold = 5;
        client.updateLocalLoad(15);

        sentSignalingMessages.clear();

        // Large decrease from 15 to 5 (diff = 10, > threshold)
        client.updateLocalLoad(5);
        await Future.delayed(Duration(milliseconds: 10));

        expect(sentSignalingMessages, hasLength(1));
      });

      test('should not auto-report when change is below threshold', () async {
        client.autoReportThreshold = 5;
        client.updateLocalLoad(10);

        sentSignalingMessages.clear();

        // Small change from 10 to 12 (diff = 2, < threshold)
        client.updateLocalLoad(12);
        await Future.delayed(Duration(milliseconds: 10));

        expect(sentSignalingMessages, isEmpty);
      });
    });

    group('incrementLoad and decrementLoad', () {
      test('should increment load by one', () {
        expect(client.currentLoad, equals(0));

        client.incrementLoad();
        expect(client.currentLoad, equals(1));

        client.incrementLoad();
        expect(client.currentLoad, equals(2));
      });

      test('should decrement load by one', () {
        client.updateLocalLoad(5);

        client.decrementLoad();
        expect(client.currentLoad, equals(4));

        client.decrementLoad();
        expect(client.currentLoad, equals(3));
      });

      test('should not decrement below zero', () {
        client.updateLocalLoad(1);
        client.decrementLoad();
        expect(client.currentLoad, equals(0));

        client.decrementLoad();
        expect(client.currentLoad, equals(0));
      });
    });

    group('periodic load reporting', () {
      test('should report load periodically', () {
        fakeAsync((async) {
          client.startPeriodicLoadReporting(
              interval: Duration(seconds: 30));

          // Advance time by 2 minutes
          async.elapse(Duration(minutes: 2));

          // Should report 4 times (every 30 seconds for 2 minutes)
          expect(sentSignalingMessages.length, equals(4));
          for (final msg in sentSignalingMessages) {
            expect(msg['type'], equals('update_load'));
          }
        });
      });

      test('should stop periodic reporting when stopPeriodicLoadReporting is called',
          () {
        fakeAsync((async) {
          client.startPeriodicLoadReporting(
              interval: Duration(seconds: 30));

          // Advance 1 minute
          async.elapse(Duration(minutes: 1));
          expect(sentSignalingMessages.length, equals(2));

          // Stop reporting
          client.stopPeriodicLoadReporting();
          sentSignalingMessages.clear();

          // Advance another minute
          async.elapse(Duration(minutes: 1));
          expect(sentSignalingMessages, isEmpty);
        });
      });

      test('should restart periodic reporting with new interval', () {
        fakeAsync((async) {
          client.startPeriodicLoadReporting(
              interval: Duration(seconds: 30));

          async.elapse(Duration(seconds: 60));
          expect(sentSignalingMessages.length, equals(2));

          // Restart with shorter interval
          client.startPeriodicLoadReporting(
              interval: Duration(seconds: 10));
          sentSignalingMessages.clear();

          async.elapse(Duration(seconds: 60));
          // Should report 6 times (every 10 seconds for 1 minute)
          expect(sentSignalingMessages.length, equals(6));
        });
      });
    });

    group('capacity management', () {
      test('should report if at capacity', () {
        client.setMaxCapacity(5);

        client.updateLocalLoad(3);
        expect(client.isAtCapacity, isFalse);

        client.updateLocalLoad(5);
        expect(client.isAtCapacity, isTrue);

        client.updateLocalLoad(7);
        expect(client.isAtCapacity, isTrue);
      });

      test('should calculate available capacity', () {
        client.setMaxCapacity(10);
        client.updateLocalLoad(3);

        expect(client.availableCapacity, equals(7));
      });

      test('should return zero available capacity when exceeded', () {
        client.setMaxCapacity(5);
        client.updateLocalLoad(8);

        expect(client.availableCapacity, equals(0));
      });

      test('should have unlimited capacity by default', () {
        expect(client.maxCapacity, equals(-1));
        expect(client.isAtCapacity, isFalse);
      });
    });

    group('load event stream', () {
      test('should emit load change events', () async {
        final events = <LoadChangeEvent>[];
        client.onLoadChange.listen(events.add);

        client.updateLocalLoad(5);
        await Future.delayed(Duration(milliseconds: 10));

        expect(events, hasLength(1));
        expect(events[0].previousLoad, equals(0));
        expect(events[0].currentLoad, equals(5));
      });

      test('should emit events for each load change', () async {
        final events = <LoadChangeEvent>[];
        client.onLoadChange.listen(events.add);

        client.updateLocalLoad(3);
        client.updateLocalLoad(7);
        client.updateLocalLoad(2);

        await Future.delayed(Duration(milliseconds: 10));

        expect(events, hasLength(3));
        expect(events[0].currentLoad, equals(3));
        expect(events[1].currentLoad, equals(7));
        expect(events[2].currentLoad, equals(2));
      });
    });
  });
}
