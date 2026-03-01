import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Regression test for AlignmentDirectional.resolve null TextDirection crash.
///
/// The privacy overlay in main.dart wraps MaterialApp in a bare Stack:
///   Stack(children: [app, _PrivacyOverlay()])
///
/// Stack uses AlignmentDirectional.topStart by default, which needs
/// a TextDirection to resolve. Without a Directionality ancestor above
/// the Stack, AlignmentDirectional.resolve receives null and crashes.
void main() {
  group('Privacy overlay Stack alignment', () {
    testWidgets('bare Stack without Directionality throws', (tester) async {
      // Reproduce the bug: a bare Stack around MaterialApp children
      await tester.pumpWidget(
        Stack(
          children: [
            MaterialApp(home: Scaffold(body: Text('app'))),
            MaterialApp(home: Scaffold(body: Text('overlay'))),
          ],
        ),
      );

      // The framework should have reported the error
      expect(tester.takeException(), isNotNull);
    });

    testWidgets('Stack with Directionality wrapper does not crash',
        (tester) async {
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: Stack(
            children: [
              MaterialApp(home: Scaffold(body: Text('app'))),
              MaterialApp(home: Scaffold(body: Text('overlay'))),
            ],
          ),
        ),
      );

      // No exception
      expect(tester.takeException(), isNull);
      expect(find.text('overlay'), findsOneWidget);
    });
  });
}
