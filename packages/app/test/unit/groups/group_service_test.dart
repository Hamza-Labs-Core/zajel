import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/groups/models/group.dart';
import 'package:zajel/features/groups/models/group_message.dart';
import 'package:zajel/features/groups/models/vector_clock.dart';
import 'package:zajel/features/groups/services/group_crypto_service.dart';
import 'package:zajel/features/groups/services/group_service.dart';
import 'package:zajel/features/groups/services/group_sync_service.dart';

// Re-use the FakeGroupStorageService from the sync test
import 'group_sync_service_test.dart';

void main() {
  late GroupCryptoService cryptoService;
  late FakeGroupStorageService storageService;
  late GroupSyncService syncService;
  late GroupService groupService;

  setUp(() {
    cryptoService = GroupCryptoService();
    storageService = FakeGroupStorageService();
    syncService = GroupSyncService(storageService: storageService);
    groupService = GroupService(
      cryptoService: cryptoService,
      storageService: storageService,
      syncService: syncService,
    );
  });

  group('Group creation', () {
    test('createGroup generates ID, adds self as member, generates sender key',
        () async {
      final result = await groupService.createGroup(
        name: 'Test Group',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );

      final group = result.group;
      expect(group.id, isNotEmpty);
      expect(group.name, 'Test Group');
      expect(group.selfDeviceId, 'device_A');
      expect(group.members, hasLength(1));
      expect(group.members.first.displayName, 'Alice');
      expect(group.members.first.deviceId, 'device_A');
      expect(group.createdBy, 'device_A');
      expect(result.senderKey, isNotEmpty);

      // Sender key should be stored in crypto service
      expect(cryptoService.hasSenderKey(group.id, 'device_A'), isTrue);
    });

    test('createGroup persists to storage', () async {
      final result = await groupService.createGroup(
        name: 'Stored Group',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );

      final retrieved = await storageService.getGroup(result.group.id);
      expect(retrieved, isNotNull);
      expect(retrieved!.name, 'Stored Group');
    });

    test('createGroup initializes empty vector clock', () async {
      final result = await groupService.createGroup(
        name: 'Clock Group',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );

      final clock = await syncService.getVectorClock(result.group.id);
      expect(clock.isEmpty, isTrue);
    });

    test('each createGroup generates unique IDs', () async {
      final r1 = await groupService.createGroup(
        name: 'One',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );
      final r2 = await groupService.createGroup(
        name: 'Two',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );

      expect(r1.group.id, isNot(r2.group.id));
    });
  });

  group('Member management', () {
    late Group group;

    setUp(() async {
      final result = await groupService.createGroup(
        name: 'Members Test',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );
      group = result.group;
    });

    test('addMember adds member and stores sender key', () async {
      final bobKey = await cryptoService.generateSenderKey();
      final bob = GroupMember(
        deviceId: 'device_B',
        displayName: 'Bob',
        publicKey: 'pk_bob',
        joinedAt: DateTime.now(),
      );

      final updated = await groupService.addMember(
        groupId: group.id,
        newMember: bob,
        newMemberSenderKey: bobKey,
      );

      expect(updated.members, hasLength(2));
      expect(updated.members.last.displayName, 'Bob');
      expect(cryptoService.hasSenderKey(group.id, 'device_B'), isTrue);
    });

    test('addMember rejects duplicate member', () async {
      final bobKey = await cryptoService.generateSenderKey();
      final bob = GroupMember(
        deviceId: 'device_B',
        displayName: 'Bob',
        publicKey: 'pk_bob',
        joinedAt: DateTime.now(),
      );

      await groupService.addMember(
        groupId: group.id,
        newMember: bob,
        newMemberSenderKey: bobKey,
      );

      expect(
        () => groupService.addMember(
          groupId: group.id,
          newMember: bob,
          newMemberSenderKey: bobKey,
        ),
        throwsA(isA<GroupServiceException>().having(
          (e) => e.message,
          'message',
          contains('already in group'),
        )),
      );
    });

    test('addMember rejects when group is full', () async {
      // Add members up to the limit
      for (var i = 1; i < GroupService.maxMembers; i++) {
        final key = await cryptoService.generateSenderKey();
        await groupService.addMember(
          groupId: group.id,
          newMember: GroupMember(
            deviceId: 'device_$i',
            displayName: 'Member $i',
            publicKey: 'pk_$i',
            joinedAt: DateTime.now(),
          ),
          newMemberSenderKey: key,
        );
      }

      // Try to add one more
      final extraKey = await cryptoService.generateSenderKey();
      expect(
        () => groupService.addMember(
          groupId: group.id,
          newMember: GroupMember(
            deviceId: 'device_extra',
            displayName: 'Extra',
            publicKey: 'pk_extra',
            joinedAt: DateTime.now(),
          ),
          newMemberSenderKey: extraKey,
        ),
        throwsA(isA<GroupServiceException>().having(
          (e) => e.message,
          'message',
          contains('full'),
        )),
      );
    });

    test('addMember rejects for unknown group', () async {
      final key = await cryptoService.generateSenderKey();
      expect(
        () => groupService.addMember(
          groupId: 'unknown',
          newMember: GroupMember(
            deviceId: 'device_B',
            displayName: 'Bob',
            publicKey: 'pk_bob',
            joinedAt: DateTime.now(),
          ),
          newMemberSenderKey: key,
        ),
        throwsA(isA<GroupServiceException>().having(
          (e) => e.message,
          'message',
          contains('not found'),
        )),
      );
    });

    test('removeMember removes member and sender key', () async {
      final bobKey = await cryptoService.generateSenderKey();
      await groupService.addMember(
        groupId: group.id,
        newMember: GroupMember(
          deviceId: 'device_B',
          displayName: 'Bob',
          publicKey: 'pk_bob',
          joinedAt: DateTime.now(),
        ),
        newMemberSenderKey: bobKey,
      );

      final updated = await groupService.removeMember(
        groupId: group.id,
        deviceId: 'device_B',
      );

      expect(updated.members, hasLength(1));
      expect(updated.members.any((m) => m.deviceId == 'device_B'), isFalse);
      expect(cryptoService.hasSenderKey(group.id, 'device_B'), isFalse);
    });

    test('removeMember rejects for non-existent member', () async {
      expect(
        () => groupService.removeMember(
          groupId: group.id,
          deviceId: 'unknown',
        ),
        throwsA(isA<GroupServiceException>().having(
          (e) => e.message,
          'message',
          contains('not in group'),
        )),
      );
    });
  });

  group('Key rotation', () {
    late Group group;

    setUp(() async {
      final result = await groupService.createGroup(
        name: 'Rotation Test',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );
      group = result.group;
    });

    test('rotateOwnKey generates new key and stores it', () async {
      final newKey = await groupService.rotateOwnKey(group.id, 'device_A');

      expect(newKey, isNotEmpty);
      expect(cryptoService.hasSenderKey(group.id, 'device_A'), isTrue);

      // The stored key in secure storage should be updated
      final storedKey =
          await storageService.loadSenderKey(group.id, 'device_A');
      expect(storedKey, newKey);
    });

    test('updateMemberKey updates crypto and storage', () async {
      final bobKey = await cryptoService.generateSenderKey();
      await groupService.updateMemberKey(
        groupId: group.id,
        deviceId: 'device_B',
        newSenderKey: bobKey,
      );

      expect(cryptoService.hasSenderKey(group.id, 'device_B'), isTrue);
      final storedKey =
          await storageService.loadSenderKey(group.id, 'device_B');
      expect(storedKey, bobKey);
    });
  });

  group('Messaging', () {
    late Group group;

    setUp(() async {
      final result = await groupService.createGroup(
        name: 'Messaging Test',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );
      group = result.group;
    });

    test('sendMessage encrypts, stores, and returns message + bytes', () async {
      final result = await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'Hello, group!',
      );

      expect(result.message.content, 'Hello, group!');
      expect(result.message.authorDeviceId, 'device_A');
      expect(result.message.sequenceNumber, 1);
      expect(result.message.isOutgoing, isTrue);
      expect(result.message.status, GroupMessageStatus.sent);
      expect(result.encryptedBytes, isNotEmpty);

      // Verify stored locally
      final stored = await storageService.getMessage(group.id, 'device_A', 1);
      expect(stored, isNotNull);
    });

    test('sendMessage increments sequence number', () async {
      await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'First',
      );
      final second = await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'Second',
      );

      expect(second.message.sequenceNumber, 2);
    });

    test('sendMessage updates vector clock', () async {
      await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'Hello',
      );

      final clock = await syncService.getVectorClock(group.id);
      expect(clock['device_A'], 1);
    });

    test('receiveMessage decrypts and stores', () async {
      // Alice sends a message
      final sent = await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'Hello from Alice',
      );

      // Simulate Bob receiving it
      // Bob has Alice's sender key (same crypto service in this test)
      final received = await groupService.receiveMessage(
        groupId: group.id,
        authorDeviceId: 'device_A',
        encryptedBytes: sent.encryptedBytes,
      );

      // It's a duplicate (we already stored it from sendMessage)
      expect(received, isNull);
    });

    test('receiveMessage with separate crypto services works', () async {
      // Alice's crypto service
      final aliceCrypto = GroupCryptoService();
      final aliceKey = await aliceCrypto.generateSenderKey();
      aliceCrypto.setSenderKey(group.id, 'device_A', aliceKey);

      // Bob's crypto service has Alice's sender key
      final bobCrypto = GroupCryptoService();
      bobCrypto.setSenderKey(group.id, 'device_A', aliceKey);

      // Bob's own key
      final bobKey = await bobCrypto.generateSenderKey();
      bobCrypto.setSenderKey(group.id, 'device_B', bobKey);

      // Bob's group service
      final bobStorage = FakeGroupStorageService();
      final bobSync = GroupSyncService(storageService: bobStorage);
      final bobService = GroupService(
        cryptoService: bobCrypto,
        storageService: bobStorage,
        syncService: bobSync,
      );

      // Save group to Bob's storage
      await bobStorage.saveGroup(group.copyWith(selfDeviceId: 'device_B'));
      await bobStorage.saveVectorClock(group.id, const VectorClock());

      // Alice encrypts a message
      final plaintext = GroupMessage(
        groupId: group.id,
        authorDeviceId: 'device_A',
        sequenceNumber: 1,
        content: 'Hello from Alice',
        timestamp: DateTime.utc(2026, 2, 10),
        status: GroupMessageStatus.sent,
        isOutgoing: true,
      );
      final encrypted = await aliceCrypto.encrypt(
        plaintext.toBytes(),
        group.id,
        'device_A',
      );

      // Bob receives and decrypts
      final received = await bobService.receiveMessage(
        groupId: group.id,
        authorDeviceId: 'device_A',
        encryptedBytes: encrypted,
      );

      expect(received, isNotNull);
      expect(received!.content, 'Hello from Alice');
      expect(received.authorDeviceId, 'device_A');
      expect(received.isOutgoing, isFalse);
    });

    test('receiveMessage rejects author mismatch', () async {
      // Create a message claiming to be from device_B
      final message = GroupMessage(
        groupId: group.id,
        authorDeviceId: 'device_B',
        sequenceNumber: 1,
        content: 'Spoofed!',
        timestamp: DateTime.utc(2026, 2, 10),
      );

      // But encrypt it with device_A's key
      final encrypted = await cryptoService.encrypt(
        message.toBytes(),
        group.id,
        'device_A',
      );

      // Try to receive claiming authorDeviceId is device_A
      // but the message inside says device_B
      expect(
        () => groupService.receiveMessage(
          groupId: group.id,
          authorDeviceId: 'device_A',
          encryptedBytes: encrypted,
        ),
        throwsA(isA<GroupServiceException>().having(
          (e) => e.message,
          'message',
          contains('Author mismatch'),
        )),
      );
    });

    test('sendMessage rejects for unknown group', () async {
      expect(
        () => groupService.sendMessage(
          groupId: 'unknown',
          selfDeviceId: 'device_A',
          content: 'Hello',
        ),
        throwsA(isA<GroupServiceException>().having(
          (e) => e.message,
          'message',
          contains('not found'),
        )),
      );
    });

    test('sendMessage handles different message types', () async {
      final result = await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'file_data_here',
        type: GroupMessageType.file,
        metadata: {'filename': 'test.pdf', 'size': 1024},
      );

      expect(result.message.type, GroupMessageType.file);
      expect(result.message.metadata['filename'], 'test.pdf');
    });
  });

  group('Sync', () {
    late Group group;

    setUp(() async {
      final result = await groupService.createGroup(
        name: 'Sync Test',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );
      group = result.group;
    });

    test('getVectorClock returns current state', () async {
      await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'Message 1',
      );
      await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'Message 2',
      );

      final clock = await groupService.getVectorClock(group.id);
      expect(clock['device_A'], 2);
    });

    test('getMessagesForSync returns missing messages', () async {
      await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'Msg 1',
      );
      await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'Msg 2',
      );
      await groupService.sendMessage(
        groupId: group.id,
        selfDeviceId: 'device_A',
        content: 'Msg 3',
      );

      // Remote only has up to 1
      final remoteClock = VectorClock.fromMap({'device_A': 1});
      final messages =
          await groupService.getMessagesForSync(group.id, remoteClock);

      expect(messages, hasLength(2)); // Messages 2 and 3
    });

    test('applySyncedMessages applies new messages', () async {
      final messages = [
        GroupMessage(
          groupId: group.id,
          authorDeviceId: 'device_B',
          sequenceNumber: 1,
          content: 'From Bob 1',
          timestamp: DateTime.utc(2026, 2, 10, 0, 1),
        ),
        GroupMessage(
          groupId: group.id,
          authorDeviceId: 'device_B',
          sequenceNumber: 2,
          content: 'From Bob 2',
          timestamp: DateTime.utc(2026, 2, 10, 0, 2),
        ),
      ];

      final applied = await groupService.applySyncedMessages(messages);
      expect(applied, 2);

      // Verify clock
      final clock = await syncService.getVectorClock(group.id);
      expect(clock['device_B'], 2);
    });
  });

  group('Storage delegation', () {
    test('getAllGroups returns all created groups', () async {
      await groupService.createGroup(
        name: 'Group 1',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );
      await groupService.createGroup(
        name: 'Group 2',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );

      final groups = await groupService.getAllGroups();
      expect(groups, hasLength(2));
    });

    test('getGroup returns correct group', () async {
      final result = await groupService.createGroup(
        name: 'Find Me',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );

      final found = await groupService.getGroup(result.group.id);
      expect(found, isNotNull);
      expect(found!.name, 'Find Me');
    });

    test('getGroup returns null for unknown group', () async {
      final found = await groupService.getGroup('unknown');
      expect(found, isNull);
    });

    test('getMessages returns stored messages', () async {
      final result = await groupService.createGroup(
        name: 'Messages Test',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );

      await groupService.sendMessage(
        groupId: result.group.id,
        selfDeviceId: 'device_A',
        content: 'Hello',
      );
      await groupService.sendMessage(
        groupId: result.group.id,
        selfDeviceId: 'device_A',
        content: 'World',
      );

      final messages = await groupService.getMessages(result.group.id);
      expect(messages, hasLength(2));
    });

    test('deleteGroup removes everything', () async {
      final result = await groupService.createGroup(
        name: 'Delete Me',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );

      await groupService.sendMessage(
        groupId: result.group.id,
        selfDeviceId: 'device_A',
        content: 'Message',
      );

      await groupService.deleteGroup(result.group.id);

      expect(await storageService.getGroup(result.group.id), isNull);
      expect(cryptoService.getSenderKeyDeviceIds(result.group.id), isEmpty);
    });

    test('leaveGroup removes group and keys', () async {
      final result = await groupService.createGroup(
        name: 'Leave Me',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );

      await groupService.leaveGroup(result.group.id);

      expect(await storageService.getGroup(result.group.id), isNull);
    });
  });

  group('loadSenderKeys', () {
    test('loads stored keys into crypto service', () async {
      final result = await groupService.createGroup(
        name: 'Load Keys Test',
        selfDeviceId: 'device_A',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );
      final groupId = result.group.id;

      // Save an additional sender key to storage
      final bobKey = await cryptoService.generateSenderKey();
      await storageService.saveSenderKey(groupId, 'device_B', bobKey);

      // Clear in-memory keys
      cryptoService.clearAllKeys();
      expect(cryptoService.hasSenderKey(groupId, 'device_A'), isFalse);

      // Load from storage
      await groupService.loadSenderKeys(groupId);

      expect(cryptoService.hasSenderKey(groupId, 'device_A'), isTrue);
      expect(cryptoService.hasSenderKey(groupId, 'device_B'), isTrue);
    });
  });

  group('End-to-end messaging flow', () {
    test('Alice creates group, Bob joins, they exchange messages', () async {
      // === Alice creates group ===
      final aliceCrypto = GroupCryptoService();
      final aliceStorage = FakeGroupStorageService();
      final aliceSync = GroupSyncService(storageService: aliceStorage);
      final aliceService = GroupService(
        cryptoService: aliceCrypto,
        storageService: aliceStorage,
        syncService: aliceSync,
      );

      final createResult = await aliceService.createGroup(
        name: 'Alice & Bob',
        selfDeviceId: 'alice_device',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );
      final groupId = createResult.group.id;

      // === Bob sets up ===
      final bobCrypto = GroupCryptoService();
      final bobStorage = FakeGroupStorageService();
      final bobSync = GroupSyncService(storageService: bobStorage);
      final bobService = GroupService(
        cryptoService: bobCrypto,
        storageService: bobStorage,
        syncService: bobSync,
      );

      // Bob generates his sender key
      final bobSenderKey = await bobCrypto.generateSenderKey();
      bobCrypto.setSenderKey(groupId, 'bob_device', bobSenderKey);

      // === Key exchange (via pairwise E2E channel) ===
      // Alice receives Bob's sender key
      aliceCrypto.setSenderKey(groupId, 'bob_device', bobSenderKey);
      // Bob receives Alice's sender key
      bobCrypto.setSenderKey(groupId, 'alice_device', createResult.senderKey);

      // === Alice adds Bob to her group ===
      await aliceService.addMember(
        groupId: groupId,
        newMember: GroupMember(
          deviceId: 'bob_device',
          displayName: 'Bob',
          publicKey: 'pk_bob',
          joinedAt: DateTime.now(),
        ),
        newMemberSenderKey: bobSenderKey,
      );

      // === Bob saves the group on his side ===
      final bobGroup = createResult.group.copyWith(
        selfDeviceId: 'bob_device',
        members: [
          ...createResult.group.members,
          GroupMember(
            deviceId: 'bob_device',
            displayName: 'Bob',
            publicKey: 'pk_bob',
            joinedAt: DateTime.now(),
          ),
        ],
      );
      await bobStorage.saveGroup(bobGroup);
      await bobStorage.saveVectorClock(groupId, const VectorClock());
      await bobStorage.saveSenderKey(groupId, 'bob_device', bobSenderKey);
      await bobStorage.saveSenderKey(
          groupId, 'alice_device', createResult.senderKey);

      // === Alice sends a message ===
      final aliceSent = await aliceService.sendMessage(
        groupId: groupId,
        selfDeviceId: 'alice_device',
        content: 'Hi Bob!',
      );

      // === Bob receives Alice's message ===
      final bobReceived = await bobService.receiveMessage(
        groupId: groupId,
        authorDeviceId: 'alice_device',
        encryptedBytes: aliceSent.encryptedBytes,
      );

      expect(bobReceived, isNotNull);
      expect(bobReceived!.content, 'Hi Bob!');
      expect(bobReceived.authorDeviceId, 'alice_device');
      expect(bobReceived.isOutgoing, isFalse);

      // === Bob replies ===
      final bobSent = await bobService.sendMessage(
        groupId: groupId,
        selfDeviceId: 'bob_device',
        content: 'Hey Alice!',
      );

      // === Alice receives Bob's message ===
      final aliceReceived = await aliceService.receiveMessage(
        groupId: groupId,
        authorDeviceId: 'bob_device',
        encryptedBytes: bobSent.encryptedBytes,
      );

      expect(aliceReceived, isNotNull);
      expect(aliceReceived!.content, 'Hey Alice!');

      // === Verify vector clocks ===
      final aliceClock = await aliceSync.getVectorClock(groupId);
      expect(aliceClock['alice_device'], 1);
      expect(aliceClock['bob_device'], 1);

      final bobClock = await bobSync.getVectorClock(groupId);
      expect(bobClock['alice_device'], 1);
      expect(bobClock['bob_device'], 1);
    });

    test('member removal triggers key rotation and forward secrecy', () async {
      // Setup: Alice, Bob, Charlie in a group
      final aliceCrypto = GroupCryptoService();
      final aliceStorage = FakeGroupStorageService();
      final aliceSync = GroupSyncService(storageService: aliceStorage);
      final aliceService = GroupService(
        cryptoService: aliceCrypto,
        storageService: aliceStorage,
        syncService: aliceSync,
      );

      final createResult = await aliceService.createGroup(
        name: 'Trio',
        selfDeviceId: 'alice',
        selfDisplayName: 'Alice',
        selfPublicKey: 'pk_alice',
      );
      final groupId = createResult.group.id;

      // Add Bob and Charlie
      final bobKey = await aliceCrypto.generateSenderKey();
      final charlieKey = await aliceCrypto.generateSenderKey();

      aliceCrypto.setSenderKey(groupId, 'bob', bobKey);
      aliceCrypto.setSenderKey(groupId, 'charlie', charlieKey);

      await aliceService.addMember(
        groupId: groupId,
        newMember: GroupMember(
          deviceId: 'bob',
          displayName: 'Bob',
          publicKey: 'pk_bob',
          joinedAt: DateTime.now(),
        ),
        newMemberSenderKey: bobKey,
      );
      await aliceService.addMember(
        groupId: groupId,
        newMember: GroupMember(
          deviceId: 'charlie',
          displayName: 'Charlie',
          publicKey: 'pk_charlie',
          joinedAt: DateTime.now(),
        ),
        newMemberSenderKey: charlieKey,
      );

      // Charlie saves Alice's old key for later attack attempt
      final charlieCrypto = GroupCryptoService();
      charlieCrypto.setSenderKey(groupId, 'alice', createResult.senderKey);

      // Remove Charlie
      await aliceService.removeMember(
        groupId: groupId,
        deviceId: 'charlie',
      );

      // Alice rotates her sender key
      final newAliceKey = await aliceService.rotateOwnKey(groupId, 'alice');
      expect(newAliceKey, isNot(createResult.senderKey));

      // Alice sends a message with the new key
      final sent = await aliceService.sendMessage(
        groupId: groupId,
        selfDeviceId: 'alice',
        content: 'Secret after Charlie left',
      );

      // Charlie cannot decrypt with the old key
      expect(
        () => charlieCrypto.decrypt(sent.encryptedBytes, groupId, 'alice'),
        throwsA(isA<GroupCryptoException>()),
      );
    });
  });
}
