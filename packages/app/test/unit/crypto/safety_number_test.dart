import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/core/crypto/crypto_service.dart';

void main() {
  group('CryptoService.computeSafetyNumber', () {
    // Use deterministic keys for testing
    final keyA = base64Encode(Uint8List.fromList(List.generate(32, (i) => i)));
    final keyB =
        base64Encode(Uint8List.fromList(List.generate(32, (i) => 32 + i)));
    final keyC =
        base64Encode(Uint8List.fromList(List.generate(32, (i) => 64 + i)));

    test('produces same result regardless of key order', () {
      final ab = CryptoService.computeSafetyNumber(keyA, keyB);
      final ba = CryptoService.computeSafetyNumber(keyB, keyA);
      expect(ab, equals(ba));
    });

    test('produces different result for different key pairs', () {
      final ab = CryptoService.computeSafetyNumber(keyA, keyB);
      final ac = CryptoService.computeSafetyNumber(keyA, keyC);
      expect(ab, isNot(equals(ac)));
    });

    test('produces consistent 60-digit output', () {
      final number = CryptoService.computeSafetyNumber(keyA, keyB);
      expect(number.length, 60);
      expect(number, matches(RegExp(r'^\d{60}$')));
    });

    test('is deterministic', () {
      final first = CryptoService.computeSafetyNumber(keyA, keyB);
      final second = CryptoService.computeSafetyNumber(keyA, keyB);
      expect(first, equals(second));
    });

    test('same key with itself produces valid output', () {
      final number = CryptoService.computeSafetyNumber(keyA, keyA);
      expect(number.length, 60);
      expect(number, matches(RegExp(r'^\d{60}$')));
    });
  });

  group('CryptoService.formatSafetyNumberForDisplay', () {
    test('formats 60 digits into 12 groups of 5', () {
      final digits = '1' * 60;
      final formatted = CryptoService.formatSafetyNumberForDisplay(digits);
      final lines = formatted.split('\n');
      expect(lines.length, 3);
      for (final line in lines) {
        final groups = line.split(' ');
        expect(groups.length, 4);
        for (final group in groups) {
          expect(group.length, 5);
        }
      }
    });

    test('preserves all digits', () {
      final digits = List.generate(60, (i) => i % 10).join();
      final formatted = CryptoService.formatSafetyNumberForDisplay(digits);
      final cleaned = formatted.replaceAll(RegExp(r'[\s\n]'), '');
      expect(cleaned, equals(digits));
    });
  });

  group('CryptoService.keysWereRegenerated', () {
    test('defaults to false', () {
      final service = CryptoService();
      expect(service.keysWereRegenerated, isFalse);
    });
  });
}
