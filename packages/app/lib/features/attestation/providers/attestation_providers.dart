import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

import '../../../core/providers/app_providers.dart';
import '../models/session_token.dart';
import '../models/version_policy.dart';
import '../platform/binary_reader.dart';
import '../platform/binary_reader_desktop.dart';
import '../services/anti_tamper_service.dart';
import '../services/attestation_client.dart';
import '../services/attestation_service.dart';
import '../services/binary_attestation_service.dart';
import '../services/server_attestation_service.dart';
import '../services/version_check_service.dart';

/// Provider for the attestation HTTP client.
final attestationClientProvider = Provider<AttestationClient>((ref) {
  final bootstrapUrl = ref.watch(bootstrapServerUrlProvider);
  final client = AttestationClient(bootstrapUrl: bootstrapUrl);
  ref.onDispose(() => client.dispose());
  return client;
});

/// Provider for a stable device ID used for attestation.
///
/// Generated once and persisted via SharedPreferences. This ensures
/// the same device ID is used across app restarts.
final attestationDeviceIdProvider = Provider<String>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  const key = 'attestation_device_id';
  var deviceId = prefs.getString(key);
  if (deviceId == null || deviceId.isEmpty) {
    deviceId = const Uuid().v4();
    prefs.setString(key, deviceId);
  }
  return deviceId;
});

/// Provider for the main attestation service.
final attestationServiceProvider = Provider<AttestationService>((ref) {
  final client = ref.watch(attestationClientProvider);
  final deviceId = ref.watch(attestationDeviceIdProvider);
  return AttestationService(
    client: client,
    secureStorage: const FlutterSecureStorage(),
    deviceId: deviceId,
  );
});

/// Provider for the current session token.
///
/// This is a [StateProvider] so it can be updated when a new token
/// is obtained through registration or attestation.
final sessionTokenProvider = StateProvider<SessionToken?>((ref) => null);

/// Provider for the binary reader (platform-specific).
final binaryReaderProvider = Provider<BinaryReader>((ref) {
  if (kIsWeb) {
    return StubBinaryReader();
  }
  if (Platform.isLinux || Platform.isWindows || Platform.isMacOS) {
    return BinaryReaderDesktop();
  }
  // Mobile platforms use stub until native platform channels are implemented
  return StubBinaryReader();
});

/// Provider for the binary attestation service.
final binaryAttestationServiceProvider =
    Provider<BinaryAttestationService>((ref) {
  final binaryReader = ref.watch(binaryReaderProvider);
  return BinaryAttestationService(binaryReader: binaryReader);
});

/// Provider for the server attestation service.
final serverAttestationServiceProvider =
    Provider<ServerAttestationService>((ref) {
  return ServerAttestationService();
});

/// Provider for the version check service.
final versionCheckServiceProvider = Provider<VersionCheckService>((ref) {
  final client = ref.watch(attestationClientProvider);
  return VersionCheckService(client: client);
});

/// Provider for the current version check result.
///
/// Populated when the version check runs on app start.
final versionCheckProvider = StateProvider<VersionStatus?>((ref) => null);

/// Provider for the cached version policy.
final versionPolicyProvider = StateProvider<VersionPolicy?>((ref) => null);

/// Provider for the anti-tamper service.
final antiTamperServiceProvider = Provider<AntiTamperService>((ref) {
  return AntiTamperService();
});

/// Provider for the latest anti-tamper check result.
final antiTamperResultProvider =
    StateProvider<TamperCheckResult?>((ref) => null);
