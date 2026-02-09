import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/models/notification_settings.dart';
import 'package:zajel/core/notifications/notification_service.dart';

void main() {
  group('NotificationService', () {
    late NotificationService service;

    setUp(() {
      service = NotificationService();
    });

    group('initialization state', () {
      test('isInitialized is false before initialize is called', () {
        expect(service.isInitialized, isFalse);
      });
    });

    group('showMessageNotification', () {
      test('returns early without error when not initialized', () async {
        final settings = const NotificationSettings();

        // Should not throw — the !_initialized guard exits before
        // touching the plugin.
        await service.showMessageNotification(
          peerId: 'peer-1',
          peerName: 'Alice',
          content: 'Hello!',
          settings: settings,
        );
      });

      test('returns early when DND is active', () async {
        final settings = NotificationSettings(
          globalDnd: true,
          // dndUntil null means permanent DND
        );

        expect(settings.isDndActive, isTrue);
        expect(settings.shouldNotify('peer-1'), isFalse);

        // Even if the service were initialized, shouldNotify would block.
        // Since it's also not initialized, this doubly returns early.
        await service.showMessageNotification(
          peerId: 'peer-1',
          peerName: 'Alice',
          content: 'Hello!',
          settings: settings,
        );
      });

      test('returns early when messageNotifications is false', () async {
        final settings = const NotificationSettings(
          messageNotifications: false,
        );

        expect(settings.messageNotifications, isFalse);

        await service.showMessageNotification(
          peerId: 'peer-1',
          peerName: 'Alice',
          content: 'Hello!',
          settings: settings,
        );
      });

      test('returns early when peer is muted', () async {
        final settings = NotificationSettings(
          mutedPeerIds: {'peer-1'},
        );

        expect(settings.shouldNotify('peer-1'), isFalse);
        expect(settings.shouldNotify('peer-2'), isTrue);

        await service.showMessageNotification(
          peerId: 'peer-1',
          peerName: 'Alice',
          content: 'Hello!',
          settings: settings,
        );
      });
    });

    group('showCallNotification', () {
      test('returns early without error when not initialized', () async {
        final settings = const NotificationSettings();

        await service.showCallNotification(
          peerId: 'peer-1',
          peerName: 'Alice',
          withVideo: false,
          settings: settings,
        );
      });

      test('returns early when callNotifications is false', () async {
        final settings = const NotificationSettings(
          callNotifications: false,
        );

        expect(settings.callNotifications, isFalse);

        await service.showCallNotification(
          peerId: 'peer-1',
          peerName: 'Alice',
          withVideo: true,
          settings: settings,
        );
      });
    });

    group('showPeerStatusNotification', () {
      test('returns early without error when not initialized', () async {
        final settings = const NotificationSettings();

        await service.showPeerStatusNotification(
          peerName: 'Alice',
          connected: true,
          settings: settings,
        );
      });

      test('returns early when peerStatusNotifications is false', () async {
        final settings = const NotificationSettings(
          peerStatusNotifications: false,
        );

        expect(settings.peerStatusNotifications, isFalse);

        await service.showPeerStatusNotification(
          peerName: 'Alice',
          connected: false,
          settings: settings,
        );
      });

      test('returns early when DND is active', () async {
        final settings = NotificationSettings(
          globalDnd: true,
        );

        expect(settings.isDndActive, isTrue);

        await service.showPeerStatusNotification(
          peerName: 'Alice',
          connected: true,
          settings: settings,
        );
      });
    });

    group('showFileNotification', () {
      test('returns early without error when not initialized', () async {
        final settings = const NotificationSettings();

        await service.showFileNotification(
          peerId: 'peer-1',
          peerName: 'Alice',
          fileName: 'photo.jpg',
          settings: settings,
        );
      });

      test('returns early when fileReceivedNotifications is false', () async {
        final settings = const NotificationSettings(
          fileReceivedNotifications: false,
        );

        expect(settings.fileReceivedNotifications, isFalse);

        await service.showFileNotification(
          peerId: 'peer-1',
          peerName: 'Alice',
          fileName: 'photo.jpg',
          settings: settings,
        );
      });
    });

    group('NotificationSettings guard logic', () {
      test('isDndActive is false when globalDnd is false', () {
        final settings = const NotificationSettings(globalDnd: false);
        expect(settings.isDndActive, isFalse);
      });

      test('isDndActive is true when globalDnd is true and dndUntil is null', () {
        final settings = NotificationSettings(globalDnd: true);
        expect(settings.isDndActive, isTrue);
      });

      test('isDndActive is true when dndUntil is in the future', () {
        final settings = NotificationSettings(
          globalDnd: true,
          dndUntil: DateTime.now().add(const Duration(hours: 1)),
        );
        expect(settings.isDndActive, isTrue);
      });

      test('isDndActive is false when dndUntil is in the past', () {
        final settings = NotificationSettings(
          globalDnd: true,
          dndUntil: DateTime.now().subtract(const Duration(hours: 1)),
        );
        expect(settings.isDndActive, isFalse);
      });

      test('shouldNotify returns false when DND is active', () {
        final settings = NotificationSettings(globalDnd: true);
        expect(settings.shouldNotify('peer-1'), isFalse);
      });

      test('shouldNotify returns false for muted peer', () {
        final settings = NotificationSettings(mutedPeerIds: {'peer-1'});
        expect(settings.shouldNotify('peer-1'), isFalse);
      });

      test('shouldNotify returns true for unmuted peer with DND off', () {
        final settings = NotificationSettings(mutedPeerIds: {'peer-2'});
        expect(settings.shouldNotify('peer-1'), isTrue);
      });
    });

    group('onNotificationTap callback', () {
      test('service accepts an onNotificationTap callback', () {
        String? received;
        final svc = NotificationService(
          onNotificationTap: (payload) {
            received = payload;
          },
        );

        expect(svc.isInitialized, isFalse);
        // The callback is stored but not invoked until the plugin fires.
        // We just verify construction succeeds.
        expect(received, isNull);
      });
    });
  });
}
