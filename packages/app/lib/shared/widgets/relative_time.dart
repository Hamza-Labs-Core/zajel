/// Format a DateTime as a human-readable relative time string.
String formatRelativeTime(DateTime dateTime) {
  final now = DateTime.now();
  final diff = now.difference(dateTime);

  if (diff.inSeconds < 60) return 'Just now';
  if (diff.inMinutes < 60) {
    final m = diff.inMinutes;
    return '$m ${m == 1 ? 'minute' : 'minutes'} ago';
  }
  if (diff.inHours < 24) {
    final h = diff.inHours;
    return '$h ${h == 1 ? 'hour' : 'hours'} ago';
  }
  if (diff.inDays < 7) {
    final d = diff.inDays;
    if (d == 1) return 'Yesterday';
    return '$d days ago';
  }
  if (diff.inDays < 30) {
    final w = diff.inDays ~/ 7;
    return '$w ${w == 1 ? 'week' : 'weeks'} ago';
  }
  // Fall back to date
  return '${dateTime.day}/${dateTime.month}/${dateTime.year}';
}
