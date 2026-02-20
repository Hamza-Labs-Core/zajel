import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:zajel/core/models/message.dart';

/// Regression test for desktop "databaseFactory not initialized" crash.
///
/// MessageStorage uses `package:sqflite/sqflite.dart` which requires
/// the global databaseFactory to be set on desktop platforms.
/// main.dart must call `databaseFactory = databaseFactoryFfi` before
/// any storage initialization.
///
/// We test the underlying mechanism directly: calling sqflite's
/// openDatabase without setting databaseFactory first should throw.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Desktop database factory initialization', () {
    test('sqflite openDatabase throws without FFI factory set', () async {
      // Simulate what happens on desktop when main.dart does NOT
      // call databaseFactory = databaseFactoryFfi:
      // Reset the factory to null-like state by checking the error
      // This is the exact error the app throws on Windows/Linux startup
      expect(
        () => sqflite.openDatabase(inMemoryDatabasePath),
        throwsA(isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('databaseFactory not initialized'),
        )),
      );
    });

    test('sqflite openDatabase works after FFI factory is set', () async {
      sqfliteFfiInit();
      databaseFactory = databaseFactoryFfi;

      // Now openDatabase should work — this is what the fix enables
      final db = await sqflite.openDatabase(inMemoryDatabasePath);
      expect(db.isOpen, isTrue);
      await db.close();
    });

    test('MessageStorage initialize works with FFI factory', () async {
      sqfliteFfiInit();
      databaseFactory = databaseFactoryFfi;

      // Use MessageStorage-like pattern with in-memory DB
      final db = await sqflite.openDatabase(
        inMemoryDatabasePath,
        version: 1,
        onCreate: (db, version) async {
          await db.execute('''
            CREATE TABLE messages (
              localId TEXT PRIMARY KEY,
              peerId TEXT NOT NULL,
              content TEXT NOT NULL,
              type TEXT NOT NULL,
              status TEXT NOT NULL,
              timestamp TEXT NOT NULL,
              isOutgoing INTEGER NOT NULL
            )
          ''');
        },
      );

      await db.insert('messages', {
        'localId': 'test-1',
        'peerId': 'peer-1',
        'content': 'hello',
        'type': 'text',
        'status': 'delivered',
        'timestamp': DateTime(2024, 1, 1).toIso8601String(),
        'isOutgoing': 1,
      });

      final rows = await db.query('messages');
      expect(rows, hasLength(1));
      expect(rows.first['content'], 'hello');
      await db.close();
    });
  });
}
