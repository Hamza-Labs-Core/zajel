import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/models/peer.dart';
import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/features/home/home_screen.dart';

import '../mocks/mocks.dart';

void main() {
  late MockConnectionManager mockConnectionManager;

  setUp(() {
    mockConnectionManager = MockConnectionManager();
  });

  Widget createTestWidget({
    List<Peer>? peers,
    bool isLoading = false,
    Object? error,
    String displayName = 'Test User',
  }) {
    // Create a stream that emits the peers
    final peersStream = Stream<List<Peer>>.value(peers ?? []);

    when(() => mockConnectionManager.peers).thenAnswer((_) => peersStream);

    return ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(
          FakeSharedPreferences(),
        ),
        displayNameProvider.overrideWith((ref) => displayName),
        pairingCodeProvider.overrideWith((ref) => 'ABC123'),
        connectionManagerProvider.overrideWithValue(mockConnectionManager),
        peersProvider.overrideWith((ref) {
          if (error != null) {
            return Stream<List<Peer>>.error(error);
          }
          if (isLoading) {
            return const Stream<List<Peer>>.empty();
          }
          return Stream.value(peers ?? []);
        }),
      ],
      child: const MaterialApp(
        home: HomeScreen(),
      ),
    );
  }

  group('HomeScreen', () {
    testWidgets('displays app title in app bar', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Zajel'), findsOneWidget);
    });

    testWidgets('displays user display name', (tester) async {
      await tester.pumpWidget(createTestWidget(displayName: 'Alice'));
      await tester.pump();

      expect(find.text('Alice'), findsOneWidget);
    });

    testWidgets('displays pairing code', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Code: ABC123'), findsOneWidget);
    });

    testWidgets('displays "Nearby Devices" header', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Nearby Devices'), findsOneWidget);
    });

    testWidgets('shows loading indicator when loading', (tester) async {
      await tester.pumpWidget(createTestWidget(isLoading: true));
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
    });

    testWidgets('shows empty state when no peers', (tester) async {
      await tester.pumpWidget(createTestWidget(peers: []));
      await tester.pump();

      expect(find.text('No devices found'), findsOneWidget);
      expect(
        find.text('Make sure other devices with Zajel are on the same network'),
        findsOneWidget,
      );
    });

    testWidgets('shows QR code button in empty state', (tester) async {
      await tester.pumpWidget(createTestWidget(peers: []));
      await tester.pump();

      expect(find.text('Connect via QR code'), findsOneWidget);
    });

    testWidgets('shows error state with retry button', (tester) async {
      await tester.pumpWidget(createTestWidget(error: 'Network error'));
      await tester.pump();

      expect(find.text('Retry'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline), findsOneWidget);
    });

    testWidgets('displays peer list when peers available', (tester) async {
      final peers = [
        Peer(
          id: 'peer-1',
          displayName: 'Bob',
          connectionState: PeerConnectionState.disconnected,
          lastSeen: DateTime.now(),
          isLocal: true,
        ),
        Peer(
          id: 'peer-2',
          displayName: 'Charlie',
          connectionState: PeerConnectionState.connected,
          lastSeen: DateTime.now(),
          isLocal: true,
        ),
      ];

      await tester.pumpWidget(createTestWidget(peers: peers));
      await tester.pump();

      expect(find.text('Bob'), findsOneWidget);
      expect(find.text('Charlie'), findsOneWidget);
    });

    testWidgets('shows Connect button for disconnected peers', (tester) async {
      final peers = [
        Peer(
          id: 'peer-1',
          displayName: 'Bob',
          connectionState: PeerConnectionState.disconnected,
          lastSeen: DateTime.now(),
          isLocal: true,
        ),
      ];

      await tester.pumpWidget(createTestWidget(peers: peers));
      await tester.pump();

      // There may be multiple "Connect" texts (peer tile + FAB)
      expect(find.text('Connect'), findsWidgets);
    });

    testWidgets('shows chat icon for connected peers', (tester) async {
      final peers = [
        Peer(
          id: 'peer-1',
          displayName: 'Bob',
          connectionState: PeerConnectionState.connected,
          lastSeen: DateTime.now(),
          isLocal: true,
        ),
      ];

      await tester.pumpWidget(createTestWidget(peers: peers));
      await tester.pump();

      expect(find.byIcon(Icons.chat), findsOneWidget);
    });

    testWidgets('shows loading spinner for connecting peers', (tester) async {
      final peers = [
        Peer(
          id: 'peer-1',
          displayName: 'Bob',
          connectionState: PeerConnectionState.connecting,
          lastSeen: DateTime.now(),
          isLocal: true,
        ),
      ];

      await tester.pumpWidget(createTestWidget(peers: peers));
      await tester.pump();

      // Should show small loading spinner in the trailing area
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Connecting...'), findsOneWidget);
    });

    testWidgets('shows "Connected" status for connected peers', (tester) async {
      final peers = [
        Peer(
          id: 'peer-1',
          displayName: 'Bob',
          connectionState: PeerConnectionState.connected,
          lastSeen: DateTime.now(),
          isLocal: true,
        ),
      ];

      await tester.pumpWidget(createTestWidget(peers: peers));
      await tester.pump();

      expect(find.text('Connected'), findsOneWidget);
    });

    testWidgets('has settings button in app bar', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.byIcon(Icons.settings), findsOneWidget);
    });

    testWidgets('has QR scanner button in app bar', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.byIcon(Icons.qr_code_scanner), findsOneWidget);
    });

    testWidgets('has floating action button for connect', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.byType(FloatingActionButton), findsOneWidget);
      expect(find.text('Connect'), findsWidgets); // FAB + possibly empty state
    });

    testWidgets('displays Discovering status indicator', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Discovering'), findsOneWidget);
    });
  });
}

/// Fake SharedPreferences for testing
class FakeSharedPreferences implements SharedPreferences {
  final Map<String, Object> _data = {};

  @override
  String? getString(String key) => _data[key] as String?;

  @override
  Future<bool> setString(String key, String value) async {
    _data[key] = value;
    return true;
  }

  @override
  bool? getBool(String key) => _data[key] as bool?;

  @override
  Future<bool> setBool(String key, bool value) async {
    _data[key] = value;
    return true;
  }

  @override
  int? getInt(String key) => _data[key] as int?;

  @override
  Future<bool> setInt(String key, int value) async {
    _data[key] = value;
    return true;
  }

  @override
  double? getDouble(String key) => _data[key] as double?;

  @override
  Future<bool> setDouble(String key, double value) async {
    _data[key] = value;
    return true;
  }

  @override
  List<String>? getStringList(String key) => _data[key] as List<String>?;

  @override
  Future<bool> setStringList(String key, List<String> value) async {
    _data[key] = value;
    return true;
  }

  @override
  bool containsKey(String key) => _data.containsKey(key);

  @override
  Object? get(String key) => _data[key];

  @override
  Set<String> getKeys() => _data.keys.toSet();

  @override
  Future<bool> remove(String key) async {
    _data.remove(key);
    return true;
  }

  @override
  Future<bool> clear() async {
    _data.clear();
    return true;
  }

  @override
  Future<void> reload() async {}

  @override
  Future<bool> commit() async => true;
}
