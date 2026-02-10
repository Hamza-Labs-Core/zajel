import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/providers/app_providers.dart';
import 'package:zajel/features/onboarding/onboarding_screen.dart';

import '../widget/home_screen_test.dart' show FakeSharedPreferences;

void main() {
  Widget createTestWidget() {
    return ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(FakeSharedPreferences()),
        hasSeenOnboardingProvider.overrideWith((ref) => false),
      ],
      child: const MaterialApp(
        home: OnboardingScreen(),
      ),
    );
  }

  group('OnboardingScreen', () {
    testWidgets('displays Welcome page initially', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Welcome to Zajel'), findsOneWidget);
      expect(find.text('Skip'), findsOneWidget);
      expect(find.text('Next'), findsOneWidget);
    });

    testWidgets('displays 4 page indicator dots', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // There should be 4 indicator dots (animated containers)
      // The active dot is wider (24px), the rest are 8px
      final dots = tester
          .widgetList<Container>(find.byType(Container))
          .where((c) {
        final constraints = c.constraints;
        if (constraints == null) return false;
        return (constraints.maxWidth == 24 || constraints.maxWidth == 8) &&
            constraints.maxHeight == 8;
      });
      expect(dots.length, equals(4));
    });

    testWidgets('navigates to second page on Next tap', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      expect(find.text('Your Identity'), findsOneWidget);
    });

    testWidgets('second page shows identity warning', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.warning_amber), findsOneWidget);
      expect(
        find.textContaining('permanently'),
        findsOneWidget,
      );
    });

    testWidgets('navigates through all 4 pages', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Page 1: Welcome
      expect(find.text('Welcome to Zajel'), findsOneWidget);

      // Page 2: Identity
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.text('Your Identity'), findsOneWidget);

      // Page 3: Connect
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.text('How to Connect'), findsOneWidget);

      // Page 4: Get Started
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.text("You're Ready"), findsOneWidget);
      expect(find.text('Get Started'), findsOneWidget);
    });

    testWidgets('shows Get Started button on last page', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Navigate to last page
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      // Should show "Get Started" instead of "Next"
      expect(find.text('Get Started'), findsOneWidget);
      expect(find.text('Next'), findsNothing);
    });

    testWidgets('displays correct icons on each page', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Page 1: mail_lock
      expect(find.byIcon(Icons.mail_lock), findsOneWidget);

      // Page 2: fingerprint
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.fingerprint), findsOneWidget);

      // Page 3: people
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.people), findsOneWidget);

      // Page 4: rocket_launch
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.rocket_launch), findsOneWidget);
    });

    testWidgets('swipe left navigates to next page', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Welcome to Zajel'), findsOneWidget);

      // Swipe left to go to next page
      await tester.drag(find.byType(PageView), const Offset(-400, 0));
      await tester.pumpAndSettle();

      expect(find.text('Your Identity'), findsOneWidget);
    });

    testWidgets('can navigate back to previous page via swipe', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Go to page 2 using the Next button
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.text('Your Identity'), findsOneWidget);

      // Fling right to go back to page 1
      await tester.fling(find.byType(PageView), const Offset(400, 0), 1000);
      await tester.pumpAndSettle();

      expect(find.text('Welcome to Zajel'), findsOneWidget);
    });
  });
}
