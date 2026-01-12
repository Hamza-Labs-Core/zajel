import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:mocktail/mocktail.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/network/connection_manager.dart';
import 'package:zajel/core/network/meeting_point_service.dart';
import 'package:zajel/core/network/rendezvous_service.dart';
import 'package:zajel/core/network/signaling_client.dart';
import 'package:zajel/core/network/webrtc_service.dart';
import 'package:zajel/core/network/device_link_service.dart';
import 'package:zajel/core/storage/trusted_peers_storage.dart';

// Mock classes
class MockFlutterSecureStorage extends Mock implements FlutterSecureStorage {}

class MockCryptoService extends Mock implements CryptoService {}

class MockConnectionManager extends Mock implements ConnectionManager {}

class MockMeetingPointService extends Mock implements MeetingPointService {}

class MockTrustedPeersStorage extends Mock implements TrustedPeersStorage {}

class MockRendezvousService extends Mock implements RendezvousService {}

class MockWebRTCService extends Mock implements WebRTCService {}

class MockSignalingClient extends Mock implements SignalingClient {}

class MockDeviceLinkService extends Mock implements DeviceLinkService {}

class MockWebSocketChannel extends Mock implements WebSocketChannel {}

class MockWebSocketSink extends Mock implements WebSocketSink {}

/// A fake WebSocket channel for testing that allows controlling message flow
class FakeWebSocketChannel implements WebSocketChannel {
  final _streamController = StreamController<dynamic>.broadcast();
  final _sinkController = StreamController<dynamic>();
  late final FakeWebSocketSink _sink;
  bool _isReady = true;
  Object? _readyError;

  FakeWebSocketChannel() {
    _sink = FakeWebSocketSink(_sinkController);
  }

  /// Simulate receiving a message from the server
  void addMessage(dynamic message) {
    _streamController.add(message);
  }

  /// Simulate an error
  void addError(Object error) {
    _streamController.addError(error);
  }

  /// Simulate connection close
  void simulateClose() {
    _streamController.close();
  }

  /// Set whether the channel is ready
  void setReady(bool ready, [Object? error]) {
    _isReady = ready;
    _readyError = error;
  }

  /// Get sent messages from the sink
  List<dynamic> get sentMessages => _sink.sentMessages;

  @override
  Stream get stream => _streamController.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  Future<void> get ready async {
    if (!_isReady) {
      throw _readyError ?? Exception('WebSocket not ready');
    }
  }

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  String? get protocol => null;

  // StreamChannel interface methods - not needed for our tests
  @override
  dynamic noSuchMethod(Invocation invocation) {
    // Handle StreamChannel methods that we don't need for testing
    final methodName = invocation.memberName.toString();
    if (methodName.contains('cast') ||
        methodName.contains('changeSink') ||
        methodName.contains('changeStream') ||
        methodName.contains('pipe') ||
        methodName.contains('transform')) {
      throw UnimplementedError('$methodName not implemented in FakeWebSocketChannel');
    }
    return super.noSuchMethod(invocation);
  }

  void dispose() {
    _streamController.close();
    _sinkController.close();
  }
}

class FakeWebSocketSink implements WebSocketSink {
  final StreamController<dynamic> _controller;
  final List<dynamic> sentMessages = [];

  FakeWebSocketSink(this._controller);

  @override
  void add(dynamic data) {
    sentMessages.add(data);
    _controller.add(data);
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) {
    _controller.addError(error, stackTrace);
  }

  @override
  Future addStream(Stream stream) async {
    await for (final data in stream) {
      add(data);
    }
  }

  @override
  Future close([int? closeCode, String? closeReason]) async {
    await _controller.close();
  }

  @override
  Future get done => _controller.done;
}

/// In-memory implementation of FlutterSecureStorage for testing
class FakeSecureStorage implements FlutterSecureStorage {
  final Map<String, String> _storage = {};

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value != null) {
      _storage[key] = value;
    } else {
      _storage.remove(key);
    }
  }

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    return _storage[key];
  }

  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    _storage.remove(key);
  }

  @override
  Future<Map<String, String>> readAll({
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    return Map.from(_storage);
  }

  @override
  Future<void> deleteAll({
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    _storage.clear();
  }

  @override
  Future<bool> containsKey({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    return _storage.containsKey(key);
  }

  @override
  IOSOptions get iOptions => IOSOptions.defaultOptions;

  @override
  AndroidOptions get aOptions => AndroidOptions.defaultOptions;

  @override
  LinuxOptions get lOptions => LinuxOptions.defaultOptions;

  @override
  WebOptions get webOptions => WebOptions.defaultOptions;

  @override
  MacOsOptions get mOptions => MacOsOptions.defaultOptions;

  @override
  WindowsOptions get wOptions => WindowsOptions.defaultOptions;

  @override
  Future<bool> isCupertinoProtectedDataAvailable() async => true;

  @override
  Stream<bool> get onCupertinoProtectedDataAvailabilityChanged =>
      Stream.value(true);

  @override
  void registerListener({
    required String key,
    required ValueChanged<String?> listener,
  }) {}

  @override
  void unregisterListener({
    required String key,
    required ValueChanged<String?> listener,
  }) {}

  @override
  void unregisterAllListeners() {}

  @override
  void unregisterAllListenersForKey({required String key}) {}
}
