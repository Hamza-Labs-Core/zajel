import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/updater/models/github_release.dart';

void main() {
  group('GitHubReleaseAsset', () {
    group('fromJson', () {
      test('parses complete GitHub API response', () {
        final json = {
          'name': 'zajel-1.2.0-windows.zip',
          'browser_download_url':
              'https://github.com/user/zajel/releases/download/v1.2.0/zajel-1.2.0-windows.zip',
          'size': 52428800,
          'content_type': 'application/zip',
        };

        final asset = GitHubReleaseAsset.fromJson(json);

        expect(asset.name, 'zajel-1.2.0-windows.zip');
        expect(asset.browserDownloadUrl,
            'https://github.com/user/zajel/releases/download/v1.2.0/zajel-1.2.0-windows.zip');
        expect(asset.size, 52428800);
        expect(asset.contentType, 'application/zip');
      });

      test('handles missing fields with defaults', () {
        final asset = GitHubReleaseAsset.fromJson({});

        expect(asset.name, '');
        expect(asset.browserDownloadUrl, '');
        expect(asset.size, 0);
        expect(asset.contentType, 'application/octet-stream');
      });

      test('handles null values with defaults', () {
        final json = {
          'name': null,
          'browser_download_url': null,
          'size': null,
          'content_type': null,
        };

        final asset = GitHubReleaseAsset.fromJson(json);

        expect(asset.name, '');
        expect(asset.browserDownloadUrl, '');
        expect(asset.size, 0);
        expect(asset.contentType, 'application/octet-stream');
      });
    });

    group('toJson', () {
      test('serializes correctly', () {
        const asset = GitHubReleaseAsset(
          name: 'zajel-1.2.0-linux.tar.gz',
          browserDownloadUrl: 'https://example.com/download',
          size: 1024,
          contentType: 'application/gzip',
        );

        final json = asset.toJson();

        expect(json['name'], 'zajel-1.2.0-linux.tar.gz');
        expect(json['browser_download_url'], 'https://example.com/download');
        expect(json['size'], 1024);
        expect(json['content_type'], 'application/gzip');
      });
    });

    group('equality', () {
      test('equal assets are equal', () {
        const a = GitHubReleaseAsset(
          name: 'file.zip',
          browserDownloadUrl: 'https://example.com/file.zip',
          size: 100,
          contentType: 'application/zip',
        );
        const b = GitHubReleaseAsset(
          name: 'file.zip',
          browserDownloadUrl: 'https://example.com/file.zip',
          size: 100,
          contentType: 'application/zip',
        );

        expect(a, b);
        expect(a.hashCode, b.hashCode);
      });

      test('different assets are not equal', () {
        const a = GitHubReleaseAsset(
          name: 'file-a.zip',
          browserDownloadUrl: 'https://example.com/a',
          size: 100,
          contentType: 'application/zip',
        );
        const b = GitHubReleaseAsset(
          name: 'file-b.zip',
          browserDownloadUrl: 'https://example.com/b',
          size: 200,
          contentType: 'application/zip',
        );

        expect(a, isNot(b));
      });
    });

    test('toString includes name and size', () {
      const asset = GitHubReleaseAsset(
        name: 'zajel-1.2.0-windows.zip',
        browserDownloadUrl: 'https://example.com/download',
        size: 52428800,
        contentType: 'application/zip',
      );

      final str = asset.toString();
      expect(str, contains('zajel-1.2.0-windows.zip'));
      expect(str, contains('52428800'));
    });
  });

  group('GitHubRelease', () {
    Map<String, dynamic> createReleaseJson({
      String tagName = 'v1.2.0',
      String name = 'Zajel v1.2.0',
      String body = '## Changes\n- Bug fixes\n- Performance improvements',
      bool prerelease = false,
      bool draft = false,
      String publishedAt = '2026-03-01T10:00:00Z',
      String htmlUrl = 'https://github.com/user/zajel/releases/tag/v1.2.0',
      List<Map<String, dynamic>>? assets,
    }) {
      return {
        'tag_name': tagName,
        'name': name,
        'body': body,
        'prerelease': prerelease,
        'draft': draft,
        'published_at': publishedAt,
        'html_url': htmlUrl,
        'assets': assets ??
            [
              {
                'name': 'zajel-1.2.0-windows.zip',
                'browser_download_url':
                    'https://github.com/user/zajel/releases/download/v1.2.0/zajel-1.2.0-windows.zip',
                'size': 52000000,
                'content_type': 'application/zip',
              },
              {
                'name': 'zajel-1.2.0-macos.dmg',
                'browser_download_url':
                    'https://github.com/user/zajel/releases/download/v1.2.0/zajel-1.2.0-macos.dmg',
                'size': 48000000,
                'content_type': 'application/octet-stream',
              },
              {
                'name': 'zajel-1.2.0-linux.tar.gz',
                'browser_download_url':
                    'https://github.com/user/zajel/releases/download/v1.2.0/zajel-1.2.0-linux.tar.gz',
                'size': 45000000,
                'content_type': 'application/gzip',
              },
              {
                'name': 'checksums.txt',
                'browser_download_url':
                    'https://github.com/user/zajel/releases/download/v1.2.0/checksums.txt',
                'size': 256,
                'content_type': 'text/plain',
              },
            ],
      };
    }

    group('fromJson', () {
      test('parses complete GitHub API response', () {
        final json = createReleaseJson();

        final release = GitHubRelease.fromJson(json);

        expect(release.tagName, 'v1.2.0');
        expect(release.version, '1.2.0');
        expect(release.name, 'Zajel v1.2.0');
        expect(release.body, contains('Bug fixes'));
        expect(release.prerelease, false);
        expect(release.draft, false);
        expect(release.htmlUrl, contains('github.com'));
        expect(release.publishedAt, DateTime.utc(2026, 3, 1, 10, 0, 0));
        expect(release.assets, hasLength(4));
      });

      test('strips v prefix from tag name for version', () {
        final json = createReleaseJson(tagName: 'v2.5.3');
        final release = GitHubRelease.fromJson(json);

        expect(release.tagName, 'v2.5.3');
        expect(release.version, '2.5.3');
      });

      test('handles tag without v prefix', () {
        final json = createReleaseJson(tagName: '2.5.3');
        final release = GitHubRelease.fromJson(json);

        expect(release.tagName, '2.5.3');
        expect(release.version, '2.5.3');
      });

      test('throws FormatException when tag_name is missing', () {
        expect(
          () => GitHubRelease.fromJson({}),
          throwsA(isA<FormatException>()),
        );
      });

      test('throws FormatException when tag_name is empty', () {
        expect(
          () => GitHubRelease.fromJson({'tag_name': ''}),
          throwsA(isA<FormatException>()),
        );
      });

      test('handles missing optional fields with defaults', () {
        final release = GitHubRelease.fromJson({
          'tag_name': 'v1.0.0',
        });

        expect(release.tagName, 'v1.0.0');
        expect(release.name, 'v1.0.0'); // Falls back to tagName
        expect(release.body, '');
        expect(release.prerelease, false);
        expect(release.draft, false);
        expect(release.htmlUrl, '');
        expect(release.assets, isEmpty);
        expect(release.checksumContent, isNull);
      });

      test('handles missing assets field', () {
        final json = {
          'tag_name': 'v1.0.0',
          'body': 'Release notes',
          'published_at': '2026-03-01T10:00:00Z',
        };

        final release = GitHubRelease.fromJson(json);

        expect(release.assets, isEmpty);
      });

      test('handles invalid published_at gracefully', () {
        final json = createReleaseJson(publishedAt: 'invalid-date');
        final release = GitHubRelease.fromJson(json);

        // Falls back to DateTime.now() — just verify it's recent
        final now = DateTime.now();
        expect(
          release.publishedAt.difference(now).inSeconds.abs(),
          lessThan(5),
        );
      });
    });

    group('getAssetForPlatform', () {
      test('returns Windows ZIP for windows platform', () {
        final release = GitHubRelease.fromJson(createReleaseJson());
        final asset = release.getAssetForPlatform('windows');

        expect(asset, isNotNull);
        expect(asset!.name, 'zajel-1.2.0-windows.zip');
      });

      test('returns macOS DMG for macos platform', () {
        final release = GitHubRelease.fromJson(createReleaseJson());
        final asset = release.getAssetForPlatform('macos');

        expect(asset, isNotNull);
        expect(asset!.name, 'zajel-1.2.0-macos.dmg');
      });

      test('returns Linux tarball for linux platform', () {
        final release = GitHubRelease.fromJson(createReleaseJson());
        final asset = release.getAssetForPlatform('linux');

        expect(asset, isNotNull);
        expect(asset!.name, 'zajel-1.2.0-linux.tar.gz');
      });

      test('returns null for unknown platform', () {
        final release = GitHubRelease.fromJson(createReleaseJson());
        final asset = release.getAssetForPlatform('android');

        expect(asset, isNull);
      });

      test('returns null when no matching asset exists', () {
        final release = GitHubRelease.fromJson(
          createReleaseJson(assets: [
            {
              'name': 'checksums.txt',
              'browser_download_url': 'https://example.com/checksums.txt',
              'size': 256,
            },
          ]),
        );

        final asset = release.getAssetForPlatform('windows');
        expect(asset, isNull);
      });

      test('prefers DMG over ZIP for macOS', () {
        final release = GitHubRelease.fromJson(
          createReleaseJson(assets: [
            {
              'name': 'zajel-1.2.0-macos.zip',
              'browser_download_url': 'https://example.com/macos.zip',
              'size': 48000000,
            },
            {
              'name': 'zajel-1.2.0-macos.dmg',
              'browser_download_url': 'https://example.com/macos.dmg',
              'size': 50000000,
            },
          ]),
        );

        final asset = release.getAssetForPlatform('macos');
        expect(asset, isNotNull);
        expect(asset!.name, 'zajel-1.2.0-macos.dmg');
      });

      test('falls back to ZIP when DMG not available for macOS', () {
        final release = GitHubRelease.fromJson(
          createReleaseJson(assets: [
            {
              'name': 'zajel-1.2.0-macos.zip',
              'browser_download_url': 'https://example.com/macos.zip',
              'size': 48000000,
            },
          ]),
        );

        final asset = release.getAssetForPlatform('macos');
        expect(asset, isNotNull);
        expect(asset!.name, 'zajel-1.2.0-macos.zip');
      });
    });

    group('checksumsAsset', () {
      test('returns checksums.txt asset when present', () {
        final release = GitHubRelease.fromJson(createReleaseJson());
        final asset = release.checksumsAsset;

        expect(asset, isNotNull);
        expect(asset!.name, 'checksums.txt');
      });

      test('returns null when no checksums.txt', () {
        final release = GitHubRelease.fromJson(
          createReleaseJson(assets: [
            {
              'name': 'zajel-1.2.0-windows.zip',
              'browser_download_url': 'https://example.com/windows.zip',
              'size': 52000000,
            },
          ]),
        );

        expect(release.checksumsAsset, isNull);
      });
    });

    group('getChecksumForAsset', () {
      test('parses checksum with double-space separator', () {
        final release =
            GitHubRelease.fromJson(createReleaseJson()).withChecksumContent(
          'abc123def456789  zajel-1.2.0-windows.zip\n'
          'def789abc012345  zajel-1.2.0-macos.dmg\n'
          '012345def789abc  zajel-1.2.0-linux.tar.gz\n',
        );

        expect(release.getChecksumForAsset('zajel-1.2.0-windows.zip'),
            'abc123def456789');
        expect(release.getChecksumForAsset('zajel-1.2.0-macos.dmg'),
            'def789abc012345');
        expect(release.getChecksumForAsset('zajel-1.2.0-linux.tar.gz'),
            '012345def789abc');
      });

      test('handles single-space separator', () {
        final release =
            GitHubRelease.fromJson(createReleaseJson()).withChecksumContent(
          'abc123def456789 zajel-1.2.0-windows.zip\n',
        );

        expect(release.getChecksumForAsset('zajel-1.2.0-windows.zip'),
            'abc123def456789');
      });

      test('returns null for unknown asset', () {
        final release =
            GitHubRelease.fromJson(createReleaseJson()).withChecksumContent(
          'abc123  zajel-1.2.0-windows.zip\n',
        );

        expect(release.getChecksumForAsset('nonexistent.zip'), isNull);
      });

      test('returns null when checksumContent is null', () {
        final release = GitHubRelease.fromJson(createReleaseJson());
        expect(release.checksumContent, isNull);
        expect(release.getChecksumForAsset('zajel-1.2.0-windows.zip'), isNull);
      });

      test('handles empty lines and whitespace', () {
        final release =
            GitHubRelease.fromJson(createReleaseJson()).withChecksumContent(
          '\n'
          '  \n'
          'abc123  zajel-1.2.0-windows.zip\n'
          '\n'
          'def456  zajel-1.2.0-linux.tar.gz\n'
          '  \n',
        );

        expect(
            release.getChecksumForAsset('zajel-1.2.0-windows.zip'), 'abc123');
        expect(
            release.getChecksumForAsset('zajel-1.2.0-linux.tar.gz'), 'def456');
      });

      test('handles checksum file with Windows-style line endings', () {
        final release =
            GitHubRelease.fromJson(createReleaseJson()).withChecksumContent(
          'abc123  zajel-1.2.0-windows.zip\r\n'
          'def456  zajel-1.2.0-linux.tar.gz\r\n',
        );

        expect(
            release.getChecksumForAsset('zajel-1.2.0-windows.zip'), 'abc123');
      });
    });

    group('withChecksumContent', () {
      test('returns new release with checksum content attached', () {
        final original = GitHubRelease.fromJson(createReleaseJson());
        expect(original.checksumContent, isNull);

        final withChecksums = original.withChecksumContent('abc123  file.zip');
        expect(withChecksums.checksumContent, 'abc123  file.zip');

        // Other fields preserved
        expect(withChecksums.tagName, original.tagName);
        expect(withChecksums.version, original.version);
        expect(withChecksums.name, original.name);
        expect(withChecksums.body, original.body);
        expect(withChecksums.prerelease, original.prerelease);
        expect(withChecksums.draft, original.draft);
        expect(withChecksums.htmlUrl, original.htmlUrl);
        expect(withChecksums.publishedAt, original.publishedAt);
        expect(withChecksums.assets.length, original.assets.length);
      });
    });

    group('equality', () {
      test('equal releases are equal', () {
        final a = GitHubRelease.fromJson(createReleaseJson());
        final b = GitHubRelease.fromJson(createReleaseJson());

        expect(a, b);
        expect(a.hashCode, b.hashCode);
      });

      test('different releases are not equal', () {
        final a = GitHubRelease.fromJson(createReleaseJson(tagName: 'v1.0.0'));
        final b = GitHubRelease.fromJson(createReleaseJson(tagName: 'v2.0.0'));

        expect(a, isNot(b));
      });
    });

    group('toJson roundtrip', () {
      test('produces valid roundtrip', () {
        final original = GitHubRelease.fromJson(createReleaseJson());
        final json = original.toJson();
        final parsed = GitHubRelease.fromJson(json);

        expect(parsed.tagName, original.tagName);
        expect(parsed.name, original.name);
        expect(parsed.body, original.body);
        expect(parsed.prerelease, original.prerelease);
        expect(parsed.draft, original.draft);
        expect(parsed.htmlUrl, original.htmlUrl);
        expect(parsed.assets.length, original.assets.length);
      });
    });

    group('toString', () {
      test('includes key information', () {
        final release = GitHubRelease.fromJson(createReleaseJson());
        final str = release.toString();

        expect(str, contains('v1.2.0'));
        expect(str, contains('4')); // asset count
      });
    });
  });
}
