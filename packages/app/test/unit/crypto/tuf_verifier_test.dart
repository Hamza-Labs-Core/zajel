import 'dart:convert';

import 'package:crypto/crypto.dart' as crypto_hash;
import 'package:cryptography/cryptography.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/crypto/tuf/metadata_models.dart';
import 'package:zajel/core/crypto/tuf/tuf_verifier.dart';

/// Helper: Canonical JSON matching the server-side canonicalJSON() in metadata.js.
/// Keys are sorted alphabetically at all nesting levels.
String canonicalJson(dynamic obj) {
  if (obj == null) return 'null';
  if (obj is! Map && obj is! List) return jsonEncode(obj);
  if (obj is List) return '[${obj.map(canonicalJson).join(',')}]';
  final map = obj as Map<String, dynamic>;
  final keys = map.keys.toList()..sort();
  final pairs = keys.map((k) => '"$k":${canonicalJson(map[k])}');
  return '{${pairs.join(',')}}';
}

/// Helper: SHA256 hash of a string, returned as lowercase hex.
String sha256Hex(String data) {
  final bytes = utf8.encode(data);
  final digest = crypto_hash.sha256.convert(bytes);
  return digest.toString();
}

/// Generate a test Ed25519 keypair and return key material.
Future<TestKeyMaterial> generateTestKeypair() async {
  final ed25519 = Ed25519();
  final keyPair = await ed25519.newKeyPair();
  final publicKey = await keyPair.extractPublicKey();
  final pubBase64 = base64Encode(publicKey.bytes);

  // Compute keyid: SHA256 of canonical JSON of key object
  final tufKeyObj = {
    'keytype': 'ed25519',
    'keyval': pubBase64,
    'scheme': 'ed25519'
  };
  final keyid = sha256Hex(canonicalJson(tufKeyObj));

  return TestKeyMaterial(
    keyPair: keyPair,
    publicKey: publicKey,
    pubBase64: pubBase64,
    keyid: keyid,
  );
}

class TestKeyMaterial {
  final SimpleKeyPair keyPair;
  final SimplePublicKey publicKey;
  final String pubBase64;
  final String keyid;

  TestKeyMaterial({
    required this.keyPair,
    required this.publicKey,
    required this.pubBase64,
    required this.keyid,
  });
}

/// Sign a metadata object (as a Map) and return a SignedMetadata-style JSON map.
Future<Map<String, dynamic>> signMetadataMap(
  Map<String, dynamic> metadata,
  List<TestKeyMaterial> signers,
) async {
  final ed25519 = Ed25519();
  final canonical = canonicalJson(metadata);
  final data = utf8.encode(canonical);

  final signatures = <Map<String, dynamic>>[];
  for (final signer in signers) {
    final signature = await ed25519.sign(data, keyPair: signer.keyPair);
    signatures.add({
      'keyid': signer.keyid,
      'sig': base64Encode(signature.bytes),
    });
  }

  return {
    'signed': metadata,
    'signatures': signatures,
  };
}

/// Create root metadata JSON map with given role keys.
Map<String, dynamic> createRootMetadataMap({
  required int version,
  required int expirationDays,
  required TestKeyMaterial rootKey,
  required TestKeyMaterial targetsKey,
  required TestKeyMaterial snapshotKey,
  required TestKeyMaterial timestampKey,
}) {
  final expiry = DateTime.now().toUtc().add(Duration(days: expirationDays));

  return {
    '_type': 'root',
    'consistent_snapshot': false,
    'expires': expiry.toIso8601String(),
    'keys': {
      rootKey.keyid: {
        'keytype': 'ed25519',
        'keyval': rootKey.pubBase64,
        'scheme': 'ed25519'
      },
      targetsKey.keyid: {
        'keytype': 'ed25519',
        'keyval': targetsKey.pubBase64,
        'scheme': 'ed25519'
      },
      snapshotKey.keyid: {
        'keytype': 'ed25519',
        'keyval': snapshotKey.pubBase64,
        'scheme': 'ed25519'
      },
      timestampKey.keyid: {
        'keytype': 'ed25519',
        'keyval': timestampKey.pubBase64,
        'scheme': 'ed25519'
      },
    },
    'roles': {
      'root': {
        'keyids': [rootKey.keyid],
        'threshold': 1
      },
      'snapshot': {
        'keyids': [snapshotKey.keyid],
        'threshold': 1
      },
      'targets': {
        'keyids': [targetsKey.keyid],
        'threshold': 1
      },
      'timestamp': {
        'keyids': [timestampKey.keyid],
        'threshold': 1
      },
    },
    'spec_version': '1.0.31',
    'version': version,
  };
}

/// Create targets metadata JSON map.
Map<String, dynamic> createTargetsMetadataMap({
  required int version,
  int expirationDays = 30,
  Map<String, dynamic>? targets,
}) {
  final expiry = DateTime.now().toUtc().add(Duration(days: expirationDays));
  return {
    '_type': 'targets',
    'delegations': null,
    'expires': expiry.toIso8601String(),
    'spec_version': '1.0.31',
    'targets': targets ?? {},
    'version': version,
  };
}

/// Create snapshot metadata JSON map referencing signed targets.
Map<String, dynamic> createSnapshotMetadataMap({
  required int version,
  required Map<String, dynamic> signedTargets,
  int expirationDays = 7,
}) {
  final targetsCanonical = canonicalJson(signedTargets['signed']);
  final targetsHash = sha256Hex(targetsCanonical);
  final expiry = DateTime.now().toUtc().add(Duration(days: expirationDays));

  return {
    '_type': 'snapshot',
    'expires': expiry.toIso8601String(),
    'meta': {
      'targets.json': {
        'hashes': {'sha256': targetsHash},
        'version': signedTargets['signed']['version'],
      },
    },
    'spec_version': '1.0.31',
    'version': version,
  };
}

/// Create timestamp metadata JSON map referencing signed snapshot.
Map<String, dynamic> createTimestampMetadataMap({
  required int version,
  required Map<String, dynamic> signedSnapshot,
  int expirationHours = 24,
}) {
  final snapshotCanonical = canonicalJson(signedSnapshot['signed']);
  final snapshotHash = sha256Hex(snapshotCanonical);
  final expiry = DateTime.now().toUtc().add(Duration(hours: expirationHours));

  return {
    '_type': 'timestamp',
    'expires': expiry.toIso8601String(),
    'meta': {
      'snapshot.json': {
        'hashes': {'sha256': snapshotHash},
        'version': signedSnapshot['signed']['version'],
      },
    },
    'spec_version': '1.0.31',
    'version': version,
  };
}

void main() {
  late TestKeyMaterial rootKey;
  late TestKeyMaterial targetsKey;
  late TestKeyMaterial snapshotKey;
  late TestKeyMaterial timestampKey;

  setUp(() async {
    rootKey = await generateTestKeypair();
    targetsKey = await generateTestKeypair();
    snapshotKey = await generateTestKeypair();
    timestampKey = await generateTestKeypair();
  });

  Future<Map<String, dynamic>> createSignedRoot(
      {int version = 1,
      int expirationDays = 365,
      List<TestKeyMaterial>? signers}) async {
    final rootMeta = createRootMetadataMap(
      version: version,
      expirationDays: expirationDays,
      rootKey: rootKey,
      targetsKey: targetsKey,
      snapshotKey: snapshotKey,
      timestampKey: timestampKey,
    );
    return signMetadataMap(rootMeta, signers ?? [rootKey]);
  }

  Future<
      ({
        Map<String, dynamic> signedTargets,
        Map<String, dynamic> signedSnapshot,
        Map<String, dynamic> signedTimestamp,
      })> createFullChain({
    int version = 1,
    Map<String, dynamic>? targets,
  }) async {
    final targetsMeta =
        createTargetsMetadataMap(version: version, targets: targets);
    final signedTargets = await signMetadataMap(targetsMeta, [targetsKey]);

    final snapshotMeta = createSnapshotMetadataMap(
        version: version, signedTargets: signedTargets);
    final signedSnapshot = await signMetadataMap(snapshotMeta, [snapshotKey]);

    final timestampMeta = createTimestampMetadataMap(
        version: version, signedSnapshot: signedSnapshot);
    final signedTimestamp =
        await signMetadataMap(timestampMeta, [timestampKey]);

    return (
      signedTargets: signedTargets,
      signedSnapshot: signedSnapshot,
      signedTimestamp: signedTimestamp,
    );
  }

  group('TufVerifier - Bootstrap', () {
    test('should bootstrap with valid root metadata', () async {
      final verifier = TufVerifier();
      final signedRoot = await createSignedRoot();

      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
        signedRoot,
        RootMetadata.fromJson,
      );
      await verifier.bootstrapWithRoot(rootMetadata);

      expect(verifier.isBootstrapped, isTrue);
    });

    test('should reject bootstrap with invalid signature', () async {
      final verifier = TufVerifier();
      final rootMeta = createRootMetadataMap(
        version: 1,
        expirationDays: 365,
        rootKey: rootKey,
        targetsKey: targetsKey,
        snapshotKey: snapshotKey,
        timestampKey: timestampKey,
      );

      // Sign with WRONG key (targets key instead of root key)
      final badSignedRoot = await signMetadataMap(rootMeta, [targetsKey]);

      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
        badSignedRoot,
        RootMetadata.fromJson,
      );

      expect(
        () => verifier.bootstrapWithRoot(rootMetadata),
        throwsA(isA<TufVerificationException>().having(
            (e) => e.message, 'message', contains('invalid signatures'))),
      );
    });

    test('should reject bootstrap with expired root', () async {
      final verifier = TufVerifier();
      final rootMeta = createRootMetadataMap(
        version: 1,
        expirationDays: -1, // expired
        rootKey: rootKey,
        targetsKey: targetsKey,
        snapshotKey: snapshotKey,
        timestampKey: timestampKey,
      );
      final signedRoot = await signMetadataMap(rootMeta, [rootKey]);

      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
        signedRoot,
        RootMetadata.fromJson,
      );

      expect(
        () => verifier.bootstrapWithRoot(rootMetadata),
        throwsA(isA<TufVerificationException>()
            .having((e) => e.message, 'message', contains('expired'))),
      );
    });
  });

  group('TufVerifier - Root Key Rotation (N -> N+1)', () {
    test('should accept valid root rotation from v1 to v2', () async {
      final verifier = TufVerifier();

      // Bootstrap with v1
      final signedRootV1 = await createSignedRoot(version: 1);
      final rootV1 = SignedMetadata<RootMetadata>.fromJson(
          signedRootV1, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootV1);

      // Create v2 with new root key
      final newRootKey = await generateTestKeypair();
      final rootV2Meta = createRootMetadataMap(
        version: 2,
        expirationDays: 365,
        rootKey: newRootKey,
        targetsKey: targetsKey,
        snapshotKey: snapshotKey,
        timestampKey: timestampKey,
      );

      // Sign with both old and new root keys
      final signedRootV2 =
          await signMetadataMap(rootV2Meta, [rootKey, newRootKey]);
      final rootV2 = SignedMetadata<RootMetadata>.fromJson(
          signedRootV2, RootMetadata.fromJson);

      await verifier.updateRoot(rootV2);
      // Success: no exception thrown
    });

    test('should reject root v3 (must increment by 1)', () async {
      final verifier = TufVerifier();

      final signedRootV1 = await createSignedRoot(version: 1);
      final rootV1 = SignedMetadata<RootMetadata>.fromJson(
          signedRootV1, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootV1);

      // Try to jump to v3 (skipping v2)
      final rootV3Meta = createRootMetadataMap(
        version: 3,
        expirationDays: 365,
        rootKey: rootKey,
        targetsKey: targetsKey,
        snapshotKey: snapshotKey,
        timestampKey: timestampKey,
      );
      final signedRootV3 = await signMetadataMap(rootV3Meta, [rootKey]);
      final rootV3 = SignedMetadata<RootMetadata>.fromJson(
          signedRootV3, RootMetadata.fromJson);

      expect(
        () => verifier.updateRoot(rootV3),
        throwsA(isA<TufVerificationException>()
            .having((e) => e.message, 'message', contains('increment by 1'))),
      );
    });

    test('should reject root not signed by old root key', () async {
      final verifier = TufVerifier();

      final signedRootV1 = await createSignedRoot(version: 1);
      final rootV1 = SignedMetadata<RootMetadata>.fromJson(
          signedRootV1, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootV1);

      // Create v2 signed only by the NEW key (missing old key signature)
      final newRootKey = await generateTestKeypair();
      final rootV2Meta = createRootMetadataMap(
        version: 2,
        expirationDays: 365,
        rootKey: newRootKey,
        targetsKey: targetsKey,
        snapshotKey: snapshotKey,
        timestampKey: timestampKey,
      );
      final signedRootV2 =
          await signMetadataMap(rootV2Meta, [newRootKey]); // only new key!
      final rootV2 = SignedMetadata<RootMetadata>.fromJson(
          signedRootV2, RootMetadata.fromJson);

      expect(
        () => verifier.updateRoot(rootV2),
        throwsA(isA<TufVerificationException>().having(
            (e) => e.message, 'message', contains('not signed by old root'))),
      );
    });

    test('should reject expired new root', () async {
      final verifier = TufVerifier();

      final signedRootV1 = await createSignedRoot(version: 1);
      final rootV1 = SignedMetadata<RootMetadata>.fromJson(
          signedRootV1, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootV1);

      // Create v2 that is already expired
      final rootV2Meta = createRootMetadataMap(
        version: 2,
        expirationDays: -1,
        rootKey: rootKey,
        targetsKey: targetsKey,
        snapshotKey: snapshotKey,
        timestampKey: timestampKey,
      );
      final signedRootV2 = await signMetadataMap(rootV2Meta, [rootKey]);
      final rootV2 = SignedMetadata<RootMetadata>.fromJson(
          signedRootV2, RootMetadata.fromJson);

      expect(
        () => verifier.updateRoot(rootV2),
        throwsA(isA<TufVerificationException>()
            .having((e) => e.message, 'message', contains('expired'))),
      );
    });
  });

  group('TufVerifier - Full Chain Verification', () {
    test('should verify valid metadata chain and extract targets', () async {
      final verifier = TufVerifier();

      // Bootstrap
      final signedRoot = await createSignedRoot();
      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
          signedRoot, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootMetadata);

      // Create chain with a server target
      final serverTargets = {
        'servers/ed25519:srv1.json': {
          'custom': {
            'serverId': 'ed25519:srv1',
            'endpoint': 'wss://srv1.example.com',
            'publicKey': 'key1',
            'region': 'us-east',
          },
          'hashes': {'sha256': 'abc123'},
          'length': 100,
        },
      };

      final chain = await createFullChain(version: 1, targets: serverTargets);

      final timestamp = SignedMetadata<TimestampMetadata>.fromJson(
        chain.signedTimestamp,
        TimestampMetadata.fromJson,
      );
      final snapshot = SignedMetadata<SnapshotMetadata>.fromJson(
        chain.signedSnapshot,
        SnapshotMetadata.fromJson,
      );
      final targets = SignedMetadata<TargetsMetadata>.fromJson(
        chain.signedTargets,
        TargetsMetadata.fromJson,
      );

      final servers = await verifier.verifyAndExtractTargets(
        timestamp: timestamp,
        snapshot: snapshot,
        targets: targets,
      );

      expect(servers, hasLength(1));
      expect(servers[0]['serverId'], 'ed25519:srv1');
      expect(servers[0]['endpoint'], 'wss://srv1.example.com');
    });

    test('should reject expired timestamp (freeze attack)', () async {
      final verifier = TufVerifier();

      final signedRoot = await createSignedRoot();
      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
          signedRoot, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootMetadata);

      // Create targets and snapshot normally
      final targetsMeta = createTargetsMetadataMap(version: 1);
      final signedTargets = await signMetadataMap(targetsMeta, [targetsKey]);

      final snapshotMeta =
          createSnapshotMetadataMap(version: 1, signedTargets: signedTargets);
      final signedSnapshot = await signMetadataMap(snapshotMeta, [snapshotKey]);

      // Create EXPIRED timestamp
      final snapshotCanonical = canonicalJson(signedSnapshot['signed']);
      final snapshotHash = sha256Hex(snapshotCanonical);
      final expiredTimestamp = {
        '_type': 'timestamp',
        'expires': DateTime.now()
            .toUtc()
            .subtract(const Duration(hours: 1))
            .toIso8601String(),
        'meta': {
          'snapshot.json': {
            'hashes': {'sha256': snapshotHash},
            'version': 1,
          },
        },
        'spec_version': '1.0.31',
        'version': 1,
      };
      final signedTimestamp =
          await signMetadataMap(expiredTimestamp, [timestampKey]);

      final timestamp = SignedMetadata<TimestampMetadata>.fromJson(
        signedTimestamp,
        TimestampMetadata.fromJson,
      );
      final snapshot = SignedMetadata<SnapshotMetadata>.fromJson(
        signedSnapshot,
        SnapshotMetadata.fromJson,
      );
      final targets = SignedMetadata<TargetsMetadata>.fromJson(
        signedTargets,
        TargetsMetadata.fromJson,
      );

      expect(
        () => verifier.verifyAndExtractTargets(
          timestamp: timestamp,
          snapshot: snapshot,
          targets: targets,
        ),
        throwsA(isA<TufVerificationException>()
            .having((e) => e.message, 'message', contains('expired'))),
      );
    });

    test('should reject timestamp version rollback', () async {
      final verifier = TufVerifier();

      final signedRoot = await createSignedRoot();
      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
          signedRoot, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootMetadata);

      // First verify version 5
      final chain5 = await createFullChain(version: 5);
      final timestamp5 = SignedMetadata<TimestampMetadata>.fromJson(
          chain5.signedTimestamp, TimestampMetadata.fromJson);
      final snapshot5 = SignedMetadata<SnapshotMetadata>.fromJson(
          chain5.signedSnapshot, SnapshotMetadata.fromJson);
      final targets5 = SignedMetadata<TargetsMetadata>.fromJson(
          chain5.signedTargets, TargetsMetadata.fromJson);

      await verifier.verifyAndExtractTargets(
        timestamp: timestamp5,
        snapshot: snapshot5,
        targets: targets5,
      );

      // Now try version 3 (rollback)
      final chain3 = await createFullChain(version: 3);
      final timestamp3 = SignedMetadata<TimestampMetadata>.fromJson(
          chain3.signedTimestamp, TimestampMetadata.fromJson);
      final snapshot3 = SignedMetadata<SnapshotMetadata>.fromJson(
          chain3.signedSnapshot, SnapshotMetadata.fromJson);
      final targets3 = SignedMetadata<TargetsMetadata>.fromJson(
          chain3.signedTargets, TargetsMetadata.fromJson);

      expect(
        () => verifier.verifyAndExtractTargets(
          timestamp: timestamp3,
          snapshot: snapshot3,
          targets: targets3,
        ),
        throwsA(isA<TufVerificationException>()
            .having((e) => e.message, 'message', contains('rollback'))),
      );
    });

    test('should reject snapshot hash mismatch (mix-and-match attack)',
        () async {
      final verifier = TufVerifier();

      final signedRoot = await createSignedRoot();
      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
          signedRoot, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootMetadata);

      // Create legitimate chain
      final chain = await createFullChain(version: 1);

      // Create a DIFFERENT snapshot (attacker's version)
      final evilTargetsMeta = createTargetsMetadataMap(
        version: 1,
        targets: {
          'servers/evil.json': {
            'custom': {'serverId': 'evil', 'endpoint': 'wss://evil.com'},
            'hashes': {'sha256': 'deadbeef'},
            'length': 10,
          },
        },
      );
      final evilSignedTargets =
          await signMetadataMap(evilTargetsMeta, [targetsKey]);
      final evilSnapshotMeta = createSnapshotMetadataMap(
          version: 1, signedTargets: evilSignedTargets);
      final evilSignedSnapshot =
          await signMetadataMap(evilSnapshotMeta, [snapshotKey]);

      // Use legitimate timestamp but evil snapshot
      final timestamp = SignedMetadata<TimestampMetadata>.fromJson(
        chain.signedTimestamp,
        TimestampMetadata.fromJson,
      );
      final evilSnapshot = SignedMetadata<SnapshotMetadata>.fromJson(
        evilSignedSnapshot,
        SnapshotMetadata.fromJson,
      );
      final evilTargets = SignedMetadata<TargetsMetadata>.fromJson(
        evilSignedTargets,
        TargetsMetadata.fromJson,
      );

      expect(
        () => verifier.verifyAndExtractTargets(
          timestamp: timestamp,
          snapshot: evilSnapshot,
          targets: evilTargets,
        ),
        throwsA(isA<TufVerificationException>()
            .having((e) => e.message, 'message', contains('hash mismatch'))),
      );
    });

    test('should reject timestamp with invalid signature', () async {
      final verifier = TufVerifier();

      final signedRoot = await createSignedRoot();
      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
          signedRoot, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootMetadata);

      // Create chain, but sign timestamp with wrong key (targets key instead of timestamp key)
      final targetsMeta = createTargetsMetadataMap(version: 1);
      final signedTargets = await signMetadataMap(targetsMeta, [targetsKey]);

      final snapshotMeta =
          createSnapshotMetadataMap(version: 1, signedTargets: signedTargets);
      final signedSnapshot = await signMetadataMap(snapshotMeta, [snapshotKey]);

      final timestampMeta = createTimestampMetadataMap(
          version: 1, signedSnapshot: signedSnapshot);
      // Sign with WRONG key
      final badSignedTimestamp =
          await signMetadataMap(timestampMeta, [targetsKey]);

      final timestamp = SignedMetadata<TimestampMetadata>.fromJson(
        badSignedTimestamp,
        TimestampMetadata.fromJson,
      );
      final snapshot = SignedMetadata<SnapshotMetadata>.fromJson(
        signedSnapshot,
        SnapshotMetadata.fromJson,
      );
      final targets = SignedMetadata<TargetsMetadata>.fromJson(
        signedTargets,
        TargetsMetadata.fromJson,
      );

      expect(
        () => verifier.verifyAndExtractTargets(
          timestamp: timestamp,
          snapshot: snapshot,
          targets: targets,
        ),
        throwsA(isA<TufVerificationException>().having(
            (e) => e.message, 'message', contains('invalid signatures'))),
      );
    });

    test('should accept valid chain with multiple servers', () async {
      final verifier = TufVerifier();

      final signedRoot = await createSignedRoot();
      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
          signedRoot, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootMetadata);

      final serverTargets = {
        'servers/ed25519:srv1.json': {
          'custom': {
            'serverId': 'ed25519:srv1',
            'endpoint': 'wss://srv1.example.com',
            'region': 'us-east'
          },
          'hashes': {'sha256': 'h1'},
          'length': 50,
        },
        'servers/ed25519:srv2.json': {
          'custom': {
            'serverId': 'ed25519:srv2',
            'endpoint': 'wss://srv2.example.com',
            'region': 'eu-west'
          },
          'hashes': {'sha256': 'h2'},
          'length': 50,
        },
        'servers/ed25519:srv3.json': {
          'custom': {
            'serverId': 'ed25519:srv3',
            'endpoint': 'wss://srv3.example.com',
            'region': 'ap-south'
          },
          'hashes': {'sha256': 'h3'},
          'length': 50,
        },
      };

      final chain = await createFullChain(version: 1, targets: serverTargets);

      final timestamp = SignedMetadata<TimestampMetadata>.fromJson(
          chain.signedTimestamp, TimestampMetadata.fromJson);
      final snapshot = SignedMetadata<SnapshotMetadata>.fromJson(
          chain.signedSnapshot, SnapshotMetadata.fromJson);
      final targets = SignedMetadata<TargetsMetadata>.fromJson(
          chain.signedTargets, TargetsMetadata.fromJson);

      final servers = await verifier.verifyAndExtractTargets(
        timestamp: timestamp,
        snapshot: snapshot,
        targets: targets,
      );

      expect(servers, hasLength(3));
      final ids = servers.map((s) => s['serverId'] as String).toSet();
      expect(
          ids, containsAll(['ed25519:srv1', 'ed25519:srv2', 'ed25519:srv3']));
    });

    test('should accept version increment after previous verification',
        () async {
      final verifier = TufVerifier();

      final signedRoot = await createSignedRoot();
      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
          signedRoot, RootMetadata.fromJson);
      await verifier.bootstrapWithRoot(rootMetadata);

      // Verify v1
      final chain1 = await createFullChain(version: 1);
      final t1 = SignedMetadata<TimestampMetadata>.fromJson(
          chain1.signedTimestamp, TimestampMetadata.fromJson);
      final s1 = SignedMetadata<SnapshotMetadata>.fromJson(
          chain1.signedSnapshot, SnapshotMetadata.fromJson);
      final g1 = SignedMetadata<TargetsMetadata>.fromJson(
          chain1.signedTargets, TargetsMetadata.fromJson);
      await verifier.verifyAndExtractTargets(
          timestamp: t1, snapshot: s1, targets: g1);

      // Verify v2 (should work)
      final chain2 = await createFullChain(version: 2);
      final t2 = SignedMetadata<TimestampMetadata>.fromJson(
          chain2.signedTimestamp, TimestampMetadata.fromJson);
      final s2 = SignedMetadata<SnapshotMetadata>.fromJson(
          chain2.signedSnapshot, SnapshotMetadata.fromJson);
      final g2 = SignedMetadata<TargetsMetadata>.fromJson(
          chain2.signedTargets, TargetsMetadata.fromJson);
      final servers = await verifier.verifyAndExtractTargets(
          timestamp: t2, snapshot: s2, targets: g2);

      expect(servers, isNotNull);
    });
  });

  group('TufVerifier - Error handling', () {
    test('should throw when verifying without bootstrap', () async {
      final verifier = TufVerifier();

      final chain = await createFullChain(version: 1);
      final timestamp = SignedMetadata<TimestampMetadata>.fromJson(
          chain.signedTimestamp, TimestampMetadata.fromJson);
      final snapshot = SignedMetadata<SnapshotMetadata>.fromJson(
          chain.signedSnapshot, SnapshotMetadata.fromJson);
      final targets = SignedMetadata<TargetsMetadata>.fromJson(
          chain.signedTargets, TargetsMetadata.fromJson);

      expect(
        () => verifier.verifyAndExtractTargets(
            timestamp: timestamp, snapshot: snapshot, targets: targets),
        throwsA(isA<TufVerificationException>()
            .having((e) => e.message, 'message', contains('No trusted root'))),
      );
    });

    test('should throw when updating root without bootstrap', () async {
      final verifier = TufVerifier();

      final signedRoot = await createSignedRoot(version: 2);
      final rootMetadata = SignedMetadata<RootMetadata>.fromJson(
          signedRoot, RootMetadata.fromJson);

      expect(
        () => verifier.updateRoot(rootMetadata),
        throwsA(isA<TufVerificationException>()
            .having((e) => e.message, 'message', contains('No trusted root'))),
      );
    });
  });

  group('Metadata Models - Serialization', () {
    test('TufKey round-trip', () {
      const key = TufKey(keytype: 'ed25519', scheme: 'ed25519', keyval: 'test');
      final json = key.toJson();
      final restored = TufKey.fromJson(json);
      expect(restored.keytype, 'ed25519');
      expect(restored.scheme, 'ed25519');
      expect(restored.keyval, 'test');
    });

    test('TufRole round-trip', () {
      const role = TufRole(threshold: 2, keyids: ['k1', 'k2']);
      final json = role.toJson();
      final restored = TufRole.fromJson(json);
      expect(restored.threshold, 2);
      expect(restored.keyids, ['k1', 'k2']);
    });

    test('SignedMetadata round-trip', () {
      final json = <String, dynamic>{
        'signed': <String, dynamic>{
          '_type': 'root',
          'spec_version': '1.0.31',
          'version': 1,
          'expires': '2027-01-01T00:00:00.000Z',
          'keys': <String, dynamic>{},
          'roles': <String, dynamic>{
            'root': <String, dynamic>{'threshold': 1, 'keyids': <String>[]},
            'targets': <String, dynamic>{'threshold': 1, 'keyids': <String>[]},
            'snapshot': <String, dynamic>{'threshold': 1, 'keyids': <String>[]},
            'timestamp': <String, dynamic>{
              'threshold': 1,
              'keyids': <String>[]
            },
          },
          'consistent_snapshot': false,
        },
        'signatures': <dynamic>[
          <String, dynamic>{'keyid': 'test-keyid', 'sig': 'dGVzdA=='},
        ],
      };

      final signed =
          SignedMetadata<RootMetadata>.fromJson(json, RootMetadata.fromJson);
      expect(signed.signed.type, 'root');
      expect(signed.signed.version, 1);
      expect(signed.signatures, hasLength(1));
      expect(signed.signatures[0].keyid, 'test-keyid');
    });

    test('TufKey toJson produces canonically sorted keys', () {
      const key = TufKey(keytype: 'ed25519', scheme: 'ed25519', keyval: 'test');
      final json = key.toJson();
      final keys = json.keys.toList();
      // Should be sorted: keytype, keyval, scheme
      expect(keys, ['keytype', 'keyval', 'scheme']);
    });

    test('RootMetadata toJson produces canonically sorted keys', () {
      final meta = RootMetadata.fromJson(<String, dynamic>{
        '_type': 'root',
        'spec_version': '1.0.31',
        'version': 1,
        'expires': '2027-01-01T00:00:00.000Z',
        'keys': <String, dynamic>{},
        'roles': <String, dynamic>{},
        'consistent_snapshot': false,
      });
      final json = meta.toJson();
      final keys = json.keys.toList();
      // Should be sorted: _type, consistent_snapshot, expires, keys, roles, spec_version, version
      expect(keys, [
        '_type',
        'consistent_snapshot',
        'expires',
        'keys',
        'roles',
        'spec_version',
        'version'
      ]);
    });
  });
}
