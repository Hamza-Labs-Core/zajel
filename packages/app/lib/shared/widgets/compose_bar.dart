import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../features/chat/widgets/filtered_emoji_picker.dart';

/// A reusable compose bar for text input with send functionality.
///
/// Used by chat, channel, and group screens. Supports:
/// - Enter to send on desktop, Shift+Enter for newline
/// - onSubmitted for mobile keyboards
/// - IME fallback for Linux GTK (detects newline inserted before key event)
/// - Optional emoji picker (filtered for Islamic values)
/// - Optional file attachment button
/// - Focus retention after send
/// - Loading spinner while sending
class ComposeBar extends StatefulWidget {
  final TextEditingController controller;
  final FocusNode focusNode;
  final VoidCallback onSend;
  final bool isSending;
  final String hintText;
  final String sendTooltip;
  final bool showEmojiButton;
  final bool showAttachButton;
  final VoidCallback? onAttach;
  final ValueChanged<String>? onTextChanged;

  const ComposeBar({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onSend,
    this.isSending = false,
    this.hintText = 'Type a message...',
    this.sendTooltip = 'Send',
    this.showEmojiButton = true,
    this.showAttachButton = false,
    this.onAttach,
    this.onTextChanged,
  });

  @override
  State<ComposeBar> createState() => _ComposeBarState();
}

class _ComposeBarState extends State<ComposeBar> {
  bool _showEmojiPicker = false;

  bool get _isDesktop =>
      Platform.isWindows || Platform.isLinux || Platform.isMacOS;

  KeyEventResult _handleKeyEvent(FocusNode node, KeyEvent event) {
    if (!_isDesktop) return KeyEventResult.ignored;

    if (event is KeyDownEvent && event.logicalKey == LogicalKeyboardKey.enter) {
      final isShiftPressed = HardwareKeyboard.instance.isShiftPressed;
      if (!isShiftPressed && !widget.isSending) {
        widget.onSend();
        return KeyEventResult.handled;
      }
    }
    return KeyEventResult.ignored;
  }

  /// Fallback for platforms where IME inserts the newline before onKeyEvent
  /// fires (e.g. Linux GTK). Detects trailing newline and triggers send.
  void _handleTextChanged(String text) {
    widget.onTextChanged?.call(text);

    if (!_isDesktop || widget.isSending) return;

    if (text.endsWith('\n') && !HardwareKeyboard.instance.isShiftPressed) {
      widget.controller.text = text.substring(0, text.length - 1);
      widget.controller.selection = TextSelection.collapsed(
        offset: widget.controller.text.length,
      );
      widget.onSend();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _buildInputRow(context),
        if (_showEmojiPicker && widget.showEmojiButton)
          FilteredEmojiPicker(
            textEditingController: widget.controller,
            onEmojiSelected: (category, emoji) {
              // Emoji is auto-inserted by the textEditingController binding
            },
            onBackspacePressed: () {
              widget.controller
                ..text = widget.controller.text.characters.skipLast(1).string
                ..selection = TextSelection.fromPosition(
                  TextPosition(offset: widget.controller.text.length),
                );
            },
          ),
      ],
    );
  }

  Widget _buildInputRow(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        border: Border(
          top: BorderSide(color: theme.dividerColor),
        ),
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            if (widget.showEmojiButton)
              IconButton(
                icon: Icon(
                  _showEmojiPicker
                      ? Icons.keyboard
                      : Icons.emoji_emotions_outlined,
                ),
                tooltip: _showEmojiPicker ? 'Keyboard' : 'Emoji',
                onPressed: () {
                  if (_showEmojiPicker) {
                    setState(() => _showEmojiPicker = false);
                    widget.focusNode.requestFocus();
                  } else {
                    widget.focusNode.unfocus();
                    setState(() => _showEmojiPicker = true);
                  }
                },
              ),
            if (widget.showAttachButton)
              IconButton(
                icon: const Icon(Icons.attach_file),
                tooltip: 'Attach file',
                onPressed: widget.onAttach,
              ),
            Expanded(
              child: TextField(
                controller: widget.controller,
                focusNode: widget.focusNode..onKeyEvent = _handleKeyEvent,
                decoration: InputDecoration(
                  hintText: widget.hintText,
                  border: InputBorder.none,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                ),
                textCapitalization: TextCapitalization.sentences,
                maxLines: null,
                onTap: () {
                  if (_showEmojiPicker) {
                    setState(() => _showEmojiPicker = false);
                  }
                },
                onChanged: _handleTextChanged,
                onSubmitted: _isDesktop ? null : (_) => widget.onSend(),
              ),
            ),
            widget.isSending
                ? const Padding(
                    padding: EdgeInsets.all(12),
                    child: SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                : IconButton(
                    icon: Icon(
                      Icons.send,
                      color: theme.colorScheme.primary,
                    ),
                    tooltip: widget.sendTooltip,
                    onPressed: widget.isSending ? null : widget.onSend,
                  ),
          ],
        ),
      ),
    );
  }
}
