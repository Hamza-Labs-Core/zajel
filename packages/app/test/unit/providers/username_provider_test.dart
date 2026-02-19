import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/crypto/crypto_service.dart';
import 'package:zajel/core/providers/app_providers.dart';

import '../../mocks/mocks.dart';

void main() {
  group('usernameProvider', () {
    test('returns stored username', () async {
      SharedPreferences.setMockInitialValues({'username': 'Hamza'});
      final prefs = await SharedPreferences.getInstance();

      final container = ProviderContainer(
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      );
      addTearDown(container.dispose);

      expect(container.read(usernameProvider), 'Hamza');
    });

    test('falls back to displayName key for migration', () async {
      SharedPreferences.setMockInitialValues({'displayName': 'OldName'});
      final prefs = await SharedPreferences.getInstance();

      final container = ProviderContainer(
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      );
      addTearDown(container.dispose);

      expect(container.read(usernameProvider), 'OldName');
    });

    test('prefers username over displayName', () async {
      SharedPreferences.setMockInitialValues({
        'username': 'NewName',
        'displayName': 'OldName',
      });
      final prefs = await SharedPreferences.getInstance();

      final container = ProviderContainer(
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      );
      addTearDown(container.dispose);

      expect(container.read(usernameProvider), 'NewName');
    });

    test('defaults to Anonymous when nothing stored', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();

      final container = ProviderContainer(
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      );
      addTearDown(container.dispose);

      expect(container.read(usernameProvider), 'Anonymous');
    });
  });

  group('userIdentityProvider', () {
    test('returns username#tag when crypto is initialized', () async {
      SharedPreferences.setMockInitialValues({'username': 'Alice'});
      final prefs = await SharedPreferences.getInstance();

      // Initialize a real crypto service with SharedPreferences for stableId
      final crypto =
          CryptoService(secureStorage: FakeSecureStorage(), prefs: prefs);
      await crypto.initialize();
      final expectedTag = CryptoService.tagFromStableId(crypto.stableId);

      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          cryptoServiceProvider.overrideWithValue(crypto),
        ],
      );
      addTearDown(container.dispose);

      expect(container.read(userIdentityProvider), 'Alice#$expectedTag');
    });

    test('returns just username when crypto not initialized', () async {
      SharedPreferences.setMockInitialValues({'username': 'Alice'});
      final prefs = await SharedPreferences.getInstance();

      // An uninitialized CryptoService will throw on publicKeyBase64
      final uninitCrypto = CryptoService(secureStorage: FakeSecureStorage());

      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          cryptoServiceProvider.overrideWithValue(uninitCrypto),
        ],
      );
      addTearDown(container.dispose);

      // Should gracefully fall back to just the username
      expect(container.read(userIdentityProvider), 'Alice');
    });

    test('updates when username changes', () async {
      SharedPreferences.setMockInitialValues({'username': 'Alice'});
      final prefs = await SharedPreferences.getInstance();

      final crypto =
          CryptoService(secureStorage: FakeSecureStorage(), prefs: prefs);
      await crypto.initialize();
      final tag = CryptoService.tagFromStableId(crypto.stableId);

      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          cryptoServiceProvider.overrideWithValue(crypto),
        ],
      );
      addTearDown(container.dispose);

      expect(container.read(userIdentityProvider), 'Alice#$tag');

      // Change username
      container.read(usernameProvider.notifier).state = 'Bob';

      expect(container.read(userIdentityProvider), 'Bob#$tag');
    });
  });
}
