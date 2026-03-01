import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/services/link_request_handler.dart';

void main() {
  group('LinkRequestHandler', () {
    late StreamController<(String, String, String)> linkRequestCtrl;
    late List<(String, bool, String?)> respondCalls;
    late BuildContext? Function() getContextStub;
    late LinkRequestHandler handler;

    setUp(() {
      linkRequestCtrl = StreamController.broadcast();
      respondCalls = [];
      getContextStub = () => null;
    });

    tearDown(() {
      handler.dispose();
      linkRequestCtrl.close();
    });

    LinkRequestHandler createHandler() {
      handler = LinkRequestHandler(
        linkRequests: linkRequestCtrl.stream,
        respondToLinkRequest: (code, {required bool accept, String? deviceId}) {
          respondCalls.add((code, accept, deviceId));
        },
        getContext: () => getContextStub(),
      );
      return handler;
    }

    test('does not respond when no context available', () async {
      createHandler();
      handler.listen();

      linkRequestCtrl.add(('LINK1', 'pubkey1', 'WebClient'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(respondCalls, isEmpty);
    });

    test('dispose cancels subscription', () async {
      createHandler();
      handler.listen();
      handler.dispose();

      linkRequestCtrl.add(('LINK2', 'pubkey2', 'WebClient2'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(respondCalls, isEmpty);
    });

    testWidgets('shows dialog and responds with approve on Approve tap',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(builder: (context) {
            getContextStub = () => context;
            return const Scaffold(body: Text('Home'));
          }),
        ),
      );
      await tester.pumpAndSettle();

      createHandler();
      handler.listen();

      linkRequestCtrl.add((
        'LINK_ABC',
        'abcdefghijklmnopqrstuvwxyz1234567890',
        'Chrome Browser'
      ));
      await tester.pumpAndSettle();

      // Dialog should be showing
      expect(find.text('Link Request'), findsOneWidget);
      expect(find.text('Chrome Browser wants to link with this device.'),
          findsOneWidget);
      expect(find.text('LINK_ABC'), findsOneWidget);
      expect(find.text('Only approve if you initiated this link request.'),
          findsOneWidget);

      // Tap Approve
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();

      expect(respondCalls, hasLength(1));
      expect(respondCalls[0].$1, 'LINK_ABC');
      expect(respondCalls[0].$2, true);
      expect(respondCalls[0].$3, 'link_LINK_ABC');
    });

    testWidgets('shows dialog and responds with reject on Reject tap',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(builder: (context) {
            getContextStub = () => context;
            return const Scaffold(body: Text('Home'));
          }),
        ),
      );
      await tester.pumpAndSettle();

      createHandler();
      handler.listen();

      linkRequestCtrl.add(('LINK_DEF', 'shortkey', 'Firefox'));
      await tester.pumpAndSettle();

      // Tap Reject
      await tester.tap(find.text('Reject'));
      await tester.pumpAndSettle();

      expect(respondCalls, hasLength(1));
      expect(respondCalls[0].$1, 'LINK_DEF');
      expect(respondCalls[0].$2, false);
      expect(respondCalls[0].$3, null); // no deviceId on rejection
    });

    testWidgets('formats key fingerprint in 4-char chunks', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(builder: (context) {
            getContextStub = () => context;
            return const Scaffold(body: Text('Home'));
          }),
        ),
      );
      await tester.pumpAndSettle();

      createHandler();
      handler.listen();

      // A key longer than 32 chars — should be truncated to 32, then chunked
      final longKey = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012345';
      linkRequestCtrl.add(('LINK_FP', longKey, 'Safari'));
      await tester.pumpAndSettle();

      // Expected fingerprint: first 32 chars, grouped in 4s
      // 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' → 'ABCD EFGH IJKL MNOP QRST UVWX YZ12 3456'
      expect(
        find.text('ABCD EFGH IJKL MNOP QRST UVWX YZ12 3456'),
        findsOneWidget,
      );

      await tester.tap(find.text('Reject'));
      await tester.pumpAndSettle();
    });
  });
}
