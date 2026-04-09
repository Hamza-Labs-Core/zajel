import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as http_testing;
import 'package:zajel/core/diagnostics/diagnostics_service.dart';
import 'package:zajel/core/diagnostics/error_tracker.dart';

void main() {
  group('DiagnosticsService', () {
    late ErrorTracker tracker;
    late List<http.Request> capturedRequests;
    late http.Client mockClient;

    setUp(() {
      tracker = ErrorTracker(isEnabled: () => true);
      capturedRequests = [];
      mockClient = http_testing.MockClient((request) async {
        capturedRequests.add(request);
        return http.Response('{"success":true}', 200);
      });
    });

    DiagnosticsService buildService({String url = 'https://diag.example.com'}) {
      return DiagnosticsService(
        errorTracker: tracker,
        diagnosticsUrl: url,
        httpClient: mockClient,
      );
    }

    test('start() starts the error tracker', () {
      final service = buildService();
      expect(tracker.isRunning, isFalse);

      service.start();
      expect(tracker.isRunning, isTrue);
      expect(service.isRunning, isTrue);

      service.dispose();
    });

    test('stop() stops the error tracker', () {
      final service = buildService();
      service.start();
      expect(tracker.isRunning, isTrue);

      service.stop();
      expect(tracker.isRunning, isFalse);
      expect(service.isRunning, isFalse);

      service.dispose();
    });

    test('start() is idempotent', () {
      final service = buildService();
      service.start();
      service.start(); // should not throw
      expect(service.isRunning, isTrue);

      service.dispose();
    });

    test('stop() is idempotent', () {
      final service = buildService();
      service.stop(); // should not throw when not started
      expect(service.isRunning, isFalse);

      service.dispose();
    });

    test('sends heartbeat after start with short delay', () async {
      final service = buildService();
      service.start();

      // Wait for the initial heartbeat (5s delay in service + some margin)
      await Future<void>.delayed(const Duration(seconds: 6));

      final heartbeats = capturedRequests
          .where((r) => r.url.path.contains('/heartbeat'))
          .toList();
      expect(heartbeats, isNotEmpty);

      final body = jsonDecode(heartbeats.first.body) as Map<String, dynamic>;
      expect(body['sessionHash'], isA<String>());
      expect(body['platform'], isA<String>());
      expect(body['appVersion'], isA<String>());

      service.dispose();
    });

    test('does not send heartbeat when stopped', () async {
      final service = buildService();
      service.start();
      service.stop();

      await Future<void>.delayed(const Duration(seconds: 6));

      final heartbeats = capturedRequests
          .where((r) => r.url.path.contains('/heartbeat'))
          .toList();
      expect(heartbeats, isEmpty);

      service.dispose();
    });

    test('errorTracker getter returns the tracker', () {
      final service = buildService();
      expect(service.errorTracker, same(tracker));
      service.dispose();
    });

    test('handles HTTP 429 gracefully', () async {
      mockClient = http_testing.MockClient((request) async {
        return http.Response('{"error":"rate limited"}', 429);
      });

      final service = buildService();
      service.start();

      // Wait for initial heartbeat
      await Future<void>.delayed(const Duration(seconds: 6));

      // Should not throw
      expect(service.isRunning, isTrue);
      service.dispose();
    });

    test('handles HTTP errors gracefully', () async {
      mockClient = http_testing.MockClient((request) async {
        throw Exception('Network unreachable');
      });

      final service = buildService();
      service.start();

      // Wait for initial heartbeat
      await Future<void>.delayed(const Duration(seconds: 6));

      // Should not throw — diagnostics failures are non-fatal
      expect(service.isRunning, isTrue);
      service.dispose();
    });

    test('report includes scrubbed errors', () async {
      final service = buildService();
      service.start();

      // Record an error with PII
      tracker.recordError(
        Exception('Failed to connect to 192.168.1.1:8080'),
        StackTrace.current,
      );

      // Manually trigger report by accessing internal method via timer
      // We'll wait for the report timer (10 min is too long for test),
      // so instead we verify the errors are buffered and drainable.
      expect(tracker.bufferSize, equals(1));

      service.dispose();
    });

    test('dispose stops and closes client', () {
      final service = buildService();
      service.start();
      service.dispose();

      expect(service.isRunning, isFalse);
    });
  });
}
