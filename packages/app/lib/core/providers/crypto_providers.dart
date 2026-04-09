import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/environment.dart';
import '../crypto/bootstrap_verifier.dart';
import '../crypto/crypto_service.dart';
import '../storage/cached_secure_storage.dart';
import '../storage/trusted_peers_storage.dart';
import '../storage/trusted_peers_storage_impl.dart';
import 'preferences_providers.dart';

/// Shared cached secure storage instance.
///
/// All services that need secure storage MUST use this single instance
/// to prevent the load-modify-save race condition in the Windows DPAPI
/// file backend (where all keys share one encrypted JSON file).
final cachedSecureStorageProvider = Provider<CachedSecureStorage>((ref) {
  return CachedSecureStorage();
});

/// Provider for crypto service.
///
/// SharedPreferences is injected for stableId persistence (resilient storage).
/// CachedSecureStorage is injected for private keys (secure storage).
final cryptoServiceProvider = Provider<CryptoService>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  final secureStorage = ref.watch(cachedSecureStorageProvider);
  return CryptoService(prefs: prefs, secureStorage: secureStorage);
});

/// Provider for trusted peers storage.
final trustedPeersStorageProvider = Provider<TrustedPeersStorage>((ref) {
  final secureStorage = ref.watch(cachedSecureStorageProvider);
  return SecureTrustedPeersStorage(storage: secureStorage);
});

/// Provider for bootstrap response verifier.
///
/// Verifies Ed25519 signatures on GET /servers responses from the bootstrap server.
/// Disabled in E2E test mode (test servers don't have signing keys).
final bootstrapVerifierProvider = Provider<BootstrapVerifier?>((ref) {
  if (Environment.isE2eTest) return null;
  return BootstrapVerifier();
});
