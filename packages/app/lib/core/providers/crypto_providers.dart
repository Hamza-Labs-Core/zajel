import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/environment.dart';
import '../crypto/bootstrap_verifier.dart';
import '../crypto/crypto_service.dart';
import '../storage/trusted_peers_storage.dart';
import '../storage/trusted_peers_storage_impl.dart';
import 'preferences_providers.dart';

/// Provider for crypto service.
///
/// SharedPreferences is injected for stableId persistence (resilient storage).
/// FlutterSecureStorage is used internally for private keys (secure storage).
final cryptoServiceProvider = Provider<CryptoService>((ref) {
  final prefs = ref.watch(sharedPreferencesProvider);
  return CryptoService(prefs: prefs);
});

/// Provider for trusted peers storage.
final trustedPeersStorageProvider = Provider<TrustedPeersStorage>((ref) {
  return SecureTrustedPeersStorage();
});

/// Provider for bootstrap response verifier.
///
/// Verifies Ed25519 signatures on GET /servers responses from the bootstrap server.
/// Disabled in E2E test mode (test servers don't have signing keys).
final bootstrapVerifierProvider = Provider<BootstrapVerifier?>((ref) {
  if (Environment.isE2eTest) return null;
  return BootstrapVerifier();
});
