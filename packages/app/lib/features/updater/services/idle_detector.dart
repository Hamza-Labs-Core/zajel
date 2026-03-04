import 'dart:async';

import 'package:flutter/foundation.dart';

/// Detects when the app is idle and safe to auto-update.
///
/// Tracks user activity (pointer, keyboard, scroll events) and determines
/// when the user has been idle for longer than [idleThreshold]. Also manages
/// a grace period before auto-install, allowing the user to interrupt.
///
/// Usage: wrap the root widget with a `Listener` that calls [onUserActivity]
/// on pointer events, and register a `HardwareKeyboard` handler that calls
/// [onUserActivity] on key events.
class IdleDetector extends ChangeNotifier {
  /// Duration of inactivity before the app is considered idle.
  static const idleThreshold = Duration(minutes: 5);

  /// Duration of the grace period before auto-install proceeds.
  static const gracePeriod = Duration(seconds: 10);

  Timer? _idleTimer;
  Timer? _graceTimer;
  bool _isIdle = false;
  bool _isInGracePeriod = false;
  DateTime? _lastActivity;
  bool _monitoring = false;

  /// Whether the user is currently idle (no activity for [idleThreshold]).
  bool get isIdle => _isIdle;

  /// Whether we are in the grace period countdown before auto-install.
  bool get isInGracePeriod => _isInGracePeriod;

  /// Timestamp of the last user activity, or null if none recorded.
  DateTime? get lastActivity => _lastActivity;

  /// Whether idle monitoring is currently active.
  bool get isMonitoring => _monitoring;

  /// Start monitoring for idle state.
  ///
  /// Call this when an update reaches READY state and auto-install is enabled.
  /// Does nothing if already monitoring.
  void startMonitoring() {
    if (_monitoring) return;
    _monitoring = true;
    _resetIdleTimer();
    notifyListeners();
  }

  /// Stop monitoring for idle state.
  ///
  /// Call this when auto-install is disabled, update state leaves READY,
  /// or the update has been launched.
  void stopMonitoring() {
    if (!_monitoring) return;
    _monitoring = false;
    _idleTimer?.cancel();
    _idleTimer = null;
    _cancelGracePeriod();
    _isIdle = false;
    notifyListeners();
  }

  /// Called when user activity is detected (pointer, keyboard, scroll).
  ///
  /// Resets the idle timer and cancels any in-progress grace period.
  void onUserActivity() {
    _lastActivity = DateTime.now();
    _isIdle = false;
    _cancelGracePeriod();
    if (_monitoring) {
      _resetIdleTimer();
    }
    notifyListeners();
  }

  void _resetIdleTimer() {
    _idleTimer?.cancel();
    _idleTimer = Timer(idleThreshold, () {
      _isIdle = true;
      notifyListeners();
    });
  }

  /// Start the grace period before auto-install.
  ///
  /// [onGraceComplete] is called after [gracePeriod] if the user remains idle.
  /// If the user interacts during the grace period, it is aborted and
  /// [onGraceComplete] is never called.
  void startGracePeriod(VoidCallback onGraceComplete) {
    if (_isInGracePeriod) return;
    _isInGracePeriod = true;
    notifyListeners();
    _graceTimer = Timer(gracePeriod, () {
      if (_isIdle) {
        _isInGracePeriod = false;
        notifyListeners();
        onGraceComplete();
      } else {
        _isInGracePeriod = false;
        notifyListeners();
      }
    });
  }

  void _cancelGracePeriod() {
    if (_isInGracePeriod) {
      _isInGracePeriod = false;
      _graceTimer?.cancel();
      _graceTimer = null;
    }
  }

  @override
  void dispose() {
    _idleTimer?.cancel();
    _graceTimer?.cancel();
    super.dispose();
  }
}
