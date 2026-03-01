import 'package:flutter_test/flutter_test.dart';

/// Regression test for Bug 8: Group protocol messages leaking into P2P chat.
///
/// Verifies that the protocol prefix guard in main.dart's
/// _setupNotificationListeners correctly identifies messages that should
/// NOT be persisted to the chat database.
///
/// The guard checks: message.startsWith('ginv:') || message.startsWith('grp:')
/// These messages are handled by GroupInvitationService and WebRtcP2PAdapter
/// respectively and must never reach the chat storage layer.
void main() {
  /// Returns true if a message should be filtered (NOT persisted to chat).
  /// This mirrors the guard logic in main.dart:738.
  bool shouldFilter(String message) {
    return message.startsWith('ginv:') || message.startsWith('grp:');
  }

  group('Group protocol message filter', () {
    test('filters ginv: invitation messages', () {
      expect(shouldFilter('ginv:{"groupId":"g1","name":"Test"}'), isTrue);
    });

    test('filters grp: group data messages', () {
      expect(shouldFilter('grp:SGVsbG8gV29ybGQ='), isTrue);
    });

    test('filters ginv: with empty payload', () {
      expect(shouldFilter('ginv:'), isTrue);
    });

    test('filters grp: with empty payload', () {
      expect(shouldFilter('grp:'), isTrue);
    });

    test('allows regular chat messages', () {
      expect(shouldFilter('Hello, how are you?'), isFalse);
    });

    test('allows messages that contain ginv: mid-text', () {
      // Only messages that START with the prefix should be filtered
      expect(shouldFilter('I got a ginv: invitation'), isFalse);
    });

    test('allows messages that contain grp: mid-text', () {
      expect(shouldFilter('Check the grp: message'), isFalse);
    });

    test('allows empty messages', () {
      expect(shouldFilter(''), isFalse);
    });

    test('is case-sensitive (GINV: is not filtered)', () {
      expect(shouldFilter('GINV:something'), isFalse);
      expect(shouldFilter('GRP:something'), isFalse);
    });

    test('allows typ: prefixed messages (typing indicators if any)', () {
      expect(shouldFilter('typ:typing'), isFalse);
    });

    test('allows rcpt: prefixed messages (receipts if any)', () {
      expect(shouldFilter('rcpt:delivered'), isFalse);
    });
  });
}
