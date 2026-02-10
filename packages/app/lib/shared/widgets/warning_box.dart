import 'package:flutter/material.dart';

/// A themed warning box with an icon, optional header, and body text.
///
/// Automatically adapts colors for light and dark mode using orange tones.
/// Used in help articles and onboarding to highlight important caveats.
class WarningBox extends StatelessWidget {
  final String? header;
  final String body;

  const WarningBox({
    super.key,
    this.header,
    required this.body,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final warningBg = isDark
        ? Colors.orange.shade900.withValues(alpha: 0.2)
        : Colors.orange.shade50;
    final warningBorder = isDark
        ? Colors.orange.shade700.withValues(alpha: 0.4)
        : Colors.orange.shade200;
    final warningFg = isDark ? Colors.orange.shade300 : Colors.orange.shade900;
    final warningIcon =
        isDark ? Colors.orange.shade400 : Colors.orange.shade800;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: warningBg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: warningBorder),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.warning_amber, color: warningIcon, size: 20),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (header != null) ...[
                  Text(
                    header!,
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      color: warningFg,
                    ),
                  ),
                  const SizedBox(height: 4),
                ],
                Text(
                  body,
                  style: TextStyle(
                    fontSize: 14,
                    color: warningFg,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
