import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/help/help_content.dart';
import 'package:zajel/features/help/help_screen.dart';

void main() {
  Widget createTestWidget() {
    return const ProviderScope(
      child: MaterialApp(
        home: HelpScreen(),
      ),
    );
  }

  group('HelpScreen', () {
    testWidgets('displays Help & Info title in app bar', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Help & Info'), findsOneWidget);
    });

    testWidgets('displays introductory text', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(
        find.textContaining('Learn how Zajel works'),
        findsOneWidget,
      );
    });

    testWidgets('displays Topics section header', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(find.text('Topics'), findsOneWidget);
    });

    testWidgets('displays all article titles', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      for (final article in HelpContent.articles) {
        // Scroll to find the article (in case the list is long)
        await tester.scrollUntilVisible(
          find.text(article.title),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text(article.title), findsAtLeastNWidgets(1),
            reason: 'Should display article title: ${article.title}');
      }
    });

    testWidgets('displays all article subtitles', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      for (final article in HelpContent.articles) {
        await tester.scrollUntilVisible(
          find.text(article.subtitle),
          200,
          scrollable: find.byType(Scrollable).first,
        );
        expect(find.text(article.subtitle), findsAtLeastNWidgets(1),
            reason: 'Should display article subtitle: ${article.subtitle}');
      }
    });

    testWidgets('displays chevron_right icon for each article', (tester) async {
      await tester.pumpWidget(createTestWidget());
      await tester.pump();

      expect(
        find.byIcon(Icons.chevron_right),
        findsNWidgets(HelpContent.articles.length),
      );
    });
  });
}
