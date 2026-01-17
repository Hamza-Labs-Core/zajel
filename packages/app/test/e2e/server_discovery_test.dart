import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:mocktail/mocktail.dart';
import 'package:zajel/core/network/server_discovery_service.dart';

// Mock HTTP client
class MockHttpClient extends Mock implements http.Client {}

class FakeUri extends Fake implements Uri {}

void main() {
  setUpAll(() {
    registerFallbackValue(FakeUri());
  });

  group('ServerDiscoveryService', () {
    late ServerDiscoveryService discoveryService;
    late MockHttpClient mockClient;

    const testBootstrapUrl = 'https://zajel-bootstrap.example.com';

    setUp(() {
      mockClient = MockHttpClient();
      discoveryService = ServerDiscoveryService(
        bootstrapUrl: testBootstrapUrl,
        client: mockClient,
      );
    });

    tearDown(() {
      discoveryService.dispose();
    });

    group('fetchServers', () {
      test('fetches servers from bootstrap service successfully', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:server1key',
              'endpoint': 'wss://vps1.example.com',
              'publicKey': 'publicKey1Base64',
              'region': 'us-east',
              'registeredAt': now - 60000,
              'lastSeen': now - 30000, // 30 seconds ago (recent)
            },
            {
              'serverId': 'ed25519:server2key',
              'endpoint': 'wss://vps2.example.com',
              'publicKey': 'publicKey2Base64',
              'region': 'eu-west',
              'registeredAt': now - 120000,
              'lastSeen': now - 60000, // 1 minute ago (recent)
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act
        final servers = await discoveryService.fetchServers();

        // Assert
        expect(servers, hasLength(2));
        expect(servers[0].serverId, equals('ed25519:server1key'));
        expect(servers[0].endpoint, equals('wss://vps1.example.com'));
        expect(servers[0].region, equals('us-east'));
        expect(servers[1].serverId, equals('ed25519:server2key'));
        expect(servers[1].region, equals('eu-west'));

        verify(() => mockClient.get(Uri.parse('$testBootstrapUrl/servers')))
            .called(1);
      });

      test('filters out stale servers (not seen recently)', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:freshServer',
              'endpoint': 'wss://fresh.example.com',
              'publicKey': 'freshKey',
              'region': 'us-east',
              'registeredAt': now - 60000,
              'lastSeen': now - 30000, // 30 seconds ago (fresh)
            },
            {
              'serverId': 'ed25519:staleServer',
              'endpoint': 'wss://stale.example.com',
              'publicKey': 'staleKey',
              'region': 'eu-west',
              'registeredAt': now - 600000,
              'lastSeen': now - 300000, // 5 minutes ago (stale - > 2 min)
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act
        final servers = await discoveryService.fetchServers();

        // Assert
        expect(servers, hasLength(1));
        expect(servers[0].serverId, equals('ed25519:freshServer'));
      });

      test('returns cached servers when cache is fresh', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:server1',
              'endpoint': 'wss://vps1.example.com',
              'publicKey': 'key1',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act - first fetch
        await discoveryService.fetchServers();
        // Act - second fetch (should use cache)
        final servers = await discoveryService.fetchServers();

        // Assert - should only call API once
        verify(() => mockClient.get(any())).called(1);
        expect(servers, hasLength(1));
      });

      test('forceRefresh bypasses cache', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:server1',
              'endpoint': 'wss://vps1.example.com',
              'publicKey': 'key1',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act - first fetch
        await discoveryService.fetchServers();
        // Act - second fetch with forceRefresh
        await discoveryService.fetchServers(forceRefresh: true);

        // Assert - should call API twice
        verify(() => mockClient.get(any())).called(2);
      });

      test('handles no servers available gracefully', () async {
        // Arrange
        final serverListResponse = {'servers': []};

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act
        final servers = await discoveryService.fetchServers();

        // Assert
        expect(servers, isEmpty);
      });

      test('returns cached servers on network error', () async {
        // Arrange - first successful fetch
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:cachedServer',
              'endpoint': 'wss://cached.example.com',
              'publicKey': 'cachedKey',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Initial fetch to populate cache
        await discoveryService.fetchServers();

        // Now simulate network error
        when(() => mockClient.get(any())).thenThrow(Exception('Network error'));

        // Act - force refresh with network error
        final servers = await discoveryService.fetchServers(forceRefresh: true);

        // Assert - should return cached servers
        expect(servers, hasLength(1));
        expect(servers[0].serverId, equals('ed25519:cachedServer'));
      });

      test('returns empty list on first fetch failure', () async {
        // Arrange
        when(() => mockClient.get(any())).thenThrow(Exception('Network error'));

        // Act
        final servers = await discoveryService.fetchServers();

        // Assert
        expect(servers, isEmpty);
      });

      test('handles HTTP error status codes', () async {
        // Arrange
        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response('Internal Server Error', 500),
        );

        // Act
        final servers = await discoveryService.fetchServers();

        // Assert - should return empty/cached (graceful degradation)
        expect(servers, isEmpty);
      });

      test('handles timeout gracefully', () async {
        // Arrange
        when(() => mockClient.get(any())).thenAnswer(
          (_) async {
            await Future.delayed(const Duration(seconds: 15));
            return http.Response('{}', 200);
          },
        );

        // Act - should timeout after 10 seconds (configured in service)
        final servers = await discoveryService.fetchServers();

        // Assert - timeout should be handled gracefully
        expect(servers, isEmpty);
      });

      test('handles malformed JSON response', () async {
        // Arrange
        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response('not valid json', 200),
        );

        // Act
        final servers = await discoveryService.fetchServers();

        // Assert - should handle gracefully
        expect(servers, isEmpty);
      });
    });

    group('selectServer', () {
      test('selects a server from available servers', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:server1',
              'endpoint': 'wss://vps1.example.com',
              'publicKey': 'key1',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
            {
              'serverId': 'ed25519:server2',
              'endpoint': 'wss://vps2.example.com',
              'publicKey': 'key2',
              'region': 'eu-west',
              'registeredAt': now,
              'lastSeen': now - 30000,
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act
        final server = await discoveryService.selectServer();

        // Assert
        expect(server, isNotNull);
        expect(server!.serverId, startsWith('ed25519:'));
      });

      test('prefers servers in preferred region', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:usServer',
              'endpoint': 'wss://us.example.com',
              'publicKey': 'usKey',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
            {
              'serverId': 'ed25519:euServer',
              'endpoint': 'wss://eu.example.com',
              'publicKey': 'euKey',
              'region': 'eu-west',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act
        final server =
            await discoveryService.selectServer(preferredRegion: 'eu-west');

        // Assert
        expect(server, isNotNull);
        expect(server!.region, equals('eu-west'));
      });

      test('returns null when no servers available', () async {
        // Arrange
        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response('{"servers": []}', 200),
        );

        // Act
        final server = await discoveryService.selectServer();

        // Assert
        expect(server, isNull);
      });

      test('falls back to any region if preferred region not available',
          () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:usServer',
              'endpoint': 'wss://us.example.com',
              'publicKey': 'usKey',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act - request non-existent region
        final server =
            await discoveryService.selectServer(preferredRegion: 'ap-south');

        // Assert - should still return a server
        expect(server, isNotNull);
        expect(server!.region, equals('us-east'));
      });
    });

    group('getWebSocketUrl', () {
      test('returns endpoint as-is for wss:// URLs', () {
        // Arrange
        final server = DiscoveredServer(
          serverId: 'ed25519:test',
          endpoint: 'wss://example.com',
          publicKey: 'key',
          region: 'us-east',
          registeredAt: 0,
          lastSeen: 0,
        );

        // Act
        final url = discoveryService.getWebSocketUrl(server);

        // Assert
        expect(url, equals('wss://example.com'));
      });

      test('returns endpoint as-is for ws:// URLs', () {
        // Arrange
        final server = DiscoveredServer(
          serverId: 'ed25519:test',
          endpoint: 'ws://example.com',
          publicKey: 'key',
          region: 'us-east',
          registeredAt: 0,
          lastSeen: 0,
        );

        // Act
        final url = discoveryService.getWebSocketUrl(server);

        // Assert
        expect(url, equals('ws://example.com'));
      });

      test('converts https:// to wss://', () {
        // Arrange
        final server = DiscoveredServer(
          serverId: 'ed25519:test',
          endpoint: 'https://example.com',
          publicKey: 'key',
          region: 'us-east',
          registeredAt: 0,
          lastSeen: 0,
        );

        // Act
        final url = discoveryService.getWebSocketUrl(server);

        // Assert
        expect(url, equals('wss://example.com'));
      });

      test('converts http:// to ws://', () {
        // Arrange
        final server = DiscoveredServer(
          serverId: 'ed25519:test',
          endpoint: 'http://example.com',
          publicKey: 'key',
          region: 'us-east',
          registeredAt: 0,
          lastSeen: 0,
        );

        // Act
        final url = discoveryService.getWebSocketUrl(server);

        // Assert
        expect(url, equals('ws://example.com'));
      });

      test('prepends wss:// for bare hostnames', () {
        // Arrange
        final server = DiscoveredServer(
          serverId: 'ed25519:test',
          endpoint: 'example.com',
          publicKey: 'key',
          region: 'us-east',
          registeredAt: 0,
          lastSeen: 0,
        );

        // Act
        final url = discoveryService.getWebSocketUrl(server);

        // Assert
        expect(url, equals('wss://example.com'));
      });
    });

    group('servers stream', () {
      test('emits updated server list on fetch', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:server1',
              'endpoint': 'wss://vps1.example.com',
              'publicKey': 'key1',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act & Assert
        final serversFuture = discoveryService.servers.first;
        await discoveryService.fetchServers();
        final servers = await serversFuture;

        expect(servers, hasLength(1));
        expect(servers[0].serverId, equals('ed25519:server1'));
      });
    });

    group('cachedServers', () {
      test('returns empty list initially', () {
        expect(discoveryService.cachedServers, isEmpty);
      });

      test('returns cached servers after fetch', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:cached',
              'endpoint': 'wss://cached.example.com',
              'publicKey': 'key',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response(jsonEncode(serverListResponse), 200),
        );

        // Act
        await discoveryService.fetchServers();

        // Assert
        expect(discoveryService.cachedServers, hasLength(1));
        expect(discoveryService.cachedServers[0].serverId,
            equals('ed25519:cached'));
      });

      test('cachedServers is unmodifiable', () {
        expect(
          () => discoveryService.cachedServers.add(
            DiscoveredServer(
              serverId: 'test',
              endpoint: 'test',
              publicKey: 'test',
              region: 'test',
              registeredAt: 0,
              lastSeen: 0,
            ),
          ),
          throwsUnsupportedError,
        );
      });
    });

    group('periodic refresh', () {
      test('startPeriodicRefresh triggers periodic fetches', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        var callCount = 0;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:server',
              'endpoint': 'wss://example.com',
              'publicKey': 'key',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer((_) async {
          callCount++;
          return http.Response(jsonEncode(serverListResponse), 200);
        });

        // Act
        discoveryService.startPeriodicRefresh(
          interval: const Duration(milliseconds: 100),
        );

        // Wait for multiple intervals
        await Future.delayed(const Duration(milliseconds: 350));
        discoveryService.stopPeriodicRefresh();

        // Assert - should have called at least 2 times (100ms intervals over 350ms)
        // Note: first call is at 100ms, second at 200ms, third at 300ms
        expect(callCount, greaterThanOrEqualTo(2));
      });

      test('stopPeriodicRefresh stops refresh timer', () async {
        // Arrange
        final now = DateTime.now().millisecondsSinceEpoch;
        var callCount = 0;
        final serverListResponse = {
          'servers': [
            {
              'serverId': 'ed25519:server',
              'endpoint': 'wss://example.com',
              'publicKey': 'key',
              'region': 'us-east',
              'registeredAt': now,
              'lastSeen': now,
            },
          ],
        };

        when(() => mockClient.get(any())).thenAnswer((_) async {
          callCount++;
          return http.Response(jsonEncode(serverListResponse), 200);
        });

        // Act
        discoveryService.startPeriodicRefresh(
          interval: const Duration(milliseconds: 50),
        );
        await Future.delayed(const Duration(milliseconds: 75));
        final countAfterFirst = callCount;
        discoveryService.stopPeriodicRefresh();
        await Future.delayed(const Duration(milliseconds: 100));

        // Assert - count should not increase after stop
        expect(callCount, equals(countAfterFirst));
      });
    });

    group('bootstrap URL configuration', () {
      test('uses configured bootstrap URL', () async {
        // Arrange
        const customUrl = 'https://custom-bootstrap.example.com';
        final customService = ServerDiscoveryService(
          bootstrapUrl: customUrl,
          client: mockClient,
        );

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response('{"servers": []}', 200),
        );

        // Act
        await customService.fetchServers();

        // Assert
        verify(() => mockClient.get(Uri.parse('$customUrl/servers'))).called(1);

        customService.dispose();
      });

      test('different bootstrap URLs result in different API calls', () async {
        // Arrange
        const url1 = 'https://bootstrap1.example.com';
        const url2 = 'https://bootstrap2.example.com';

        final service1 = ServerDiscoveryService(
          bootstrapUrl: url1,
          client: mockClient,
        );
        final service2 = ServerDiscoveryService(
          bootstrapUrl: url2,
          client: mockClient,
        );

        when(() => mockClient.get(any())).thenAnswer(
          (_) async => http.Response('{"servers": []}', 200),
        );

        // Act
        await service1.fetchServers();
        await service2.fetchServers();

        // Assert
        verify(() => mockClient.get(Uri.parse('$url1/servers'))).called(1);
        verify(() => mockClient.get(Uri.parse('$url2/servers'))).called(1);

        service1.dispose();
        service2.dispose();
      });
    });
  });

  group('DiscoveredServer', () {
    test('fromJson creates server correctly', () {
      // Arrange
      final json = {
        'serverId': 'ed25519:testServer',
        'endpoint': 'wss://test.example.com',
        'publicKey': 'testPublicKey==',
        'region': 'us-west',
        'registeredAt': 1700000000000,
        'lastSeen': 1700000060000,
      };

      // Act
      final server = DiscoveredServer.fromJson(json);

      // Assert
      expect(server.serverId, equals('ed25519:testServer'));
      expect(server.endpoint, equals('wss://test.example.com'));
      expect(server.publicKey, equals('testPublicKey=='));
      expect(server.region, equals('us-west'));
      expect(server.registeredAt, equals(1700000000000));
      expect(server.lastSeen, equals(1700000060000));
    });

    test('fromJson handles missing optional fields', () {
      // Arrange
      final json = {
        'serverId': 'ed25519:testServer',
        'endpoint': 'wss://test.example.com',
        'publicKey': 'testPublicKey==',
        // Missing region, registeredAt, lastSeen
      };

      // Act
      final server = DiscoveredServer.fromJson(json);

      // Assert
      expect(server.region, equals('unknown'));
      expect(server.registeredAt, equals(0));
      expect(server.lastSeen, equals(0));
    });

    test('isRecent returns true for recently seen servers', () {
      // Arrange
      final now = DateTime.now().millisecondsSinceEpoch;
      final server = DiscoveredServer(
        serverId: 'test',
        endpoint: 'wss://test.com',
        publicKey: 'key',
        region: 'us-east',
        registeredAt: now,
        lastSeen: now - 60000, // 1 minute ago
      );

      // Assert
      expect(server.isRecent, isTrue);
    });

    test('isRecent returns false for stale servers', () {
      // Arrange
      final now = DateTime.now().millisecondsSinceEpoch;
      final server = DiscoveredServer(
        serverId: 'test',
        endpoint: 'wss://test.com',
        publicKey: 'key',
        region: 'us-east',
        registeredAt: now,
        lastSeen: now - 180000, // 3 minutes ago (> 2 min threshold)
      );

      // Assert
      expect(server.isRecent, isFalse);
    });

    test('toString provides useful debug output', () {
      // Arrange
      final server = DiscoveredServer(
        serverId: 'ed25519:debug',
        endpoint: 'wss://debug.example.com',
        publicKey: 'key',
        region: 'debug-region',
        registeredAt: 0,
        lastSeen: 0,
      );

      // Act
      final str = server.toString();

      // Assert
      expect(str, contains('ed25519:debug'));
      expect(str, contains('wss://debug.example.com'));
      expect(str, contains('debug-region'));
    });
  });
}
