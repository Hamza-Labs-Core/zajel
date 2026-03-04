import 'package:emoji_picker_flutter/emoji_picker_flutter.dart';
import 'package:flutter/material.dart';

/// Emoji characters blocked for Islamic values compliance.
///
/// Categories:
/// - Alcohol: beer, wine, cocktails, champagne
/// - Gambling: slot machine, dice
/// - Pig/pork: pig face, pig, pig nose
/// - Inappropriate gestures: middle finger
/// - Suggestive: kiss mark, hot face, etc.
const _blockedEmojis = <String>{
  // Alcohol
  '\u{1F37A}', // 🍺 beer mug
  '\u{1F37B}', // 🍻 clinking beer mugs
  '\u{1F377}', // 🍷 wine glass
  '\u{1F378}', // 🍸 cocktail glass
  '\u{1F379}', // 🍹 tropical drink
  '\u{1F37E}', // 🍾 bottle with popping cork
  '\u{1F942}', // 🥂 clinking glasses
  '\u{1F943}', // 🥃 tumbler glass
  // Gambling
  '\u{1F3B0}', // 🎰 slot machine
  '\u{1F3B2}', // 🎲 game die
  // Pig / pork
  '\u{1F437}', // 🐷 pig face
  '\u{1F416}', // 🐖 pig
  '\u{1F43D}', // 🐽 pig nose
  // Inappropriate gestures
  '\u{1F595}', // 🖕 middle finger
  // Suggestive
  '\u{1F48B}', // 💋 kiss mark
  '\u{1F444}', // 👄 mouth
  '\u{1F445}', // 👅 tongue
};

/// Builds a filtered emoji set from the default set, removing blocked emojis.
List<CategoryEmoji> _buildFilteredEmojiSet() {
  return defaultEmojiSet.map((categoryEmoji) {
    final filtered = categoryEmoji.emoji
        .where((e) => !_blockedEmojis.contains(e.emoji))
        .toList();
    return categoryEmoji.copyWith(emoji: filtered);
  }).toList();
}

/// A filtered emoji picker that excludes inappropriate content.
class FilteredEmojiPicker extends StatelessWidget {
  /// Controller for the text field where emoji will be inserted.
  final TextEditingController textEditingController;

  /// Called when an emoji is selected.
  final void Function(Category? category, Emoji emoji)? onEmojiSelected;

  /// Called when backspace button is pressed.
  final VoidCallback? onBackspacePressed;

  const FilteredEmojiPicker({
    super.key,
    required this.textEditingController,
    this.onEmojiSelected,
    this.onBackspacePressed,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    return EmojiPicker(
      textEditingController: textEditingController,
      onEmojiSelected: onEmojiSelected,
      onBackspacePressed: onBackspacePressed,
      config: Config(
        height: 256,
        emojiSet: _buildFilteredEmojiSet(),
        emojiViewConfig: EmojiViewConfig(
          columns: 8,
          emojiSizeMax: 32,
          backgroundColor:
              isDark ? theme.colorScheme.surface : const Color(0xFFF5F5F5),
        ),
        categoryViewConfig: CategoryViewConfig(
          backgroundColor:
              isDark ? theme.colorScheme.surface : const Color(0xFFF5F5F5),
          indicatorColor: theme.colorScheme.primary,
          iconColorSelected: theme.colorScheme.primary,
          iconColor: theme.colorScheme.onSurfaceVariant,
        ),
        bottomActionBarConfig: const BottomActionBarConfig(
          showBackspaceButton: true,
          showSearchViewButton: true,
        ),
        searchViewConfig: SearchViewConfig(
          backgroundColor:
              isDark ? theme.colorScheme.surface : const Color(0xFFF5F5F5),
        ),
      ),
    );
  }
}
