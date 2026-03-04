import 'package:flutter/material.dart';

/// Reusable empty state widget with an illustration, message, and optional action.
class EmptyState extends StatelessWidget {
  final String imagePath;
  final String message;
  final String? subtitle;
  final Widget? action;

  const EmptyState({
    super.key,
    required this.imagePath,
    required this.message,
    this.subtitle,
    this.action,
  });

  /// Resolves the image path for the current theme brightness.
  /// In dark mode, replaces `.png` with `_dark.png` (e.g.
  /// `empty_no_messages.png` → `empty_no_messages_dark.png`).
  String _resolveImagePath(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    if (isDark) {
      return imagePath.replaceAll('.png', '_dark.png');
    }
    return imagePath;
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(20),
              child: ConstrainedBox(
                constraints:
                    const BoxConstraints(maxHeight: 160, maxWidth: 160),
                child: Image.asset(
                  _resolveImagePath(context),
                  fit: BoxFit.contain,
                ),
              ),
            ),
            const SizedBox(height: 24),
            Text(
              message,
              style: Theme.of(context).textTheme.titleMedium,
              textAlign: TextAlign.center,
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 8),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
            ],
            if (action != null) ...[
              const SizedBox(height: 24),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}
