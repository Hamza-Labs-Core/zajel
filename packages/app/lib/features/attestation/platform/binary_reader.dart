import 'dart:typed_data';

import '../../../core/logging/logger_service.dart';

/// Abstraction for reading the app's own binary at runtime.
///
/// This is used for binary attestation: the bootstrap server sends
/// challenge regions (offset + length), and the app must read those
/// regions from its own binary to compute HMAC responses.
///
/// Platform-specific implementations:
/// - **Desktop (Linux/Windows/macOS)**: Uses `Platform.resolvedExecutable`
///   to locate and read the binary directly.
/// - **Android**: Reads the APK file (requires native platform channel).
/// - **iOS**: Reads the app binary via NSBundle (requires native platform channel).
/// - **Web**: Not supported — returns null (web is the weakest attestation tier).
///
/// NOTE: The current implementation is a stub that logs a warning.
/// Full native platform channel implementations for Android and iOS are
/// planned for a future iteration. Desktop platforms can use the Dart I/O
/// approach directly (see [BinaryReaderDesktop] below), but mobile platforms
/// need Kotlin/Swift bridging code that is non-trivial to implement.
///
/// To implement native binary reading for mobile:
/// 1. Create a MethodChannel ('com.zajel.attestation/binary_reader')
/// 2. Android (Kotlin): Use ApplicationInfo.sourceDir to get APK path,
///    then read bytes at the requested offset/length
/// 3. iOS (Swift): Use Bundle.main.executablePath to get the binary path,
///    then read bytes at the requested offset/length
/// 4. Return the bytes as a Uint8List via the platform channel
abstract class BinaryReader {
  /// Read a region of the app's own binary.
  ///
  /// Returns the bytes at [offset] with the given [length], or null
  /// if the binary cannot be read on this platform.
  Future<Uint8List?> readRegion(int offset, int length);

  /// Whether binary reading is supported on the current platform.
  bool get isSupported;
}

/// Stub implementation of [BinaryReader] that logs a warning.
///
/// This is the default implementation used until native platform channel
/// code is added for Android and iOS. Desktop platforms should use
/// [BinaryReaderDesktop] instead.
class StubBinaryReader implements BinaryReader {
  static const _tag = 'BinaryReader';

  @override
  Future<Uint8List?> readRegion(int offset, int length) async {
    logger.warning(
      _tag,
      'Binary reading not implemented for this platform. '
      'Binary attestation challenges will fail. '
      'See binary_reader.dart for implementation notes.',
    );
    return null;
  }

  @override
  bool get isSupported => false;
}
