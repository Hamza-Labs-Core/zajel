import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/attestation/widgets/update_prompt_dialog.dart';

void main() {
  group('UpdatePromptDialog', () {
    Widget buildDialog({
      String? updateUrl,
      String? recommendedVersion,
      bool isStoreManaged = false,
      String? storeName,
      String? storeDeepLink,
      String? storeWebUrl,
    }) {
      return MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) {
              // Show the dialog immediately in the widget tree for testing
              return UpdatePromptDialog(
                updateUrl: updateUrl,
                recommendedVersion: recommendedVersion,
                isStoreManaged: isStoreManaged,
                storeName: storeName,
                storeDeepLink: storeDeepLink,
                storeWebUrl: storeWebUrl,
              );
            },
          ),
        ),
      );
    }

    group('Store-managed installs', () {
      testWidgets('shows store link for MSIX', (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
          isStoreManaged: true,
          storeName: 'Microsoft Store',
          storeDeepLink: 'ms-windows-store://pdp/?ProductId=TEST',
        ));
        await tester.pump();

        expect(find.text('View in Microsoft Store'), findsOneWidget);
        // Should NOT show generic "Update" button
        expect(find.text('Update'), findsNothing);
      });

      testWidgets('shows store link for Snap', (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
          isStoreManaged: true,
          storeName: 'Snap Store',
          storeDeepLink: 'snap://zajel',
          storeWebUrl: 'https://snapcraft.io/zajel',
        ));
        await tester.pump();

        expect(find.text('View in Snap Store'), findsOneWidget);
      });

      testWidgets('shows store link for Flatpak', (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
          isStoreManaged: true,
          storeName: 'Flathub',
          storeDeepLink: 'https://flathub.org/apps/com.zajel.Zajel',
        ));
        await tester.pump();

        expect(find.text('View in Flathub'), findsOneWidget);
      });

      testWidgets('shows store link for Mac App Store', (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
          isStoreManaged: true,
          storeName: 'Mac App Store',
          storeDeepLink:
              'macappstores://itunes.apple.com/app/zajel/idZAJEL_APP_ID?mt=12',
        ));
        await tester.pump();

        expect(find.text('View in Mac App Store'), findsOneWidget);
      });

      testWidgets('uses fallback "Store" if storeName is null', (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
          isStoreManaged: true,
          storeDeepLink: 'snap://zajel',
        ));
        await tester.pump();

        expect(find.text('View in Store'), findsOneWidget);
      });
    });

    group('Desktop non-store behavior', () {
      testWidgets('shows standard update button when not store managed',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
          updateUrl: 'https://github.com/test/releases/latest',
          isStoreManaged: false,
        ));
        await tester.pump();

        expect(find.text('Update'), findsOneWidget);
        expect(find.textContaining('View in'), findsNothing);
      });
    });

    group('Mobile behavior preserved', () {
      testWidgets('shows standard update button with URL', (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
          updateUrl: 'https://play.google.com/store/apps/details?id=com.zajel',
        ));
        await tester.pump();

        expect(find.text('Update'), findsOneWidget);
      });

      testWidgets('no update button when no URL and not store', (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
        ));
        await tester.pump();

        expect(find.text('Update'), findsNothing);
        expect(find.textContaining('View in'), findsNothing);
      });
    });

    group('Dialog content', () {
      testWidgets('shows "Update Available" title', (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
        ));
        await tester.pump();

        expect(find.text('Update Available'), findsOneWidget);
      });

      testWidgets('shows recommended version in message', (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '2.3.0',
        ));
        await tester.pump();

        expect(find.textContaining('(2.3.0)'), findsOneWidget);
      });

      testWidgets('shows message without version if null', (tester) async {
        await tester.pumpWidget(buildDialog());
        await tester.pump();

        expect(
          find.textContaining('A new version of Zajel'),
          findsOneWidget,
        );
        // No version in parentheses
        expect(find.textContaining('('), findsNothing);
      });

      testWidgets('shows system_update icon', (tester) async {
        await tester.pumpWidget(buildDialog());
        await tester.pump();

        expect(find.byIcon(Icons.system_update), findsOneWidget);
      });
    });

    group('Dismissable behavior preserved', () {
      testWidgets('Later button is always present', (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
          isStoreManaged: true,
          storeName: 'Snap Store',
          storeDeepLink: 'snap://zajel',
        ));
        await tester.pump();

        expect(find.text('Later'), findsOneWidget);
      });

      testWidgets('Later button dismisses dialog', (tester) async {
        bool dialogDismissed = false;

        await tester.pumpWidget(MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) {
                return ElevatedButton(
                  onPressed: () {
                    showDialog(
                      context: context,
                      barrierDismissible: true,
                      builder: (_) => const UpdatePromptDialog(
                        recommendedVersion: '1.5.0',
                      ),
                    ).then((value) {
                      dialogDismissed = true;
                    });
                  },
                  child: const Text('Show Dialog'),
                );
              },
            ),
          ),
        ));

        // Open the dialog
        await tester.tap(find.text('Show Dialog'));
        await tester.pumpAndSettle();

        expect(find.text('Update Available'), findsOneWidget);

        // Tap "Later"
        await tester.tap(find.text('Later'));
        await tester.pumpAndSettle();

        expect(dialogDismissed, isTrue);
        expect(find.text('Update Available'), findsNothing);
      });
    });

    group('Store takes priority over URL', () {
      testWidgets('store button shown when both store and URL provided',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          recommendedVersion: '1.5.0',
          updateUrl: 'https://example.com/update',
          isStoreManaged: true,
          storeName: 'Microsoft Store',
          storeDeepLink: 'ms-windows-store://pdp/?ProductId=TEST',
        ));
        await tester.pump();

        expect(find.text('View in Microsoft Store'), findsOneWidget);
        expect(find.text('Update'), findsNothing);
      });
    });
  });
}
