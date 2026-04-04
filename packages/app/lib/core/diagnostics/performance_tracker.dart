/// Lightweight performance tracker for diagnostics.
///
/// Tracks startup time, frame rate statistics, and memory usage.
/// Designed to run on the main isolate with minimal overhead:
/// - Frame timing uses [SchedulerBinding.addTimingsCallback] (a Flutter hook)
/// - Memory sampling runs on a 60-second timer
/// - Only the last [_maxFrameSamples] frame timings are retained
library;

import 'dart:async';
import 'dart:io' show ProcessInfo;

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/// Performance metrics snapshot.
class PerformanceMetrics {
  /// Time from tracker start to first frame rendered (ms).
  final double? startupTimeMs;

  /// Rolling average frames per second.
  final double? frameRateAvg;

  /// 95th-percentile frame build time (ms).
  final double? frameRateP95;

  /// Current RSS memory usage (MB), null if unavailable.
  final double? memoryUsageMb;

  /// Peak RSS memory usage observed during this session (MB).
  final double? memoryPeakMb;

  const PerformanceMetrics({
    this.startupTimeMs,
    this.frameRateAvg,
    this.frameRateP95,
    this.memoryUsageMb,
    this.memoryPeakMb,
  });

  Map<String, dynamic> toJson() => {
        if (startupTimeMs != null) 'startupTimeMs': startupTimeMs,
        if (frameRateAvg != null) 'frameRateAvg': frameRateAvg,
        if (frameRateP95 != null) 'frameRateP95': frameRateP95,
        if (memoryUsageMb != null) 'memoryUsageMb': memoryUsageMb,
        if (memoryPeakMb != null) 'memoryPeakMb': memoryPeakMb,
      };

  @override
  String toString() => 'PerformanceMetrics('
      'startup=${startupTimeMs?.toStringAsFixed(1)}ms, '
      'fps=${frameRateAvg?.toStringAsFixed(1)}, '
      'p95=${frameRateP95?.toStringAsFixed(1)}ms, '
      'mem=${memoryUsageMb?.toStringAsFixed(1)}MB, '
      'peak=${memoryPeakMb?.toStringAsFixed(1)}MB)';
}

/// Tracks startup time, frame rate, and memory usage.
///
/// Usage:
/// ```dart
/// final tracker = PerformanceTracker();
/// tracker.start();
/// // ... app runs ...
/// final metrics = tracker.getMetrics();
/// tracker.stop();
/// ```
class PerformanceTracker {
  /// Maximum number of frame timing samples to retain for statistics.
  static const int _maxFrameSamples = 120;

  /// Interval between memory usage samples.
  static const Duration memorySampleInterval = Duration(seconds: 60);

  /// Timestamp when [start] was called.
  DateTime? _startTime;

  /// Time to first frame in milliseconds, null until measured.
  double? _startupTimeMs;

  /// Whether the first-frame callback has fired.
  bool _firstFrameRecorded = false;

  /// Circular buffer of recent frame durations (microseconds).
  final List<int> _frameDurations = [];

  /// Timer for periodic memory sampling.
  Timer? _memoryTimer;

  /// Most recent memory reading in MB.
  double? _currentMemoryMb;

  /// Peak memory reading in MB.
  double? _peakMemoryMb;

  /// Whether the tracker is currently running.
  bool _running = false;

  /// Whether the tracker is currently running.
  bool get isRunning => _running;

  /// The timings callback reference, stored so it can be removed on stop.
  TimingsCallback? _timingsCallback;

  /// Whether frame/widget bindings are available.
  ///
  /// Bindings may not be initialized in plain unit tests that exercise
  /// DiagnosticsService without a widget tree. In that case, frame rate
  /// and startup-time tracking are silently skipped.
  bool get _hasBindings {
    try {
      // Accessing .instance throws if not yet initialized.
      SchedulerBinding.instance;
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Start tracking performance metrics.
  ///
  /// Registers a frame timings callback, schedules memory sampling,
  /// and records startup time on the first frame.
  void start() {
    if (_running) return;
    _running = true;
    _startTime = DateTime.now();
    _firstFrameRecorded = false;

    if (_hasBindings) {
      // Register frame timings callback
      _timingsCallback = _onFrameTimings;
      SchedulerBinding.instance.addTimingsCallback(_timingsCallback!);

      // Record startup time on first post-frame callback
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_firstFrameRecorded && _startTime != null) {
          _firstFrameRecorded = true;
          _startupTimeMs =
              DateTime.now().difference(_startTime!).inMicroseconds / 1000.0;
        }
      });
    }

    // Start memory sampling
    _sampleMemory(); // initial sample
    _memoryTimer = Timer.periodic(memorySampleInterval, (_) => _sampleMemory());
  }

  /// Stop tracking performance metrics.
  void stop() {
    if (!_running) return;
    _running = false;

    if (_timingsCallback != null && _hasBindings) {
      SchedulerBinding.instance.removeTimingsCallback(_timingsCallback!);
    }
    _timingsCallback = null;

    _memoryTimer?.cancel();
    _memoryTimer = null;
  }

  /// Return a snapshot of the current performance metrics.
  PerformanceMetrics? getMetrics() {
    if (!_running && _startTime == null) return null;

    return PerformanceMetrics(
      startupTimeMs: _startupTimeMs,
      frameRateAvg: _computeAvgFps(),
      frameRateP95: _computeP95FrameTime(),
      memoryUsageMb: _currentMemoryMb,
      memoryPeakMb: _peakMemoryMb,
    );
  }

  /// Frame timings callback — invoked by the engine after each batch of frames.
  void _onFrameTimings(List<FrameTiming> timings) {
    for (final timing in timings) {
      final totalDuration = timing.totalSpan.inMicroseconds;
      _frameDurations.add(totalDuration);
      if (_frameDurations.length > _maxFrameSamples) {
        _frameDurations.removeAt(0);
      }
    }
  }

  /// Compute rolling average FPS from stored frame durations.
  double? _computeAvgFps() {
    if (_frameDurations.isEmpty) return null;
    final avgMicros =
        _frameDurations.reduce((a, b) => a + b) / _frameDurations.length;
    if (avgMicros <= 0) return null;
    return 1000000.0 / avgMicros;
  }

  /// Compute 95th-percentile frame time in milliseconds.
  double? _computeP95FrameTime() {
    if (_frameDurations.isEmpty) return null;
    final sorted = List<int>.from(_frameDurations)..sort();
    final p95Index = ((sorted.length - 1) * 0.95).round();
    return sorted[p95Index] / 1000.0; // micros -> ms
  }

  /// Sample current memory usage via dart:developer.
  void _sampleMemory() {
    try {
      final info = ProcessInfo.currentRss;
      if (info > 0) {
        final mb = info / (1024.0 * 1024.0);
        _currentMemoryMb = mb;
        if (_peakMemoryMb == null || mb > _peakMemoryMb!) {
          _peakMemoryMb = mb;
        }
      }
    } catch (_) {
      // ProcessInfo may not be available on all platforms (e.g. web).
      // Silently ignore — memory metrics will remain null.
    }
  }
}
