import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// Tests the com.zajel.zajel/privacy method channel contract.
///
/// The privacy channel controls Android FLAG_SECURE / Windows secure-screen
/// via two methods: enableSecureScreen and disableSecureScreen.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('com.zajel.zajel/privacy');
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

  test('enableSecureScreen sends correct method call', () async {
    await channel.invokeMethod('enableSecureScreen');

    expect(log, hasLength(1));
    expect(log.first.method, 'enableSecureScreen');
    expect(log.first.arguments, isNull);
  });

  test('disableSecureScreen sends correct method call', () async {
    await channel.invokeMethod('disableSecureScreen');

    expect(log, hasLength(1));
    expect(log.first.method, 'disableSecureScreen');
    expect(log.first.arguments, isNull);
  });

  test('enable then disable sends both calls in order', () async {
    await channel.invokeMethod('enableSecureScreen');
    await channel.invokeMethod('disableSecureScreen');

    expect(log, hasLength(2));
    expect(log[0].method, 'enableSecureScreen');
    expect(log[1].method, 'disableSecureScreen');
  });

  test('handler not set throws MissingPluginException', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);

    expect(
      () => channel.invokeMethod('enableSecureScreen'),
      throwsA(isA<MissingPluginException>()),
    );
  });
}
