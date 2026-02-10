import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'help_content.dart';

/// Screen that displays a single help article with rich text content.
class HelpArticleScreen extends ConsumerWidget {
  final String articleId;

  const HelpArticleScreen({super.key, required this.articleId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final article = HelpContent.findArticle(articleId);

    if (article == null) {
      return Scaffold(
        appBar: AppBar(
          title: const Text('Article Not Found'),
        ),
        body: const Center(
          child: Text('This help article could not be found.'),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(article.title),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Article header
            Row(
              children: [
                Icon(
                  article.icon,
                  size: 32,
                  color: Theme.of(context).colorScheme.primary,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        article.title,
                        style:
                            Theme.of(context).textTheme.headlineSmall?.copyWith(
                                  fontWeight: FontWeight.w600,
                                ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        article.subtitle,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            const Divider(),
            const SizedBox(height: 16),
            // Article sections
            ...article.sections.map(
              (section) => _buildArticleSection(context, section),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildArticleSection(BuildContext context, HelpSection section) {
    if (section.isWarning) {
      final isDark = Theme.of(context).brightness == Brightness.dark;
      final warningBg = isDark
          ? Colors.orange.shade900.withValues(alpha: 0.2)
          : Colors.orange.shade50;
      final warningBorder = isDark
          ? Colors.orange.shade700.withValues(alpha: 0.4)
          : Colors.orange.shade200;
      final warningFg =
          isDark ? Colors.orange.shade300 : Colors.orange.shade900;
      final warningIcon =
          isDark ? Colors.orange.shade400 : Colors.orange.shade800;

      return Padding(
        padding: const EdgeInsets.only(bottom: 20),
        child: Container(
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
                    if (section.header != null) ...[
                      Text(
                        section.header!,
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          color: warningFg,
                        ),
                      ),
                      const SizedBox(height: 4),
                    ],
                    Text(
                      section.body,
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
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (section.header != null) ...[
            Text(
              section.header!,
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
            ),
            const SizedBox(height: 8),
          ],
          Text(
            section.body,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  height: 1.5,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
        ],
      ),
    );
  }
}
