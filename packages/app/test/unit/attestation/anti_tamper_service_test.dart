import 'package:flutter_test/flutter_test.dart';
import 'package:zajel/features/attestation/services/anti_tamper_service.dart';

void main() {
  group('AntiTamperService', () {
    late AntiTamperService service;

    setUp(() {
      service = AntiTamperService();
    });

    group('runChecks', () {
      test('returns a TamperCheckResult', () async {
        final result = await service.runChecks();
        expect(result, isA<TamperCheckResult>());
      });

      test('detects debug mode in test environment', () async {
        // Tests always run in debug mode, so debugger should be detected
        final result = await service.runChecks();
        expect(result.debuggerDetected, isTrue);
      });

      test('warnings are populated for detected issues', () async {
        final result = await service.runChecks();
        // In test environment, at least debug mode should be detected
        if (result.hasTamperIndicators) {
          expect(result.warnings, isNotEmpty);
        }
      });
    });
  });

  group('TamperCheckResult', () {
    test('default constructor has no indicators', () {
      const result = TamperCheckResult();
      expect(result.debuggerDetected, isFalse);
      expect(result.rootDetected, isFalse);
      expect(result.emulatorDetected, isFalse);
      expect(result.warnings, isEmpty);
      expect(result.hasTamperIndicators, isFalse);
    });

    test('hasTamperIndicators is true when debugger detected', () {
      const result = TamperCheckResult(debuggerDetected: true);
      expect(result.hasTamperIndicators, isTrue);
    });

    test('hasTamperIndicators is true when root detected', () {
      const result = TamperCheckResult(rootDetected: true);
      expect(result.hasTamperIndicators, isTrue);
    });

    test('hasTamperIndicators is true when emulator detected', () {
      const result = TamperCheckResult(emulatorDetected: true);
      expect(result.hasTamperIndicators, isTrue);
    });

    test('toString includes all fields', () {
      const result = TamperCheckResult(
        debuggerDetected: true,
        rootDetected: false,
        emulatorDetected: true,
        warnings: ['debug', 'emulator'],
      );
      final str = result.toString();
      expect(str, contains('debugger=true'));
      expect(str, contains('root=false'));
      expect(str, contains('emulator=true'));
    });
  });
}
