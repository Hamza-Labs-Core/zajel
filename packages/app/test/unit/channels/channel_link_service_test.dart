import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/channels/models/channel.dart';
import 'package:zajel/features/channels/services/channel_link_service.dart';

void main() {
  group('ChannelLinkService', () {
    final testManifest = ChannelManifest(
      channelId: 'test-channel-id-123',
      name: 'Test Channel',
      description: 'A test channel for unit tests',
      ownerKey: 'ownerKeyBase64==',
      currentEncryptKey: 'encryptKeyBase64==',
      keyEpoch: 1,
      rules: const ChannelRules(),
      signature: 'signatureBase64==',
    );

    final testChannel = Channel(
      id: 'test-channel-id-123',
      role: ChannelRole.owner,
      manifest: testManifest,
      ownerSigningKeyPrivate: 'ownerPrivateKey==',
      encryptionKeyPrivate: 'decryptionKeyBase64==',
      encryptionKeyPublic: 'encryptKeyBase64==',
      createdAt: DateTime(2026, 1, 1),
    );

    test('encode produces a zajel:// prefixed link', () {
      final link = ChannelLinkService.encode(testChannel);
      expect(link, startsWith('zajel://channel/'));
    });

    test('encode throws if channel has no encryption private key', () {
      final subscriberChannel = Channel(
        id: 'test-id',
        role: ChannelRole.subscriber,
        manifest: testManifest,
        encryptionKeyPublic: 'pubkey==',
        createdAt: DateTime(2026, 1, 1),
      );
      expect(
        () => ChannelLinkService.encode(subscriberChannel),
        throwsArgumentError,
      );
    });

    test('decode reverses encode', () {
      final link = ChannelLinkService.encode(testChannel);
      final decoded = ChannelLinkService.decode(link);

      expect(decoded.manifest.channelId, testManifest.channelId);
      expect(decoded.manifest.name, testManifest.name);
      expect(decoded.manifest.description, testManifest.description);
      expect(decoded.manifest.ownerKey, testManifest.ownerKey);
      expect(
          decoded.manifest.currentEncryptKey, testManifest.currentEncryptKey);
      expect(decoded.manifest.keyEpoch, testManifest.keyEpoch);
      expect(decoded.manifest.signature, testManifest.signature);
      expect(decoded.encryptionKey, 'decryptionKeyBase64==');
    });

    test('decode works with just the encoded payload (no prefix)', () {
      final link = ChannelLinkService.encode(testChannel);
      final payload = link.replaceFirst('zajel://channel/', '');
      final decoded = ChannelLinkService.decode(payload);

      expect(decoded.manifest.name, testManifest.name);
      expect(decoded.encryptionKey, 'decryptionKeyBase64==');
    });

    test('decode preserves admin keys', () {
      final manifestWithAdmins = testManifest.copyWith(
        adminKeys: [
          const AdminKey(key: 'adminKey1==', label: 'Alice'),
          const AdminKey(key: 'adminKey2==', label: 'Bob'),
        ],
      );
      final channelWithAdmins = testChannel.copyWith(
        manifest: manifestWithAdmins,
      );

      final link = ChannelLinkService.encode(channelWithAdmins);
      final decoded = ChannelLinkService.decode(link);

      expect(decoded.manifest.adminKeys.length, 2);
      expect(decoded.manifest.adminKeys[0].label, 'Alice');
      expect(decoded.manifest.adminKeys[1].label, 'Bob');
    });

    test('decode preserves rules', () {
      final manifestWithRules = testManifest.copyWith(
        rules: const ChannelRules(
          repliesEnabled: false,
          pollsEnabled: false,
          maxUpstreamSize: 8192,
        ),
      );
      final channelWithRules = testChannel.copyWith(
        manifest: manifestWithRules,
      );

      final link = ChannelLinkService.encode(channelWithRules);
      final decoded = ChannelLinkService.decode(link);

      expect(decoded.manifest.rules.repliesEnabled, false);
      expect(decoded.manifest.rules.pollsEnabled, false);
      expect(decoded.manifest.rules.maxUpstreamSize, 8192);
    });

    test('decode preserves allowedTypes in rules', () {
      final manifestWithTypes = testManifest.copyWith(
        rules: const ChannelRules(
          allowedTypes: ['text', 'file', 'audio'],
        ),
      );
      final channelWithTypes = testChannel.copyWith(
        manifest: manifestWithTypes,
      );

      final link = ChannelLinkService.encode(channelWithTypes);
      final decoded = ChannelLinkService.decode(link);

      expect(decoded.manifest.rules.allowedTypes, ['text', 'file', 'audio']);
    });

    test('decode defaults allowedTypes to ["text"] for old links', () {
      // Simulate an old link that has no allowed_types in rules
      final link = ChannelLinkService.encode(testChannel);
      final decoded = ChannelLinkService.decode(link);

      // Default rules have allowedTypes = ['text']
      expect(decoded.manifest.rules.allowedTypes, ['text']);
    });

    test('decode throws FormatException on invalid base64', () {
      expect(
        () => ChannelLinkService.decode('zajel://channel/!!!invalid!!!'),
        throwsFormatException,
      );
    });

    test('decode throws on invalid JSON payload', () {
      expect(
        () => ChannelLinkService.decode('zajel://channel/bm90LWpzb24'),
        throwsA(isA<Exception>()),
      );
    });

    test('isChannelLink correctly identifies links', () {
      expect(ChannelLinkService.isChannelLink('zajel://channel/abc'), true);
      expect(ChannelLinkService.isChannelLink('  zajel://channel/abc'), true);
      expect(ChannelLinkService.isChannelLink('https://example.com'), false);
      expect(ChannelLinkService.isChannelLink('random text'), false);
    });

    test('encoded link is reasonably compact', () {
      final link = ChannelLinkService.encode(testChannel);
      // Minimal channel should encode to well under 1000 chars
      expect(link.length, lessThan(1000));
    });
  });
}
