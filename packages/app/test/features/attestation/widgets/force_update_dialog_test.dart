import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/attestation/widgets/force_update_dialog.dart';
import 'package:zajel/features/updater/models/update_state.dart';
import 'package:zajel/features/updater/providers/update_providers.dart';

void main() {
  group('ForceUpdateDialog', () {
    Widget buildDialog({
      String? updateUrl,
      String? requiredVersion,
      bool isBlocked = false,
      bool isStoreManaged = false,
      String? storeName,
      String? storeDeepLink,
      String? storeWebUrl,
      TargetPlatform platform = TargetPlatform.linux,
      UpdateState? updateState,
      bool supportsAutoUpdate = false,
    }) {
      return ProviderScope(
        overrides: [
          if (updateState != null)
            updateStateProvider.overrideWithValue(updateState),
          supportsAutoUpdateProvider.overrideWithValue(supportsAutoUpdate),
        ],
        child: MaterialApp(
          theme: ThemeData(platform: platform),
          home: ForceUpdateDialog(
            updateUrl: updateUrl,
            requiredVersion: requiredVersion,
            isBlocked: isBlocked,
            isStoreManaged: isStoreManaged,
            storeName: storeName,
            storeDeepLink: storeDeepLink,
            storeWebUrl: storeWebUrl,
          ),
        ),
      );
    }

    group('Store-managed installs', () {
      testWidgets('shows store button for MSIX install', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          isStoreManaged: true,
          storeName: 'Microsoft Store',
          storeDeepLink: 'ms-windows-store://pdp/?ProductId=TEST',
          platform: TargetPlatform.windows,
        ));
        await tester.pump();

        expect(find.text('Update via Microsoft Store'), findsOneWidget);
        expect(find.byIcon(Icons.store), findsOneWidget);
        // Should NOT show other buttons
        expect(find.text('Update Now'), findsNothing);
        expect(find.text('Download and Install'), findsNothing);
      });

      testWidgets('shows store button for Snap install', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          isStoreManaged: true,
          storeName: 'Snap Store',
          storeDeepLink: 'snap://zajel',
          storeWebUrl: 'https://snapcraft.io/zajel',
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(find.text('Update via Snap Store'), findsOneWidget);
        expect(find.byIcon(Icons.store), findsOneWidget);
      });

      testWidgets('shows store button for Flatpak install', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          isStoreManaged: true,
          storeName: 'Flathub',
          storeDeepLink: 'https://flathub.org/apps/com.zajel.Zajel',
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(find.text('Update via Flathub'), findsOneWidget);
      });

      testWidgets('shows store button for Mac App Store install',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          isStoreManaged: true,
          storeName: 'Mac App Store',
          storeDeepLink:
              'macappstores://itunes.apple.com/app/zajel/idZAJEL_APP_ID?mt=12',
          platform: TargetPlatform.macOS,
        ));
        await tester.pump();

        expect(find.text('Update via Mac App Store'), findsOneWidget);
      });

      testWidgets('uses fallback "Store" if storeName is null', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          isStoreManaged: true,
          storeDeepLink: 'snap://zajel',
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(find.text('Update via Store'), findsOneWidget);
      });
    });

    group('Desktop loose installs', () {
      testWidgets('shows download button for desktop non-store',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          supportsAutoUpdate: true,
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(find.text('Download and Install'), findsOneWidget);
        expect(find.byIcon(Icons.download), findsOneWidget);
        // Should NOT show store or URL buttons
        expect(find.text('Update Now'), findsNothing);
        expect(find.textContaining('Update via'), findsNothing);
      });

      testWidgets('shows download button for Windows loose install',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          supportsAutoUpdate: true,
          platform: TargetPlatform.windows,
        ));
        await tester.pump();

        expect(find.text('Download and Install'), findsOneWidget);
      });

      testWidgets('shows download button for macOS loose install',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          supportsAutoUpdate: true,
          platform: TargetPlatform.macOS,
        ));
        await tester.pump();

        expect(find.text('Download and Install'), findsOneWidget);
      });
    });

    group('Mobile behavior', () {
      testWidgets('shows URL launcher button on Android', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          updateUrl: 'https://play.google.com/store/apps/details?id=com.zajel',
          platform: TargetPlatform.android,
        ));
        await tester.pump();

        expect(find.text('Update Now'), findsOneWidget);
        expect(find.byIcon(Icons.open_in_new), findsOneWidget);
        expect(find.text('Download and Install'), findsNothing);
        expect(find.textContaining('Update via'), findsNothing);
      });

      testWidgets('shows URL launcher button on iOS', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          updateUrl: 'https://apps.apple.com/app/zajel',
          platform: TargetPlatform.iOS,
        ));
        await tester.pump();

        expect(find.text('Update Now'), findsOneWidget);
      });
    });

    group('Download progress states', () {
      testWidgets('shows downloading state with progress', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          supportsAutoUpdate: true,
          updateState: UpdateState.downloading(
            version: '2.0.0',
            progress: 0.45,
          ),
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(find.text('Downloading Update...'), findsOneWidget);
        expect(find.text('Downloading 2.0.0... 45%'), findsOneWidget);
        expect(find.byType(LinearProgressIndicator), findsOneWidget);
        // Action button should not be visible during download
        expect(find.text('Download and Install'), findsNothing);
      });

      testWidgets('shows verifying state', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          supportsAutoUpdate: true,
          updateState: UpdateState.verifying(version: '2.0.0'),
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(find.text('Verifying Update...'), findsOneWidget);
        expect(find.text('Verifying...'), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsOneWidget);
      });

      testWidgets('shows installing state', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          supportsAutoUpdate: true,
          updateState: UpdateState.launchingUpdater(version: '2.0.0'),
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(find.text('Installing Update...'), findsOneWidget);
        expect(find.text('Installing...'), findsOneWidget);
        expect(
          find.text('The app will restart momentarily.'),
          findsOneWidget,
        );
      });
    });

    group('Error and retry', () {
      testWidgets('shows error state with retry button', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          supportsAutoUpdate: true,
          updateState: UpdateState.failed(
            errorMessage: 'Download interrupted. Check your connection.',
          ),
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(
          find.text('Download interrupted. Check your connection.'),
          findsOneWidget,
        );
        expect(find.text('Retry'), findsOneWidget);
        expect(find.byIcon(Icons.refresh), findsOneWidget);
        expect(find.text('Download Manually'), findsOneWidget);
      });

      testWidgets('shows error state without auto-update support',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          supportsAutoUpdate: false,
          updateState: UpdateState.failed(
            errorMessage: 'Checksum verification failed.',
          ),
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(find.text('Checksum verification failed.'), findsOneWidget);
        expect(find.text('Retry'), findsOneWidget);
        // No auto-update support, so no "Download Manually" fallback
        expect(find.text('Download Manually'), findsNothing);
      });

      testWidgets('shows error icon', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          supportsAutoUpdate: true,
          updateState: UpdateState.failed(
            errorMessage: 'Error occurred.',
          ),
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(find.byIcon(Icons.error_outline), findsOneWidget);
      });
    });

    group('Blocked vs update required', () {
      testWidgets('blocked shows "Version Blocked" title and red icon',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          isBlocked: true,
          updateUrl: 'https://example.com',
          platform: TargetPlatform.android,
        ));
        await tester.pump();

        expect(find.text('Version Blocked'), findsOneWidget);
        expect(find.byIcon(Icons.block), findsOneWidget);
        expect(
          find.textContaining('security issue'),
          findsOneWidget,
        );
      });

      testWidgets('update required shows "Update Required" title',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '3.0.0',
          updateUrl: 'https://example.com',
          platform: TargetPlatform.android,
        ));
        await tester.pump();

        expect(find.text('Update Required'), findsOneWidget);
        expect(find.byIcon(Icons.system_update), findsOneWidget);
        expect(find.textContaining('version 3.0.0'), findsOneWidget);
      });

      testWidgets('update required with no version shows "the latest"',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          updateUrl: 'https://example.com',
          platform: TargetPlatform.android,
        ));
        await tester.pump();

        expect(find.textContaining('the latest'), findsOneWidget);
      });
    });

    group('PopScope behavior', () {
      testWidgets('cannot be dismissed with back button', (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          updateUrl: 'https://example.com',
          platform: TargetPlatform.android,
        ));
        await tester.pump();

        // Find the PopScope and verify canPop is false
        final popScope = tester.widget<PopScope>(find.byType(PopScope));
        expect(popScope.canPop, isFalse);
      });
    });

    group('No buttons shown', () {
      testWidgets('no action shown when no URL/callback/store info given',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          platform: TargetPlatform.android,
        ));
        await tester.pump();

        expect(find.text('Update Now'), findsNothing);
        expect(find.text('Download and Install'), findsNothing);
        expect(find.textContaining('Update via'), findsNothing);
      });
    });

    group('Store preferred over URL for store installs', () {
      testWidgets(
          'store button shown even when updateUrl is provided for store install',
          (tester) async {
        await tester.pumpWidget(buildDialog(
          requiredVersion: '2.0.0',
          updateUrl: 'https://example.com/update',
          isStoreManaged: true,
          storeName: 'Snap Store',
          storeDeepLink: 'snap://zajel',
          platform: TargetPlatform.linux,
        ));
        await tester.pump();

        expect(find.text('Update via Snap Store'), findsOneWidget);
        expect(find.text('Update Now'), findsNothing);
      });
    });
  });
}
