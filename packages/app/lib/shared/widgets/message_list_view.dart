import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

/// A reusable reversed ListView for chat-like message screens.
///
/// Handles:
/// - Reversed list (newest at bottom, scroll starts at bottom)
/// - Smart auto-scroll (only scrolls to bottom if user is near bottom)
/// - "New messages" floating indicator when user is reading history
/// - Pagination (loads older messages when scrolling near the top)
/// - Date dividers between messages from different days
///
/// [T] is the message type (e.g. Message, GroupMessage, ChannelMessage).
class MessageListView<T> extends StatefulWidget {
  /// Messages in chronological order (oldest first).
  final List<T> messages;

  /// Builder for each message widget.
  final Widget Function(BuildContext context, T message) messageBuilder;

  /// Extracts the timestamp from a message for date dividers.
  final DateTime Function(T message) timestampExtractor;

  /// Called when the user scrolls near the top to load older messages.
  final Future<void> Function()? onLoadMore;

  /// Whether there are more older messages to load.
  final bool hasMore;

  /// Increment this value to signal that a new message arrived.
  /// The widget will auto-scroll if the user is near the bottom.
  final int newMessageSignal;

  /// Padding around the ListView.
  final EdgeInsets padding;

  /// Widget to show when the message list is empty.
  final Widget? emptyState;

  const MessageListView({
    super.key,
    required this.messages,
    required this.messageBuilder,
    required this.timestampExtractor,
    this.onLoadMore,
    this.hasMore = false,
    this.newMessageSignal = 0,
    this.padding = const EdgeInsets.all(8),
    this.emptyState,
  });

  @override
  State<MessageListView<T>> createState() => _MessageListViewState<T>();
}

class _MessageListViewState<T> extends State<MessageListView<T>> {
  final _scrollController = ScrollController();
  bool _isLoadingMore = false;
  bool _showNewMessageIndicator = false;

  /// Threshold in pixels from bottom (in reversed list, pixels from 0)
  /// within which we consider the user "at the bottom".
  static const _nearBottomThreshold = 150.0;

  /// Distance from maxScrollExtent at which we trigger load-more.
  static const _loadMoreThreshold = 200.0;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
  }

  @override
  void didUpdateWidget(covariant MessageListView<T> oldWidget) {
    super.didUpdateWidget(oldWidget);

    // New message signal changed → check if we should auto-scroll
    if (widget.newMessageSignal != oldWidget.newMessageSignal &&
        widget.newMessageSignal > oldWidget.newMessageSignal) {
      _handleNewMessage();
    }
  }

  void _handleNewMessage() {
    if (!_scrollController.hasClients) return;

    final pixels = _scrollController.position.pixels;

    if (pixels <= _nearBottomThreshold) {
      // User is near the bottom — reversed list auto-shows new items at index 0.
      // Dismiss any lingering indicator.
      if (_showNewMessageIndicator) {
        setState(() => _showNewMessageIndicator = false);
      }
    } else {
      // User is reading history — show the indicator instead of yanking scroll.
      setState(() => _showNewMessageIndicator = true);
    }
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;

    final position = _scrollController.position;

    // Dismiss indicator when user scrolls back to bottom
    if (_showNewMessageIndicator && position.pixels <= _nearBottomThreshold) {
      setState(() => _showNewMessageIndicator = false);
    }

    // Pagination: in reversed list, "scrolling up" = approaching maxScrollExtent
    if (!_isLoadingMore &&
        widget.hasMore &&
        widget.onLoadMore != null &&
        position.pixels >= position.maxScrollExtent - _loadMoreThreshold) {
      _isLoadingMore = true;
      widget.onLoadMore!().then((_) {
        _isLoadingMore = false;
      });
    }
  }

  void _scrollToBottom() {
    if (_scrollController.hasClients) {
      _scrollController.animateTo(
        0,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
      );
    }
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.messages.isEmpty && widget.emptyState != null) {
      return widget.emptyState!;
    }

    if (widget.messages.isEmpty) {
      return const SizedBox.shrink();
    }

    final messages = widget.messages;

    return Stack(
      children: [
        ListView.builder(
          controller: _scrollController,
          reverse: true,
          padding: widget.padding,
          itemCount: messages.length,
          itemBuilder: (context, index) {
            // In reversed mode, index 0 = newest. Map to chronological order.
            final msgIndex = messages.length - 1 - index;
            final message = messages[msgIndex];

            // Date divider: show above the first message of a new day
            Widget? dateDivider;
            if (msgIndex == 0) {
              dateDivider = _buildDateDivider(
                widget.timestampExtractor(message),
              );
            } else {
              final prevMessage = messages[msgIndex - 1];
              final currDate = widget.timestampExtractor(message).toLocal();
              final prevDate = widget.timestampExtractor(prevMessage).toLocal();
              if (!_isSameDay(currDate, prevDate)) {
                dateDivider = _buildDateDivider(
                  widget.timestampExtractor(message),
                );
              }
            }

            // In reversed list, date divider goes AFTER the message widget
            // (because the list is rendered bottom-to-top).
            return Column(
              children: [
                if (dateDivider != null) dateDivider,
                widget.messageBuilder(context, message),
              ],
            );
          },
        ),
        // "New messages" floating indicator
        if (_showNewMessageIndicator)
          Positioned(
            bottom: 8,
            left: 0,
            right: 0,
            child: Center(
              child: GestureDetector(
                onTap: () {
                  _scrollToBottom();
                  setState(() => _showNewMessageIndicator = false);
                },
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: Theme.of(context).colorScheme.primary,
                    borderRadius: BorderRadius.circular(20),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.2),
                        blurRadius: 4,
                        offset: const Offset(0, 2),
                      ),
                    ],
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.keyboard_arrow_down,
                        size: 18,
                        color: Theme.of(context).colorScheme.onPrimary,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        'New messages',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onPrimary,
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildDateDivider(DateTime date) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Row(
        children: [
          Expanded(child: Divider(color: Colors.grey.shade300)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(
              _formatDate(date.toLocal()),
              style: TextStyle(
                fontSize: 12,
                color: Colors.grey.shade600,
              ),
            ),
          ),
          Expanded(child: Divider(color: Colors.grey.shade300)),
        ],
      ),
    );
  }

  bool _isSameDay(DateTime a, DateTime b) {
    return a.year == b.year && a.month == b.month && a.day == b.day;
  }

  String _formatDate(DateTime date) {
    final now = DateTime.now();
    if (_isSameDay(date, now)) return 'Today';
    if (_isSameDay(date, now.subtract(const Duration(days: 1)))) {
      return 'Yesterday';
    }
    return DateFormat('MMM d, y').format(date);
  }
}
