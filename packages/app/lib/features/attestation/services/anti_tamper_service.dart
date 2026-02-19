import 'dart:io';

import 'package:flutter/foundation.dart';

import '../../../core/logging/logger_service.dart';

/// Detection results from anti-tamper checks.
class TamperCheckResult {
  /// Whether a debugger is attached.
  final bool debuggerDetected;

  /// Whether the device appears to be rooted/jailbroken.
  final bool rootDetected;

  /// Whether the app is running on an emulator/simulator.
  final bool emulatorDetected;

  /// Human-readable warnings for each detected issue.
  final List<String> warnings;

  const TamperCheckResult({
    this.debuggerDetected = false,
    this.rootDetected = false,
    this.emulatorDetected = false,
    this.warnings = const [],
  });

  /// Whether any tamper indicator was detected.
  bool get hasTamperIndicators =>
      debuggerDetected || rootDetected || emulatorDetected;

  @override
  String toString() => 'TamperCheckResult('
      'debugger=$debuggerDetected, '
      'root=$rootDetected, '
      'emulator=$emulatorDetected, '
      'warnings=$warnings)';
}

/// Performs basic anti-tamper and environment integrity checks.
///
/// These checks are informational only — they do not block app usage.
/// Results are reported to the attestation service for server-side
/// risk assessment.
///
/// Checks include:
/// - Debugger attachment detection
/// - Root/jailbreak detection (basic file existence checks)
/// - Emulator/simulator detection (device property checks)
///
/// All checks are no-ops on web platform (kIsWeb).
class AntiTamperService {
  static const _tag = 'AntiTamper';

  /// Run all anti-tamper checks and return the results.
  Future<TamperCheckResult> runChecks() async {
    // All checks are no-ops on web
    if (kIsWeb) {
      return const TamperCheckResult();
    }

    final warnings = <String>[];

    final debugger = _checkDebugger();
    if (debugger) {
      warnings.add('Debugger or debug mode detected');
    }

    final root = await _checkRoot();
    if (root) {
      warnings.add('Device may be rooted/jailbroken');
    }

    final emulator = _checkEmulator();
    if (emulator) {
      warnings.add('Running on emulator/simulator');
    }

    final result = TamperCheckResult(
      debuggerDetected: debugger,
      rootDetected: root,
      emulatorDetected: emulator,
      warnings: warnings,
    );

    if (result.hasTamperIndicators) {
      logger.warning(_tag, 'Tamper indicators detected: $result');
    } else {
      logger.info(_tag, 'No tamper indicators detected');
    }

    return result;
  }

  /// Check if a debugger is attached or the app is in debug mode.
  bool _checkDebugger() {
    if (kIsWeb) return false;

    // In release mode, kDebugMode is false. If we're not in release mode,
    // that's a signal that someone might be debugging.
    if (kDebugMode) return true;

    // Check for assert statements — they only execute in debug mode.
    // If this evaluates to true, we're in debug mode.
    bool assertsEnabled = false;
    assert(() {
      assertsEnabled = true;
      return true;
    }());
    if (assertsEnabled) return true;

    return false;
  }

  /// Check for common root/jailbreak indicators.
  ///
  /// This is a basic check based on well-known file paths.
  /// Not exhaustive — sophisticated root hiding can bypass this.
  Future<bool> _checkRoot() async {
    if (kIsWeb) return false;

    try {
      if (Platform.isAndroid) {
        return _checkAndroidRoot();
      } else if (Platform.isIOS) {
        return _checkIOSJailbreak();
      }
    } catch (e) {
      logger.warning(_tag, 'Root check failed: $e');
    }
    return false;
  }

  /// Check for common Android root indicators.
  bool _checkAndroidRoot() {
    const rootIndicators = [
      '/system/app/Superuser.apk',
      '/system/xbin/su',
      '/system/bin/su',
      '/sbin/su',
      '/data/local/xbin/su',
      '/data/local/bin/su',
      '/data/local/su',
      '/su/bin/su',
      '/system/bin/failsafe/su',
      '/system/sd/xbin/su',
    ];

    for (final path in rootIndicators) {
      if (File(path).existsSync()) {
        return true;
      }
    }
    return false;
  }

  /// Check for common iOS jailbreak indicators.
  bool _checkIOSJailbreak() {
    const jailbreakIndicators = [
      '/Applications/Cydia.app',
      '/Library/MobileSubstrate/MobileSubstrate.dylib',
      '/bin/bash',
      '/usr/sbin/sshd',
      '/etc/apt',
      '/private/var/lib/apt/',
      '/private/var/stash',
      '/usr/bin/ssh',
    ];

    for (final path in jailbreakIndicators) {
      if (File(path).existsSync()) {
        return true;
      }
    }
    return false;
  }

  /// Check if running on an emulator/simulator.
  ///
  /// Uses basic heuristics based on known emulator properties.
  bool _checkEmulator() {
    if (kIsWeb) return false;

    try {
      if (Platform.isAndroid) {
        return _checkAndroidEmulator();
      } else if (Platform.isIOS) {
        // On iOS, we can check if the binary architecture suggests simulator.
        // However, Platform.operatingSystemVersion is the most reliable indicator.
        return _checkIOSSimulator();
      }
    } catch (e) {
      logger.warning(_tag, 'Emulator check failed: $e');
    }
    return false;
  }

  /// Check for Android emulator indicators.
  bool _checkAndroidEmulator() {
    // Check for common emulator properties in environment
    final osVersion = Platform.operatingSystemVersion.toLowerCase();
    if (osVersion.contains('sdk') || osVersion.contains('emulator')) {
      return true;
    }

    // Check for emulator-specific files
    const emulatorIndicators = [
      '/dev/socket/qemud',
      '/dev/qemu_pipe',
      '/system/lib/libc_malloc_debug_qemu.so',
    ];

    for (final path in emulatorIndicators) {
      if (File(path).existsSync()) {
        return true;
      }
    }

    return false;
  }

  /// Check for iOS simulator indicators.
  bool _checkIOSSimulator() {
    // Check the runtime architecture — simulators run on x86_64/arm64 (macOS)
    // but the environment variable SIMULATOR_DEVICE_NAME is set
    final env = Platform.environment;
    if (env.containsKey('SIMULATOR_DEVICE_NAME') ||
        env.containsKey('SIMULATOR_HOST_HOME')) {
      return true;
    }
    return false;
  }
}
