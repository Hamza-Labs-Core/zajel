/// Lightweight network metrics tracker for diagnostics.
///
/// Records success/failure rates for signaling connections and WebRTC
/// peer establishment, tracks relay vs direct P2P usage, and maintains
/// a rolling latency average.
///
/// All methods are synchronous and O(1) — no heavy computation.
/// The tracker does not make any network requests itself; it only
/// accumulates counters that the [DiagnosticsService] reads periodically.
library;

/// Network metrics snapshot.
class NetworkMetrics {
  /// Signaling connection success rate (0.0 – 1.0), null if no attempts.
  final double? signalingConnectSuccessRate;

  /// Total signaling connection attempts.
  final int? signalingConnectAttempts;

  /// WebRTC establishment success rate (0.0 – 1.0), null if no attempts.
  final double? webrtcEstablishSuccessRate;

  /// Total WebRTC establishment attempts.
  final int? webrtcEstablishAttempts;

  /// Fraction of connections using relay (0.0 – 1.0), null if no data.
  final double? relayUsageRate;

  /// Average latency in milliseconds, null if no samples.
  final double? avgLatencyMs;

  const NetworkMetrics({
    this.signalingConnectSuccessRate,
    this.signalingConnectAttempts,
    this.webrtcEstablishSuccessRate,
    this.webrtcEstablishAttempts,
    this.relayUsageRate,
    this.avgLatencyMs,
  });

  Map<String, dynamic> toJson() => {
        if (signalingConnectSuccessRate != null)
          'signalingConnectSuccessRate': signalingConnectSuccessRate,
        if (signalingConnectAttempts != null)
          'signalingConnectAttempts': signalingConnectAttempts,
        if (webrtcEstablishSuccessRate != null)
          'webrtcEstablishSuccessRate': webrtcEstablishSuccessRate,
        if (webrtcEstablishAttempts != null)
          'webrtcEstablishAttempts': webrtcEstablishAttempts,
        if (relayUsageRate != null) 'relayUsageRate': relayUsageRate,
        if (avgLatencyMs != null) 'avgLatencyMs': avgLatencyMs,
      };

  @override
  String toString() => 'NetworkMetrics('
      'sig=${signalingConnectSuccessRate?.toStringAsFixed(2)}'
      '[$signalingConnectAttempts], '
      'rtc=${webrtcEstablishSuccessRate?.toStringAsFixed(2)}'
      '[$webrtcEstablishAttempts], '
      'relay=${relayUsageRate?.toStringAsFixed(2)}, '
      'lat=${avgLatencyMs?.toStringAsFixed(1)}ms)';
}

/// Tracks network connection metrics for diagnostics reporting.
///
/// Usage:
/// ```dart
/// final tracker = NetworkTracker();
/// tracker.start();
/// tracker.recordSignalingAttempt(success: true);
/// tracker.recordWebRTCAttempt(success: false);
/// tracker.recordConnectionType('direct_p2p');
/// tracker.recordLatency(42.5);
/// final metrics = tracker.getMetrics();
/// tracker.stop();
/// ```
class NetworkTracker {
  // Signaling counters
  int _signalingAttempts = 0;
  int _signalingSuccesses = 0;

  // WebRTC counters
  int _webrtcAttempts = 0;
  int _webrtcSuccesses = 0;

  // Connection type counters
  int _directConnections = 0;
  int _relayConnections = 0;

  // Latency samples (rolling window)
  static const int _maxLatencySamples = 100;
  final List<double> _latencySamples = [];

  /// Whether the tracker is currently running.
  bool _running = false;

  /// Whether the tracker is currently running.
  bool get isRunning => _running;

  /// Start tracking network metrics.
  void start() {
    if (_running) return;
    _running = true;
  }

  /// Stop tracking network metrics.
  void stop() {
    if (!_running) return;
    _running = false;
  }

  /// Record a signaling connection attempt.
  void recordSignalingAttempt({required bool success}) {
    if (!_running) return;
    _signalingAttempts++;
    if (success) _signalingSuccesses++;
  }

  /// Record a WebRTC peer establishment attempt.
  void recordWebRTCAttempt({required bool success}) {
    if (!_running) return;
    _webrtcAttempts++;
    if (success) _webrtcSuccesses++;
  }

  /// Record the connection type for a completed connection.
  ///
  /// [type] should be `'direct_p2p'` or `'relay'`.
  void recordConnectionType(String type) {
    if (!_running) return;
    if (type == 'relay') {
      _relayConnections++;
    } else {
      _directConnections++;
    }
  }

  /// Record a latency measurement in milliseconds.
  void recordLatency(double latencyMs) {
    if (!_running) return;
    _latencySamples.add(latencyMs);
    if (_latencySamples.length > _maxLatencySamples) {
      _latencySamples.removeAt(0);
    }
  }

  /// Return a snapshot of the current network metrics.
  ///
  /// Returns null if the tracker has never been started.
  NetworkMetrics? getMetrics() {
    if (!_running && _signalingAttempts == 0 && _webrtcAttempts == 0) {
      return null;
    }

    return NetworkMetrics(
      signalingConnectSuccessRate: _signalingAttempts > 0
          ? _signalingSuccesses / _signalingAttempts
          : null,
      signalingConnectAttempts:
          _signalingAttempts > 0 ? _signalingAttempts : null,
      webrtcEstablishSuccessRate:
          _webrtcAttempts > 0 ? _webrtcSuccesses / _webrtcAttempts : null,
      webrtcEstablishAttempts: _webrtcAttempts > 0 ? _webrtcAttempts : null,
      relayUsageRate: (_directConnections + _relayConnections) > 0
          ? _relayConnections / (_directConnections + _relayConnections)
          : null,
      avgLatencyMs: _latencySamples.isNotEmpty
          ? _latencySamples.reduce((a, b) => a + b) / _latencySamples.length
          : null,
    );
  }

  /// Reset all counters. Useful for testing or after a report upload.
  void reset() {
    _signalingAttempts = 0;
    _signalingSuccesses = 0;
    _webrtcAttempts = 0;
    _webrtcSuccesses = 0;
    _directConnections = 0;
    _relayConnections = 0;
    _latencySamples.clear();
  }
}
