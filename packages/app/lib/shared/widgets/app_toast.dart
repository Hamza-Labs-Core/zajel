import 'package:flutter/material.dart';
import 'package:toastification/toastification.dart';

/// Severity / colour scheme for an [showAppToast] call.
///
/// Maps to a [ToastificationType] under the hood, but keeps callers free of
/// the third-party type. If we ever swap the toast library out again, only
/// this file changes.
enum AppToastKind { info, success, warning, error }

ToastificationType _kindToType(AppToastKind kind) {
  switch (kind) {
    case AppToastKind.info:
      return ToastificationType.info;
    case AppToastKind.success:
      return ToastificationType.success;
    case AppToastKind.warning:
      return ToastificationType.warning;
    case AppToastKind.error:
      return ToastificationType.error;
  }
}

/// Show a transient in-app toast that auto-dismisses after [duration].
///
/// Replaces direct `ScaffoldMessenger.of(context).showSnackBar(...)` calls.
/// The replacement is required because Flutter's `ScaffoldMessenger`
/// schedules its dismiss `Timer` only after the show animation reaches
/// `AnimationStatus.completed`, and that completion event is driven by a
/// `Ticker`. On Windows desktop, when the window blurs the ticker pauses,
/// the show animation never completes, the dismiss timer is never scheduled,
/// and the bar appears stuck for as long as the window stays blurred.
///
/// `toastification` (under the hood here) drives auto-dismiss via its own
/// `pausable_timer`, which runs on the Dart event loop independent of frame
/// scheduling — so toasts dismiss on schedule even with the window blurred.
///
/// [context] is required and must reach a `ToastificationWrapper` (mounted
/// at the root of the widget tree in `main.dart`).
void showAppToast(
  BuildContext context,
  String message, {
  Duration duration = const Duration(seconds: 3),
  AppToastKind kind = AppToastKind.info,
  String? title,
}) {
  toastification.show(
    context: context,
    type: _kindToType(kind),
    style: ToastificationStyle.flat,
    title: Text(title ?? message),
    description: title == null ? null : Text(message),
    autoCloseDuration: duration,
    alignment: Alignment.bottomCenter,
    showProgressBar: false,
    closeOnClick: true,
    pauseOnHover: true,
  );
}
