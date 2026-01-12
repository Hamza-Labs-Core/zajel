import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../logging/logger_service.dart';

/// Certificate pins for known signaling servers.
/// These should be updated when certificates are rotated.
class CertificatePins {
  /// Cloudflare Workers (*.workers.dev) pins
  static const List<String> cloudflare = [
    'Ao+fWMFrBdoKXPJPJllbL5ZLHQ5Q8zU+5mNCILUGNMM=', // Cloudflare Inc ECC CA-3
    'Y9mvm0exBk1JoQ57f9Vm28jKo5lFm/woKcVxrYxu80o=', // Baltimore CyberTrust Root
    'i7WTqTvh0OioIruIfFR4kMPnBqrS2rdiVPl/s2uC/CY=', // DigiCert Global Root G2
  ];

  /// Zajel VPS servers (*.zajel.app) pins
  static const List<String> zajelApp = [
    'C5+lpZ7tcVwmwQIMcRtPbsQtWLABXhQzejna0wHFr8M=', // ISRG Root X1
    'jQJTbIh0grw0/1TkHSumWb+Fs0Ggogr621gT3PvPKG0=', // Let's Encrypt E1
  ];

  /// Get pins for a given URL
  static List<String> getPinsForUrl(String url) {
    final uri = Uri.parse(url);
    final host = uri.host.toLowerCase();

    if (host.endsWith('.workers.dev')) {
      return cloudflare;
    } else if (host.endsWith('.zajel.app')) {
      return zajelApp;
    }

    // For unknown hosts, return empty (no pinning - will use system trust)
    // This allows connecting to user-specified servers without pinning
    return [];
  }
}

/// WebSocket connection state
enum PinnedWebSocketState {
  disconnected,
  connecting,
  connected,
  error,
}

/// A WebSocket client with certificate pinning support.
///
/// Uses platform channels to leverage native WebSocket implementations
/// with certificate pinning on Android (OkHttp) and iOS (URLSession).
///
/// On web platform, falls back to standard WebSocket (no pinning possible).
class PinnedWebSocket {
  static const MethodChannel _channel = MethodChannel('zajel/pinned_websocket');
  static const EventChannel _eventChannel =
      EventChannel('zajel/pinned_websocket_events');

  final String url;
  final List<String> pins;
  final Duration connectionTimeout;

  final _logger = LoggerService.instance;

  PinnedWebSocketState _state = PinnedWebSocketState.disconnected;
  String? _connectionId;
  StreamSubscription? _eventSubscription;

  final _stateController = StreamController<PinnedWebSocketState>.broadcast();
  final _messageController = StreamController<String>.broadcast();
  final _errorController = StreamController<String>.broadcast();

  /// Current connection state
  PinnedWebSocketState get state => _state;

  /// Stream of connection state changes
  Stream<PinnedWebSocketState> get stateStream => _stateController.stream;

  /// Stream of incoming messages
  Stream<String> get messages => _messageController.stream;

  /// Stream of errors
  Stream<String> get errors => _errorController.stream;

  /// Whether the socket is currently connected
  bool get isConnected => _state == PinnedWebSocketState.connected;

  PinnedWebSocket({
    required this.url,
    List<String>? pins,
    this.connectionTimeout = const Duration(seconds: 30),
  }) : pins = pins ?? CertificatePins.getPinsForUrl(url);

  /// Connect to the WebSocket server with certificate pinning.
  Future<void> connect() async {
    if (_state == PinnedWebSocketState.connected ||
        _state == PinnedWebSocketState.connecting) {
      return;
    }

    _setState(PinnedWebSocketState.connecting);

    try {
      // On web platform, certificate pinning is not possible
      // The browser handles SSL/TLS validation
      if (kIsWeb) {
        _logger.warning(
          'PinnedWebSocket',
          'Certificate pinning not available on web platform',
        );
        // Fall through to native implementation which will throw on web
      }

      // Set up event listener before connecting
      _setupEventListener();

      // Connect via platform channel
      final result = await _channel.invokeMethod<Map<dynamic, dynamic>>(
        'connect',
        {
          'url': url,
          'pins': pins,
          'timeoutMs': connectionTimeout.inMilliseconds,
        },
      );

      if (result != null && result['success'] == true) {
        _connectionId = result['connectionId'] as String?;
        _setState(PinnedWebSocketState.connected);
        _logger.info(
          'PinnedWebSocket',
          'Connected to $url with certificate pinning',
        );
      } else {
        final error = result?['error'] ?? 'Unknown connection error';
        throw PinnedWebSocketException(error.toString());
      }
    } on PlatformException catch (e) {
      _setState(PinnedWebSocketState.error);
      final message = e.message ?? 'Platform error';
      _errorController.add(message);
      _logger.error(
        'PinnedWebSocket',
        'Connection failed: $message',
        e,
      );
      rethrow;
    } catch (e) {
      _setState(PinnedWebSocketState.error);
      _errorController.add(e.toString());
      _logger.error(
        'PinnedWebSocket',
        'Connection failed: $e',
        e,
      );
      rethrow;
    }
  }

  /// Send a message through the WebSocket.
  Future<void> send(String message) async {
    if (_state != PinnedWebSocketState.connected) {
      throw PinnedWebSocketException('Not connected');
    }

    try {
      await _channel.invokeMethod('send', {
        'connectionId': _connectionId,
        'message': message,
      });
    } on PlatformException catch (e) {
      _logger.error(
        'PinnedWebSocket',
        'Send failed: ${e.message}',
        e,
      );
      rethrow;
    }
  }

  /// Close the WebSocket connection.
  Future<void> close() async {
    if (_state == PinnedWebSocketState.disconnected) {
      return;
    }

    try {
      await _eventSubscription?.cancel();
      _eventSubscription = null;

      if (_connectionId != null) {
        await _channel.invokeMethod('close', {
          'connectionId': _connectionId,
        });
      }
    } catch (e) {
      _logger.warning(
        'PinnedWebSocket',
        'Error during close: $e',
      );
    } finally {
      _connectionId = null;
      _setState(PinnedWebSocketState.disconnected);
    }
  }

  /// Dispose resources.
  Future<void> dispose() async {
    await close();
    await _stateController.close();
    await _messageController.close();
    await _errorController.close();
  }

  void _setupEventListener() {
    _eventSubscription?.cancel();
    _eventSubscription = _eventChannel
        .receiveBroadcastStream({'connectionId': _connectionId})
        .listen(
      (event) {
        if (event is Map) {
          final type = event['type'] as String?;
          final connId = event['connectionId'] as String?;

          // Ignore events for other connections
          if (connId != null && connId != _connectionId) {
            return;
          }

          switch (type) {
            case 'message':
              final message = event['data'] as String?;
              if (message != null) {
                _messageController.add(message);
              }
              break;

            case 'connected':
              _setState(PinnedWebSocketState.connected);
              break;

            case 'disconnected':
              _setState(PinnedWebSocketState.disconnected);
              break;

            case 'error':
              final error = event['error'] as String? ?? 'Unknown error';
              _errorController.add(error);
              _setState(PinnedWebSocketState.error);
              break;

            case 'pinning_failed':
              final error =
                  event['error'] as String? ?? 'Certificate pinning failed';
              _errorController.add('PINNING_FAILED: $error');
              _setState(PinnedWebSocketState.error);
              _logger.error(
                'PinnedWebSocket',
                'Certificate pinning failed: $error',
              );
              break;
          }
        }
      },
      onError: (error) {
        _errorController.add(error.toString());
        _setState(PinnedWebSocketState.error);
      },
    );
  }

  void _setState(PinnedWebSocketState newState) {
    if (_state != newState) {
      _state = newState;
      _stateController.add(newState);
    }
  }
}

/// Exception thrown when WebSocket operations fail.
class PinnedWebSocketException implements Exception {
  final String message;

  PinnedWebSocketException(this.message);

  @override
  String toString() => 'PinnedWebSocketException: $message';
}
