import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/updater/models/update_state.dart';

void main() {
  group('UpdateStatus', () {
    test('has all expected values', () {
      expect(UpdateStatus.values, hasLength(7));
      expect(UpdateStatus.values, contains(UpdateStatus.idle));
      expect(UpdateStatus.values, contains(UpdateStatus.checking));
      expect(UpdateStatus.values, contains(UpdateStatus.downloading));
      expect(UpdateStatus.values, contains(UpdateStatus.verifying));
      expect(UpdateStatus.values, contains(UpdateStatus.ready));
      expect(UpdateStatus.values, contains(UpdateStatus.launchingUpdater));
      expect(UpdateStatus.values, contains(UpdateStatus.failed));
    });
  });

  group('UpdateState', () {
    group('default constructor', () {
      test('has idle status and null optional fields', () {
        const state = UpdateState();

        expect(state.status, UpdateStatus.idle);
        expect(state.downloadProgress, isNull);
        expect(state.availableVersion, isNull);
        expect(state.releaseNotes, isNull);
        expect(state.releaseDate, isNull);
        expect(state.errorMessage, isNull);
        expect(state.lastChecked, isNull);
      });
    });

    group('factory constructors', () {
      test('initial() creates idle state', () {
        const state = UpdateState.initial();

        expect(state.status, UpdateStatus.idle);
        expect(state.downloadProgress, isNull);
        expect(state.availableVersion, isNull);
        expect(state.errorMessage, isNull);
        expect(state.lastChecked, isNull);
      });

      test('upToDate() creates idle state with lastChecked', () {
        final checkedAt = DateTime.utc(2026, 3, 2, 12, 0);
        final state = UpdateState.upToDate(checkedAt: checkedAt);

        expect(state.status, UpdateStatus.idle);
        expect(state.lastChecked, checkedAt);
        expect(state.availableVersion, isNull);
      });

      test('updateAvailable() creates idle state with version info', () {
        final checkedAt = DateTime.utc(2026, 3, 2, 12, 0);
        final releaseDate = DateTime.utc(2026, 3, 1);
        final state = UpdateState.updateAvailable(
          version: '1.2.0',
          releaseNotes: '## Changes\n- Bug fixes',
          releaseDate: releaseDate,
          checkedAt: checkedAt,
        );

        expect(state.status, UpdateStatus.idle);
        expect(state.availableVersion, '1.2.0');
        expect(state.releaseNotes, '## Changes\n- Bug fixes');
        expect(state.releaseDate, releaseDate);
        expect(state.lastChecked, checkedAt);
      });

      test('checking() creates checking state', () {
        final lastChecked = DateTime.utc(2026, 3, 1);
        final state = UpdateState.checking(lastChecked: lastChecked);

        expect(state.status, UpdateStatus.checking);
        expect(state.lastChecked, lastChecked);
      });

      test('downloading() creates downloading state with progress', () {
        final state = UpdateState.downloading(
          version: '1.2.0',
          progress: 0.45,
          releaseNotes: 'Notes',
        );

        expect(state.status, UpdateStatus.downloading);
        expect(state.availableVersion, '1.2.0');
        expect(state.downloadProgress, 0.45);
        expect(state.releaseNotes, 'Notes');
      });

      test('verifying() creates verifying state', () {
        final state = UpdateState.verifying(version: '1.2.0');

        expect(state.status, UpdateStatus.verifying);
        expect(state.availableVersion, '1.2.0');
        expect(state.downloadProgress, isNull);
      });

      test('ready() creates ready state', () {
        final releaseDate = DateTime.utc(2026, 3, 1);
        final state = UpdateState.ready(
          version: '1.2.0',
          releaseNotes: 'Release notes',
          releaseDate: releaseDate,
        );

        expect(state.status, UpdateStatus.ready);
        expect(state.availableVersion, '1.2.0');
        expect(state.releaseNotes, 'Release notes');
        expect(state.releaseDate, releaseDate);
      });

      test('launchingUpdater() creates launching state', () {
        final state = UpdateState.launchingUpdater(version: '1.2.0');

        expect(state.status, UpdateStatus.launchingUpdater);
        expect(state.availableVersion, '1.2.0');
      });

      test('failed() creates failed state with error message', () {
        final lastChecked = DateTime.utc(2026, 3, 1);
        final state = UpdateState.failed(
          errorMessage: 'Download failed: network error',
          availableVersion: '1.2.0',
          lastChecked: lastChecked,
        );

        expect(state.status, UpdateStatus.failed);
        expect(state.errorMessage, 'Download failed: network error');
        expect(state.availableVersion, '1.2.0');
        expect(state.lastChecked, lastChecked);
      });
    });

    group('state transitions', () {
      test('idle -> checking -> idle (up to date)', () {
        const state = UpdateState.initial();
        expect(state.status, UpdateStatus.idle);

        final checking = UpdateState.checking();
        expect(checking.status, UpdateStatus.checking);

        final upToDate = UpdateState.upToDate(
          checkedAt: DateTime.utc(2026, 3, 2),
        );
        expect(upToDate.status, UpdateStatus.idle);
        expect(upToDate.lastChecked, isNotNull);
      });

      test('idle -> checking -> downloading -> verifying -> ready', () {
        const initial = UpdateState.initial();
        expect(initial.status, UpdateStatus.idle);

        final checking = UpdateState.checking();
        expect(checking.status, UpdateStatus.checking);

        final downloading = UpdateState.downloading(
          version: '1.2.0',
          progress: 0.0,
        );
        expect(downloading.status, UpdateStatus.downloading);
        expect(downloading.downloadProgress, 0.0);

        final midDownload = UpdateState.downloading(
          version: '1.2.0',
          progress: 0.5,
        );
        expect(midDownload.downloadProgress, 0.5);

        final doneDownload = UpdateState.downloading(
          version: '1.2.0',
          progress: 1.0,
        );
        expect(doneDownload.downloadProgress, 1.0);

        final verifying = UpdateState.verifying(version: '1.2.0');
        expect(verifying.status, UpdateStatus.verifying);

        final ready = UpdateState.ready(version: '1.2.0');
        expect(ready.status, UpdateStatus.ready);
      });

      test('ready -> launchingUpdater', () {
        final ready = UpdateState.ready(version: '1.2.0');
        expect(ready.status, UpdateStatus.ready);

        final launching = UpdateState.launchingUpdater(version: '1.2.0');
        expect(launching.status, UpdateStatus.launchingUpdater);
      });

      test('downloading -> failed -> idle (retry)', () {
        final downloading = UpdateState.downloading(
          version: '1.2.0',
          progress: 0.3,
        );
        expect(downloading.status, UpdateStatus.downloading);

        final failed = UpdateState.failed(
          errorMessage: 'Network error',
          availableVersion: '1.2.0',
        );
        expect(failed.status, UpdateStatus.failed);
        expect(failed.errorMessage, 'Network error');

        const retryIdle = UpdateState.initial();
        expect(retryIdle.status, UpdateStatus.idle);
      });
    });

    group('copyWith', () {
      test('creates copy with modified status', () {
        const original = UpdateState(
          status: UpdateStatus.idle,
          availableVersion: '1.2.0',
        );

        final copy = original.copyWith(status: UpdateStatus.checking);

        expect(copy.status, UpdateStatus.checking);
        expect(copy.availableVersion, '1.2.0');
      });

      test('can set nullable fields to null', () {
        final original = UpdateState(
          status: UpdateStatus.failed,
          errorMessage: 'Some error',
          availableVersion: '1.2.0',
          lastChecked: DateTime.utc(2026, 3, 2),
        );

        final copy = original.copyWith(
          status: UpdateStatus.idle,
          errorMessage: () => null,
          availableVersion: () => null,
        );

        expect(copy.status, UpdateStatus.idle);
        expect(copy.errorMessage, isNull);
        expect(copy.availableVersion, isNull);
        // lastChecked preserved
        expect(copy.lastChecked, original.lastChecked);
      });

      test('preserves all fields when no changes specified', () {
        final releaseDate = DateTime.utc(2026, 3, 1);
        final lastChecked = DateTime.utc(2026, 3, 2);
        final original = UpdateState(
          status: UpdateStatus.downloading,
          downloadProgress: 0.5,
          availableVersion: '1.2.0',
          releaseNotes: 'Notes',
          releaseDate: releaseDate,
          errorMessage: null,
          lastChecked: lastChecked,
        );

        final copy = original.copyWith();

        expect(copy, original);
      });

      test('updates download progress', () {
        final state = UpdateState.downloading(
          version: '1.2.0',
          progress: 0.3,
        );

        final updated = state.copyWith(
          downloadProgress: () => 0.7,
        );

        expect(updated.downloadProgress, 0.7);
        expect(updated.status, UpdateStatus.downloading);
        expect(updated.availableVersion, '1.2.0');
      });
    });

    group('equality', () {
      test('equal states are equal', () {
        final a = UpdateState.ready(version: '1.2.0');
        final b = UpdateState.ready(version: '1.2.0');

        expect(a, b);
        expect(a.hashCode, b.hashCode);
      });

      test('different states are not equal', () {
        final a = UpdateState.ready(version: '1.2.0');
        final b = UpdateState.ready(version: '1.3.0');

        expect(a, isNot(b));
      });

      test('different statuses are not equal', () {
        const a = UpdateState(status: UpdateStatus.idle);
        const b = UpdateState(status: UpdateStatus.checking);

        expect(a, isNot(b));
      });
    });

    group('toString', () {
      test('includes status', () {
        const state = UpdateState(status: UpdateStatus.checking);
        expect(state.toString(), contains('checking'));
      });

      test('includes version when present', () {
        final state = UpdateState.ready(version: '1.2.0');
        expect(state.toString(), contains('1.2.0'));
      });

      test('includes progress when downloading', () {
        final state = UpdateState.downloading(
          version: '1.2.0',
          progress: 0.456,
        );
        final str = state.toString();
        expect(str, contains('45.6%'));
      });

      test('includes error when failed', () {
        final state = UpdateState.failed(
          errorMessage: 'Network error',
        );
        expect(state.toString(), contains('Network error'));
      });
    });
  });
}
