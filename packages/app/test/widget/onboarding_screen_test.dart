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
    testWidgets('displays image page initially', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.byType(Image), findsOneWidget);
      expect(find.text('Skip'), findsOneWidget);
      expect(find.text('Next'), findsOneWidget);
    });

    testWidgets('displays 5 page indicator dots', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // There should be 5 indicator dots (animated containers)
      // The active dot is wider (24px), the rest are 8px
      final dots =
          tester.widgetList<Container>(find.byType(Container)).where((c) {
        final constraints = c.constraints;
        if (constraints == null) return false;
        return (constraints.maxWidth == 24 || constraints.maxWidth == 8) &&
            constraints.maxHeight == 8;
      });
      expect(dots.length, equals(5));
    });

    testWidgets('navigates to username page on Next tap', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      expect(find.text('Choose a Username'), findsOneWidget);
    });

    testWidgets('identity page shows identity warning', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Navigate to username page
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      // Enter username to enable Next button
      await tester.enterText(find.byType(TextField), 'TestUser');
      await tester.pump();

      // Navigate to identity page
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.warning_amber), findsOneWidget);
      expect(
        find.textContaining('permanently'),
        findsOneWidget,
      );
    });

    testWidgets('navigates through all 5 pages', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Page 1: Welcome (full-bleed image)
      expect(find.byType(Image), findsOneWidget);

      // Page 2: Username
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.text('Choose a Username'), findsOneWidget);

      // Enter username to enable Next button
      await tester.enterText(find.byType(TextField), 'TestUser');
      await tester.pump();

      // Page 3: Identity
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.text('Your Identity'), findsOneWidget);

      // Page 4: Connect (full-bleed image)
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsOneWidget);

      // Page 5: Get Started (full-bleed image)
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsOneWidget);
      expect(find.text('Get Started'), findsOneWidget);
    });

    testWidgets('shows Get Started button on last page', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Navigate to username page
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();

      // Enter username to enable Next button
      await tester.enterText(find.byType(TextField), 'TestUser');
      await tester.pump();

      // Navigate through remaining pages to last page
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

    testWidgets('displays correct icons/images on each page', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Page 1: full-bleed onboarding_private image
      expect(find.byType(Image), findsOneWidget);

      // Page 2: person icon (username — still an icon)
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.person), findsOneWidget);

      // Enter username to enable Next button
      await tester.enterText(find.byType(TextField), 'TestUser');
      await tester.pump();

      // Page 3: fingerprint icon (identity — still an icon)
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.byIcon(Icons.fingerprint), findsOneWidget);

      // Page 4: full-bleed onboarding_p2p image
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsOneWidget);

      // Page 5: full-bleed onboarding_no_account image
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsOneWidget);
    });

    testWidgets('swipe left navigates to next page', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Page 1 shows an image
      expect(find.byType(Image), findsOneWidget);

      // Swipe left to go to next page (username)
      await tester.drag(find.byType(PageView), const Offset(-400, 0));
      await tester.pumpAndSettle();

      expect(find.text('Choose a Username'), findsOneWidget);
    });

    testWidgets('can navigate back to previous page via swipe', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      // Go to page 2 (username) using the Next button
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
      expect(find.text('Choose a Username'), findsOneWidget);

      // Fling right to go back to page 1
      await tester.fling(find.byType(PageView), const Offset(400, 0), 1000);
      await tester.pumpAndSettle();

      // Page 1 shows an image (full-bleed)
      expect(find.byType(Image), findsOneWidget);
    });
  });
}
