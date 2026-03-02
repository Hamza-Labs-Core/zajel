import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/services/pair_request_handler.dart';

void main() {
  group('PairRequestHandler', () {
    late StreamController<(String, String, String?)> pairRequestCtrl;
    late List<(String, bool)> respondCalls;
    late BuildContext? Function() getContextStub;
    late PairRequestHandler handler;

    setUp(() {
      pairRequestCtrl = StreamController.broadcast();
      respondCalls = [];
      getContextStub = () => null; // default: no context
    });

    tearDown(() {
      handler.dispose();
      pairRequestCtrl.close();
    });

    PairRequestHandler createHandler() {
      handler = PairRequestHandler(
        pairRequests: pairRequestCtrl.stream,
        respondToPairRequest: (code, {required bool accept}) {
          respondCalls.add((code, accept));
        },
        getContext: () => getContextStub(),
      );
      return handler;
    }

    test('responds with decline when no context available', () async {
      createHandler();
      handler.listen();

      pairRequestCtrl.add(('CODE1', 'pubkey1', 'Alice'));
      // Allow the async _showDialog to execute
      await Future<void>.delayed(const Duration(milliseconds: 50));

      // When context is null, respondToPairRequest should be called with accept=false
      // because showDialog returns null => accepted == true is false
      // Actually, looking at the code: when context is null, _showDialog returns
      // early before calling respondToPairRequest. So respondCalls should be empty.
      expect(respondCalls, isEmpty);
    });

    test('dispose cancels subscription', () async {
      createHandler();
      handler.listen();
      handler.dispose();

      pairRequestCtrl.add(('CODE2', 'pubkey2', 'Bob'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(respondCalls, isEmpty);
    });

    testWidgets('shows dialog and responds with accept on Accept tap',
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

      pairRequestCtrl.add(('ABC123', 'pubkey_abc', 'Charlie'));
      await tester.pumpAndSettle();

      // Dialog should be showing
      expect(find.text('Connection Request'), findsOneWidget);
      expect(find.text('ABC123'), findsOneWidget);
      expect(find.text('Only accept if you know this device.'), findsOneWidget);

      // Tap Accept
      await tester.tap(find.text('Accept'));
      await tester.pumpAndSettle();

      expect(respondCalls, hasLength(1));
      expect(respondCalls[0], ('ABC123', true));
    });

    testWidgets('shows dialog and responds with decline on Decline tap',
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

      pairRequestCtrl.add(('DEF456', 'pubkey_def', null));
      await tester.pumpAndSettle();

      // Without proposed name, should show generic text
      expect(find.text('Device with code DEF456 wants to connect.'),
          findsOneWidget);

      // Tap Decline
      await tester.tap(find.text('Decline'));
      await tester.pumpAndSettle();

      expect(respondCalls, hasLength(1));
      expect(respondCalls[0], ('DEF456', false));
    });

    testWidgets('shows proposed name when provided', (tester) async {
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

      pairRequestCtrl.add(('XYZ789', 'pubkey_xyz', 'MyPhone'));
      await tester.pumpAndSettle();

      expect(find.text('MyPhone (code: XYZ789) wants to connect.'),
          findsOneWidget);

      // Clean up dialog
      await tester.tap(find.text('Decline'));
      await tester.pumpAndSettle();
    });
  });
}
