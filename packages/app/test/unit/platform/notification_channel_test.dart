import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Tests the com.zajel.zajel/notifications method channel contract.
///
/// The notifications channel is used on Windows for native Shell_NotifyIcon
/// notifications via two methods: showNotification and cancelNotification.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.zajel.zajel/notifications');
  final log = <MethodCall>[];

  setUp(() {
    log.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      log.add(call);
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('showNotification sends title and body', () async {
    await channel.invokeMethod('showNotification', {
      'title': 'New Message',
      'body': 'Hello from Alice',
    });

    expect(log, hasLength(1));
    expect(log.first.method, 'showNotification');
    expect(log.first.arguments, {
      'title': 'New Message',
      'body': 'Hello from Alice',
    });
  });

  test('cancelNotification sends correct method call', () async {
    await channel.invokeMethod('cancelNotification');

    expect(log, hasLength(1));
    expect(log.first.method, 'cancelNotification');
  });

  test('showNotification followed by cancelNotification', () async {
    await channel.invokeMethod('showNotification', {
      'title': 'Incoming Call',
      'body': 'Bob is calling',
    });
    await channel.invokeMethod('cancelNotification');

    expect(log, hasLength(2));
    expect(log[0].method, 'showNotification');
    expect(log[1].method, 'cancelNotification');
  });

  test('handler not set throws MissingPluginException', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);

    expect(
      () => channel.invokeMethod('showNotification', {
        'title': 'Test',
        'body': 'Test',
      }),
      throwsA(isA<MissingPluginException>()),
    );
  });
}
