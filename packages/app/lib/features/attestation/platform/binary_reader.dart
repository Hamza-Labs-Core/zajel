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
/// approach directly (see [BinaryReaderDesktop]), but mobile platforms
/// need Kotlin/Swift bridging code that is non-trivial to implement.
///
/// To implement native binary reading for mobile, follow the [BinaryReaderDesktop]
/// pattern:
/// 1. Create `BinaryReaderAndroid` implementing [BinaryReader] with:
///    - Use MethodChannel ('com.zajel.attestation/binary_reader')
///    - Kotlin: Use ApplicationInfo.sourceDir to get APK path, read bytes at offset/length
///    - Return bytes as Uint8List via platform channel
/// 2. Create `BinaryReaderIos` implementing [BinaryReader] with:
///    - Use MethodChannel ('com.zajel.attestation/binary_reader')
///    - Swift: Use Bundle.main.executablePath to get binary path, read bytes at offset/length
///    - Return bytes as Uint8List via platform channel
/// 3. Update [binaryReaderProvider] in [attestation_providers.dart] to instantiate
///    the appropriate platform class based on `Platform.isAndroid` / `Platform.isIOS`
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
