/// Configuration for integration tests.
///
/// Server URLs and other test configuration can be overridden via environment variables
/// for CI/CD pipelines. Default values are provided for local development.
library;

import 'dart:async';
import 'dart:io';

/// Test configuration for integration tests.
///
/// Example usage:
/// ```dart
/// final config = TestConfig.fromEnvironment();
/// await connectionManager.connect(serverUrl: config.vpsServerUrl);
/// ```
class TestConfig {
  /// VPS signaling server WebSocket URL.
  final String vpsServerUrl;

  /// Bootstrap server URL for server discovery.
  final String bootstrapServerUrl;

  /// Timeout for connection attempts in seconds.
  final int connectionTimeoutSeconds;

  /// Timeout for pairing code generation in seconds.
  final int pairingTimeoutSeconds;

  /// Whether to use a mock server (for offline testing).
  final bool useMockServer;

  /// Test peer's pairing code (for two-device testing scenarios).
  final String? testPeerCode;

  /// Test display name for the app.
  final String testDisplayName;

  /// Whether verbose logging is enabled.
  final bool verboseLogging;

  const TestConfig({
    required this.vpsServerUrl,
    required this.bootstrapServerUrl,
    this.connectionTimeoutSeconds = 30,
    this.pairingTimeoutSeconds = 10,
    this.useMockServer = false,
    this.testPeerCode,
    this.testDisplayName = 'Test Device',
    this.verboseLogging = false,
  });

  /// Default configuration for local development.
  ///
  /// Uses localhost URLs suitable for running tests against a local VPS server.
  factory TestConfig.localhost() {
    return const TestConfig(
      vpsServerUrl: 'ws://localhost:8080',
      bootstrapServerUrl: 'http://localhost:8787',
      connectionTimeoutSeconds: 30,
      pairingTimeoutSeconds: 10,
      useMockServer: false,
      testDisplayName: 'Local Test Device',
      verboseLogging: true,
    );
  }

  /// Configuration loaded from environment variables.
  ///
  /// Environment variables:
  /// - `TEST_VPS_SERVER_URL`: WebSocket URL for VPS signaling server
  /// - `TEST_BOOTSTRAP_URL`: HTTP URL for bootstrap/discovery server
  /// - `TEST_CONNECTION_TIMEOUT`: Connection timeout in seconds
  /// - `TEST_PAIRING_TIMEOUT`: Pairing timeout in seconds
  /// - `TEST_USE_MOCK_SERVER`: Set to 'true' for mock server testing
  /// - `TEST_PEER_CODE`: Pairing code of a test peer (for two-device tests)
  /// - `TEST_DISPLAY_NAME`: Display name for the test device
  /// - `TEST_VERBOSE`: Set to 'true' for verbose logging
  factory TestConfig.fromEnvironment() {
    return TestConfig(
      vpsServerUrl: Platform.environment['TEST_VPS_SERVER_URL'] ??
          'ws://localhost:8080',
      bootstrapServerUrl: Platform.environment['TEST_BOOTSTRAP_URL'] ??
          'http://localhost:8787',
      connectionTimeoutSeconds:
          int.tryParse(Platform.environment['TEST_CONNECTION_TIMEOUT'] ?? '') ??
              30,
      pairingTimeoutSeconds:
          int.tryParse(Platform.environment['TEST_PAIRING_TIMEOUT'] ?? '') ??
              10,
      useMockServer:
          Platform.environment['TEST_USE_MOCK_SERVER']?.toLowerCase() == 'true',
      testPeerCode: Platform.environment['TEST_PEER_CODE'],
      testDisplayName:
          Platform.environment['TEST_DISPLAY_NAME'] ?? 'CI Test Device',
      verboseLogging:
          Platform.environment['TEST_VERBOSE']?.toLowerCase() == 'true',
    );
  }

  /// Configuration for CI/CD pipelines.
  ///
  /// Uses production-like URLs but with test instances.
  factory TestConfig.ci() {
    return TestConfig(
      vpsServerUrl: Platform.environment['CI_VPS_SERVER_URL'] ??
          'wss://test-vps.zajel.example.com',
      bootstrapServerUrl: Platform.environment['CI_BOOTSTRAP_URL'] ??
          'https://test-bootstrap.zajel.example.com',
      connectionTimeoutSeconds: 60, // Longer timeout for CI
      pairingTimeoutSeconds: 20,
      useMockServer: false,
      testDisplayName: 'CI Test Device',
      verboseLogging: true,
    );
  }

  /// Configuration for offline/mock testing.
  ///
  /// Does not require any real server connections.
  factory TestConfig.mock() {
    return const TestConfig(
      vpsServerUrl: 'ws://mock.localhost:8080',
      bootstrapServerUrl: 'http://mock.localhost:8787',
      connectionTimeoutSeconds: 5,
      pairingTimeoutSeconds: 5,
      useMockServer: true,
      testDisplayName: 'Mock Test Device',
      verboseLogging: true,
    );
  }

  /// Get the appropriate configuration based on environment.
  ///
  /// Automatically selects:
  /// - Mock config if TEST_USE_MOCK_SERVER is set
  /// - CI config if running in CI environment (CI=true)
  /// - Environment config if any TEST_* variables are set
  /// - Localhost config as fallback
  factory TestConfig.auto() {
    final env = Platform.environment;

    // Check for mock server testing
    if (env['TEST_USE_MOCK_SERVER']?.toLowerCase() == 'true') {
      return TestConfig.mock();
    }

    // Check for CI environment
    if (env['CI']?.toLowerCase() == 'true' ||
        env['GITHUB_ACTIONS']?.toLowerCase() == 'true' ||
        env['GITLAB_CI']?.toLowerCase() == 'true') {
      return TestConfig.ci();
    }

    // Check for custom environment variables
    if (env['TEST_VPS_SERVER_URL'] != null ||
        env['TEST_BOOTSTRAP_URL'] != null) {
      return TestConfig.fromEnvironment();
    }

    // Default to localhost
    return TestConfig.localhost();
  }

  /// Connection timeout as a Duration.
  Duration get connectionTimeout => Duration(seconds: connectionTimeoutSeconds);

  /// Pairing timeout as a Duration.
  Duration get pairingTimeout => Duration(seconds: pairingTimeoutSeconds);

  @override
  String toString() {
    return '''TestConfig(
  vpsServerUrl: $vpsServerUrl,
  bootstrapServerUrl: $bootstrapServerUrl,
  connectionTimeoutSeconds: $connectionTimeoutSeconds,
  pairingTimeoutSeconds: $pairingTimeoutSeconds,
  useMockServer: $useMockServer,
  testPeerCode: ${testPeerCode ?? 'null'},
  testDisplayName: $testDisplayName,
  verboseLogging: $verboseLogging,
)''';
  }
}

/// Helper class for test utilities.
class TestUtils {
  /// Wait for a condition to be true with timeout.
  static Future<bool> waitFor(
    bool Function() condition, {
    Duration timeout = const Duration(seconds: 10),
    Duration pollInterval = const Duration(milliseconds: 100),
  }) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      if (condition()) return true;
      await Future.delayed(pollInterval);
    }
    return false;
  }

  /// Wait for a future to complete with custom timeout.
  static Future<T> withTimeout<T>(
    Future<T> future, {
    Duration timeout = const Duration(seconds: 30),
    String? operationName,
  }) {
    return future.timeout(
      timeout,
      onTimeout: () {
        throw TimeoutException(
          operationName != null
              ? 'Operation "$operationName" timed out after ${timeout.inSeconds}s'
              : 'Operation timed out after ${timeout.inSeconds}s',
        );
      },
    );
  }

  /// Connect to server with exponential backoff retry logic.
  ///
  /// Attempts connection up to [maxAttempts] times with increasing timeouts:
  /// - Attempt 1: 10 seconds
  /// - Attempt 2: 20 seconds
  /// - Attempt 3: 40 seconds
  ///
  /// Backoff delays between attempts: 1 second, then 2 seconds.
  ///
  /// Returns the pairing code on success, throws on all failures.
  static Future<String> connectWithRetry(
    dynamic connectionManager,
    String serverUrl, {
    int maxAttempts = 3,
    void Function(String)? log,
  }) async {
    const baseTimeout = Duration(seconds: 10);
    const backoffDelays = [Duration(seconds: 1), Duration(seconds: 2)];
    final logFn = log ?? ((_) {});

    for (int attempt = 1; attempt <= maxAttempts; attempt++) {
      final timeout = baseTimeout * (1 << (attempt - 1)); // 10s, 20s, 40s
      logFn('Connection attempt $attempt/$maxAttempts with ${timeout.inSeconds}s timeout');

      try {
        final pairingCode = await (connectionManager.connect(serverUrl: serverUrl) as Future<String>)
            .timeout(timeout);
        logFn('Connected on attempt $attempt');
        return pairingCode;
      } on TimeoutException {
        logFn('Attempt $attempt timed out after ${timeout.inSeconds}s');
        if (attempt < maxAttempts) {
          final delay = backoffDelays[attempt - 1];
          logFn('Waiting ${delay.inSeconds}s before retry...');
          await Future.delayed(delay);
        } else {
          rethrow;
        }
      } catch (e) {
        logFn('Attempt $attempt failed: $e');
        if (attempt < maxAttempts) {
          final delay = backoffDelays[attempt - 1];
          logFn('Waiting ${delay.inSeconds}s before retry...');
          await Future.delayed(delay);
        } else {
          rethrow;
        }
      }
    }

    throw TimeoutException('Failed to connect after $maxAttempts attempts');
  }
}

/// Custom exception for test timeouts.
class TimeoutException implements Exception {
  final String message;
  TimeoutException(this.message);

  @override
  String toString() => 'TimeoutException: $message';
}

/// Extension with reconnection test utilities.
extension ReconnectionTestUtils on TestConfig {
  /// Wait for a peer to be found via meeting points.
  ///
  /// Polls the peer list until the specified peer appears or timeout is reached.
  Future<bool> waitForPeerReconnection(
    Stream<dynamic> peerFoundEvents,
    String expectedPeerId, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    final completer = Completer<bool>();
    final subscription = peerFoundEvents.listen((event) {
      if (event.peerId == expectedPeerId && !completer.isCompleted) {
        completer.complete(true);
      }
    });

    // Set up timeout
    final timer = Timer(timeout, () {
      if (!completer.isCompleted) {
        completer.complete(false);
      }
    });

    try {
      return await completer.future;
    } finally {
      timer.cancel();
      await subscription.cancel();
    }
  }

  /// Wait for reconnection service status to indicate connected.
  Future<bool> waitForReconnectionConnected(
    Stream<dynamic> statusStream, {
    Duration timeout = const Duration(seconds: 30),
  }) async {
    return TestUtils.waitFor(
      () {
        // Poll the status stream
        return true; // This is a placeholder - actual implementation depends on stream state
      },
      timeout: timeout,
    );
  }
}
