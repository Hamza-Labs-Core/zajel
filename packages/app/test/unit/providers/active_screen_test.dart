import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:zajel/core/providers/app_providers.dart';

void main() {
  group('ActiveScreen', () {
    test('constructs with required type and optional id', () {
      const screen = ActiveScreen(type: 'chat', id: 'peer-123');
      expect(screen.type, 'chat');
      expect(screen.id, 'peer-123');
    });

    test('id is null when not provided', () {
      const screen = ActiveScreen(type: 'other');
      expect(screen.type, 'other');
      expect(screen.id, isNull);
    });

    test('ActiveScreen.other has type "other" and null id', () {
      expect(ActiveScreen.other.type, 'other');
      expect(ActiveScreen.other.id, isNull);
    });

    test('supports chat, channel, group, and other types', () {
      const chat = ActiveScreen(type: 'chat', id: 'peer-1');
      const channel = ActiveScreen(type: 'channel', id: 'ch-1');
      const group = ActiveScreen(type: 'group', id: 'grp-1');
      const other = ActiveScreen(type: 'other');

      expect(chat.type, 'chat');
      expect(channel.type, 'channel');
      expect(group.type, 'group');
      expect(other.type, 'other');
    });
  });

  group('activeScreenProvider', () {
    late ProviderContainer container;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
        ],
      );
    });

    tearDown(() => container.dispose());

    test('defaults to ActiveScreen.other', () {
      final screen = container.read(activeScreenProvider);
      expect(screen.type, 'other');
      expect(screen.id, isNull);
    });

    test('can be updated to a chat screen', () {
      container.read(activeScreenProvider.notifier).state =
          const ActiveScreen(type: 'chat', id: 'peer-abc');

      final screen = container.read(activeScreenProvider);
      expect(screen.type, 'chat');
      expect(screen.id, 'peer-abc');
    });

    test('can be reset to other', () {
      container.read(activeScreenProvider.notifier).state =
          const ActiveScreen(type: 'group', id: 'grp-1');
      container.read(activeScreenProvider.notifier).state = ActiveScreen.other;

      final screen = container.read(activeScreenProvider);
      expect(screen.type, 'other');
      expect(screen.id, isNull);
    });
  });

  group('appInForegroundProvider', () {
    late ProviderContainer container;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
        ],
      );
    });

    tearDown(() => container.dispose());

    test('defaults to true', () {
      expect(container.read(appInForegroundProvider), isTrue);
    });

    test('can be set to false when app goes to background', () {
      container.read(appInForegroundProvider.notifier).state = false;
      expect(container.read(appInForegroundProvider), isFalse);
    });

    test('can be toggled back to foreground', () {
      container.read(appInForegroundProvider.notifier).state = false;
      container.read(appInForegroundProvider.notifier).state = true;
      expect(container.read(appInForegroundProvider), isTrue);
    });
  });
}
