import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Scans all Dart source files under lib/ for SnackBar constructors and
/// verifies each one has an explicit `duration` parameter.
///
/// This prevents the default 4-second SnackBar duration from sneaking in,
/// which was the root cause of Bug 2 (users missed brief notifications).
void main() {
  test('All SnackBar constructors specify an explicit duration', () {
    final libDir = Directory('lib');
    expect(libDir.existsSync(), isTrue, reason: 'lib/ directory must exist');

    final dartFiles = libDir
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'));

    final violations = <String>[];

    // Match SnackBar( constructor calls. We look for a balanced region from
    // "SnackBar(" up to its closing ")" and check whether `duration` appears
    // inside that region. This uses a simple paren-counter approach.
    for (final file in dartFiles) {
      final content = file.readAsStringSync();
      final lines = content.split('\n');

      for (int i = 0; i < lines.length; i++) {
        final line = lines[i];
        // Look for lines that start a SnackBar constructor
        if (!line.contains('SnackBar(')) continue;

        // Collect the full SnackBar(...) constructor text across lines
        final startLine = i;
        final buffer = StringBuffer();
        int depth = 0;
        bool foundOpen = false;
        bool complete = false;

        for (int j = startLine; j < lines.length && !complete; j++) {
          final l = lines[j];
          for (int k = 0; k < l.length; k++) {
            final ch = l[k];
            if (!foundOpen) {
              // Search for the opening paren of SnackBar(
              if (ch == '(' &&
                  k > 0 &&
                  l.substring(0, k + 1).contains('SnackBar(')) {
                foundOpen = true;
                depth = 1;
                buffer.write(ch);
              }
            } else {
              buffer.write(ch);
              if (ch == '(') depth++;
              if (ch == ')') depth--;
              if (depth == 0) {
                complete = true;
                break;
              }
            }
          }
          if (foundOpen) buffer.write('\n');
        }

        if (!complete) continue;

        final constructorText = buffer.toString();
        if (!constructorText.contains('duration')) {
          violations.add(
              '${file.path}:${startLine + 1}: SnackBar without explicit duration');
        }
      }
    }

    expect(
      violations,
      isEmpty,
      reason: 'Every SnackBar must have an explicit duration parameter.\n'
          'Violations:\n${violations.join('\n')}',
    );
  });
}
