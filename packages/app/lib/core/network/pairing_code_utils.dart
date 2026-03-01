import 'dart:math';

/// Character set for pairing codes.
/// 32 characters (power of 2) chosen to avoid modulo bias with byte values (256 / 32 = 8 exactly).
/// Excludes ambiguous characters: 0, O, 1, I to improve readability.
const pairingCodeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const pairingCodeLength = 6;

/// Generates an unbiased random character from the given character set using rejection sampling.
///
/// This avoids modulo bias by rejecting random bytes that would cause uneven distribution.
/// For a character set of length N, we calculate the largest multiple of N that fits in 256
/// and reject any bytes >= that value.
///
/// Uses [Random.secure()] for cryptographically secure random number generation.
String getUnbiasedRandomChar(String chars, Random secureRandom) {
  final charsetLength = chars.length;
  // Calculate the largest multiple of charsetLength that fits in 256 (byte range)
  final maxValid = (256 ~/ charsetLength) * charsetLength;

  int byte;
  do {
    byte = secureRandom.nextInt(256);
  } while (byte >= maxValid);

  return chars[byte % charsetLength];
}

/// Generates a random pairing code using unbiased random character selection.
///
/// Uses rejection sampling to ensure each character has exactly equal probability,
/// protecting against modulo bias even if the character set is changed in the future.
String generateSecurePairingCode() {
  final secureRandom = Random.secure();
  final buffer = StringBuffer();

  for (var i = 0; i < pairingCodeLength; i++) {
    buffer.write(getUnbiasedRandomChar(pairingCodeChars, secureRandom));
  }

  return buffer.toString();
}

/// Validates pairing code format.
///
/// A valid pairing code must:
/// - Be exactly [pairingCodeLength] characters long (6 characters)
/// - Contain only characters from [pairingCodeChars] (uppercase letters A-Z
///   excluding O and I, plus digits 2-9)
///
/// This ensures consistency with the pairing code generation algorithm.
bool isValidPairingCode(String code) {
  if (code.length != pairingCodeLength) return false;
  // Validate against the same character set used for generation
  final validChars = RegExp('^[$pairingCodeChars]+\$');
  return validChars.hasMatch(code.toUpperCase());
}
