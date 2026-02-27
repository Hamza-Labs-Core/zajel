import 'dart:io';
import 'dart:typed_data';

import '../../../core/logging/logger_service.dart';
import 'binary_reader.dart';

/// Desktop implementation of [BinaryReader] using `Platform.resolvedExecutable`.
///
/// Works on Linux, Windows, and macOS where the app binary is a standard
/// executable file accessible via the filesystem.
///
/// On Linux: reads from `/proc/self/exe` symlink or `Platform.resolvedExecutable`
/// On Windows: reads from the .exe path returned by `Platform.resolvedExecutable`
/// On macOS: reads from the Mach-O binary path returned by `Platform.resolvedExecutable`
class BinaryReaderDesktop implements BinaryReader {
  static const _tag = 'BinaryReaderDesktop';

  @override
  Future<Uint8List?> readRegion(int offset, int length) async {
    try {
      final executablePath = Platform.resolvedExecutable;
      final file = File(executablePath);

      if (!await file.exists()) {
        logger.warning(_tag, 'Executable not found at: $executablePath');
        return null;
      }

      final fileLength = await file.length();
      if (offset < 0 || offset + length > fileLength) {
        logger.warning(
          _tag,
          'Requested region ($offset, $length) exceeds binary size ($fileLength)',
        );
        return null;
      }

      final raf = await file.open(mode: FileMode.read);
      try {
        await raf.setPosition(offset);
        final bytes = await raf.read(length);
        return Uint8List.fromList(bytes);
      } finally {
        await raf.close();
      }
    } catch (e) {
      logger.error(_tag, 'Failed to read binary region', e);
      return null;
    }
  }

  @override
  bool get isSupported => true;
}
