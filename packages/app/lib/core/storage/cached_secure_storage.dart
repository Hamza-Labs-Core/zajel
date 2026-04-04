import 'dart:async';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../logging/logger_service.dart';

/// Thread-safe wrapper around [FlutterSecureStorage] that prevents the
/// load-modify-save race condition in the Windows DPAPI file backend.
///
/// On Windows, `flutter_secure_storage` serializes ALL key-value pairs into
/// a single DPAPI-encrypted JSON file. Every `write()` call does:
///   1. Read entire file -> deserialize
///   2. Modify the in-memory map
///   3. Serialize -> encrypt -> write entire file
///
/// When multiple services issue concurrent writes (e.g., during app init),
/// a later save can overwrite an earlier save's data because both loaded the
/// same stale snapshot. This wrapper fixes the race by:
///   - Maintaining an in-memory cache loaded once at startup
///   - Serializing all mutating operations through a queue
///   - Serving all reads from cache (instant, no file I/O)
class CachedSecureStorage {
  final FlutterSecureStorage _storage;
  Map<String, String>? _cache;
  Completer<void>? _initCompleter;
  Future<void>? _writeChain;

  CachedSecureStorage({FlutterSecureStorage? storage})
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
              iOptions:
                  IOSOptions(accessibility: KeychainAccessibility.first_unlock),
            );

  /// Load all data from secure storage into the in-memory cache.
  ///
  /// Must be called once before any read/write operations.
  /// Safe to call multiple times -- subsequent calls are no-ops.
  Future<void> initialize() async {
    if (_cache != null) return;

    if (_initCompleter != null) {
      return _initCompleter!.future;
    }

    _initCompleter = Completer<void>();
    try {
      _cache = await _storage.readAll().timeout(const Duration(seconds: 15));
      logger.info('CachedSecureStorage',
          'Loaded ${_cache!.length} keys from secure storage');
      _initCompleter!.complete();
    } catch (e) {
      logger.warning('CachedSecureStorage',
          'Failed to load from secure storage, starting empty: $e');
      _cache = {};
      _initCompleter!.complete();
    }
  }

  /// Read a value by key (from cache, instant).
  Future<String?> read({required String key}) async {
    await initialize();
    return _cache![key];
  }

  /// Write a key-value pair. Updates cache immediately,
  /// then persists via serialized queue.
  Future<void> write({required String key, required String value}) async {
    await initialize();
    _cache![key] = value;
    await _enqueue(() => _storage
        .write(key: key, value: value)
        .timeout(const Duration(seconds: 10)));
  }

  /// Delete a key. Updates cache immediately,
  /// then persists via serialized queue.
  Future<void> delete({required String key}) async {
    await initialize();
    if (_cache!.remove(key) != null) {
      await _enqueue(
          () => _storage.delete(key: key).timeout(const Duration(seconds: 10)));
    }
  }

  /// Read all key-value pairs (from cache, instant).
  Future<Map<String, String>> readAll() async {
    await initialize();
    return Map<String, String>.from(_cache!);
  }

  /// Delete all data.
  Future<void> deleteAll() async {
    await initialize();
    _cache!.clear();
    await _enqueue(
        () => _storage.deleteAll().timeout(const Duration(seconds: 10)));
  }

  /// Enqueue a storage operation, ensuring sequential execution.
  ///
  /// Each operation waits for the previous one to finish before starting.
  /// This prevents the DPAPI file from being read by two concurrent
  /// operations that would each get a stale snapshot.
  Future<void> _enqueue(Future<void> Function() operation) async {
    final previous = _writeChain;
    final completer = Completer<void>();
    _writeChain = completer.future;

    if (previous != null) {
      try {
        await previous;
      } catch (_) {
        // Previous write failed, but we still proceed with ours
      }
    }

    try {
      await operation();
      completer.complete();
    } catch (e) {
      logger.warning('CachedSecureStorage', 'Storage operation failed: $e');
      completer.complete(); // Don't block future writes
    }
  }
}
