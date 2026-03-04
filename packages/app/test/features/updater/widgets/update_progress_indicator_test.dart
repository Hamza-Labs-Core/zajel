import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/updater/models/update_state.dart';
import 'package:zajel/features/updater/widgets/update_progress_indicator.dart';

void main() {
  group('UpdateProgressIndicator', () {
    Widget buildWidget({
      required UpdateStatus status,
      double? progress,
      String? errorMessage,
      VoidCallback? onRetry,
      VoidCallback? onCancel,
      String? version,
    }) {
      return MaterialApp(
        home: Scaffold(
          body: Center(
            child: UpdateProgressIndicator(
              status: status,
              progress: progress,
              errorMessage: errorMessage,
              onRetry: onRetry,
              onCancel: onCancel,
              version: version,
            ),
          ),
        ),
      );
    }

    group('Downloading status', () {
      testWidgets('shows linear progress indicator', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.downloading,
          progress: 0.5,
          version: '2.0.0',
        ));
        await tester.pump();

        expect(find.byType(LinearProgressIndicator), findsOneWidget);
        expect(find.text('Downloading 2.0.0... 50%'), findsOneWidget);
      });

      testWidgets('shows 0% when progress is null', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.downloading,
        ));
        await tester.pump();

        expect(find.text('Downloading... 0%'), findsOneWidget);
      });

      testWidgets('shows correct percentage at 100%', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.downloading,
          progress: 1.0,
          version: '3.0.0',
        ));
        await tester.pump();

        expect(find.text('Downloading 3.0.0... 100%'), findsOneWidget);
      });

      testWidgets('progress indicator has correct value', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.downloading,
          progress: 0.75,
        ));
        await tester.pump();

        final indicator = tester.widget<LinearProgressIndicator>(
          find.byType(LinearProgressIndicator),
        );
        expect(indicator.value, 0.75);
      });

      testWidgets('has accessible semantics', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.downloading,
          progress: 0.45,
        ));
        await tester.pump();

        expect(
          find.bySemanticsLabel('Downloading update, 45 percent complete'),
          findsOneWidget,
        );
      });
    });

    group('Verifying status', () {
      testWidgets('shows circular progress indicator', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.verifying,
        ));
        await tester.pump();

        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        expect(find.text('Verifying...'), findsOneWidget);
      });

      testWidgets('does not show linear progress', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.verifying,
        ));
        await tester.pump();

        expect(find.byType(LinearProgressIndicator), findsNothing);
      });
    });

    group('LaunchingUpdater status', () {
      testWidgets('shows installing message', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.launchingUpdater,
        ));
        await tester.pump();

        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        expect(find.text('Installing...'), findsOneWidget);
        expect(
          find.text('The app will restart momentarily.'),
          findsOneWidget,
        );
      });
    });

    group('Failed status', () {
      testWidgets('shows error icon and message', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.failed,
          errorMessage: 'Network error occurred.',
          onRetry: () {},
        ));
        await tester.pump();

        expect(find.byIcon(Icons.error_outline), findsOneWidget);
        expect(find.text('Network error occurred.'), findsOneWidget);
      });

      testWidgets('shows default error message when null', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.failed,
          onRetry: () {},
        ));
        await tester.pump();

        expect(
          find.text('An error occurred during the update.'),
          findsOneWidget,
        );
      });

      testWidgets('shows retry button when callback provided', (tester) async {
        bool retryCalled = false;

        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.failed,
          errorMessage: 'Download failed.',
          onRetry: () => retryCalled = true,
        ));
        await tester.pump();

        expect(find.text('Retry'), findsOneWidget);
        expect(find.byIcon(Icons.refresh), findsOneWidget);

        await tester.tap(find.text('Retry'));
        await tester.pump();

        expect(retryCalled, isTrue);
      });

      testWidgets('no retry button when callback is null', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.failed,
          errorMessage: 'Download failed.',
        ));
        await tester.pump();

        expect(find.text('Retry'), findsNothing);
      });
    });

    group('Idle/checking/ready statuses', () {
      testWidgets('idle renders nothing', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.idle,
        ));
        await tester.pump();

        expect(find.byType(LinearProgressIndicator), findsNothing);
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(find.text('Downloading'), findsNothing);
        expect(find.text('Verifying...'), findsNothing);
        expect(find.text('Installing...'), findsNothing);
      });

      testWidgets('checking renders nothing', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.checking,
        ));
        await tester.pump();

        expect(find.byType(LinearProgressIndicator), findsNothing);
        expect(find.byType(CircularProgressIndicator), findsNothing);
      });

      testWidgets('ready renders nothing', (tester) async {
        await tester.pumpWidget(buildWidget(
          status: UpdateStatus.ready,
        ));
        await tester.pump();

        expect(find.byType(LinearProgressIndicator), findsNothing);
        expect(find.byType(CircularProgressIndicator), findsNothing);
      });
    });
  });
}
