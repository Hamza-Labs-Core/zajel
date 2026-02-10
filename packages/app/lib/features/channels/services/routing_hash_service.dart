import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Duration of a routing hash epoch.
///
/// Subscribers and the owner derive the same routing hash for a given epoch,
/// allowing them to publish and fetch chunks from the VPS relay using an
/// opaque identifier that rotates periodically. The VPS sees a different
/// hash each epoch, making long-term traffic analysis harder.
enum RoutingHashEpochDuration {
  /// Rotate every hour (more resistant to traffic analysis).
  hourly,

  /// Rotate every day (less overhead, suitable for lower-volume channels).
  daily,
}

/// Result of a VPS fetch attempt, used for censorship detection.
enum FetchResult {
  /// Chunks were fetched successfully.
  success,

  /// Network error (e.g., timeout, DNS failure).
  networkError,

  /// VPS returned an error indicating the routing hash is blocked.
  blocked,

  /// VPS returned empty results (could be normal or censorship).
  empty,
}

/// Health status of a VPS node.
class VpsNodeHealth {
  /// The VPS node URL.
  final String url;

  /// Number of successful fetches.
  int successCount;

  /// Number of failed fetches.
  int failureCount;

  /// Whether this node is currently suspected of blocking.
  bool suspectedBlocking;

  /// Last successful fetch time.
  DateTime? lastSuccess;

  /// Last failure time.
  DateTime? lastFailure;

  VpsNodeHealth({
    required this.url,
    this.successCount = 0,
    this.failureCount = 0,
    this.suspectedBlocking = false,
    this.lastSuccess,
    this.lastFailure,
  });

  /// Success rate as a fraction (0.0 to 1.0).
  /// Returns 1.0 if no attempts have been made.
  double get successRate {
    final total = successCount + failureCount;
    if (total == 0) return 1.0;
    return successCount / total;
  }
}

/// Censorship detection result.
class CensorshipDetectionResult {
  /// Whether censorship is suspected.
  final bool isCensored;

  /// The type of censorship detected.
  final CensorshipType type;

  /// A human-readable description.
  final String description;

  const CensorshipDetectionResult({
    required this.isCensored,
    required this.type,
    required this.description,
  });
}

/// Type of censorship detected.
enum CensorshipType {
  /// No censorship detected.
  none,

  /// The specific routing hash appears to be blocked.
  routingHashBlocked,

  /// The VPS node appears to be completely unreachable.
  nodeUnreachable,

  /// Multiple VPS nodes are blocking the same content.
  widespreadBlocking,
}

/// Service for generating rotating routing hashes and managing
/// censorship resistance features.
///
/// Routing hashes are derived using HMAC(channel_secret, "epoch:<period>")
/// so all channel members compute the same hash for a given epoch, while
/// the VPS relay sees an opaque, rotating identifier.
class RoutingHashService {
  final Hmac _hmac = Hmac.sha256();

  /// Known VPS nodes in the federation.
  final List<VpsNodeHealth> _knownNodes = [];

  /// History of fetch results per routing hash, for censorship detection.
  /// Maps routing_hash -> list of (vps_url, FetchResult) pairs.
  final Map<String, List<({String vpsUrl, FetchResult result})>>
      _fetchHistory = {};

  // ---------------------------------------------------------------------------
  // Routing hash derivation
  // ---------------------------------------------------------------------------

  /// Derive the current routing hash for a channel.
  ///
  /// The routing hash is `HMAC-SHA256(channelSecret, "epoch:<period>")`,
  /// truncated to 16 bytes and hex-encoded. All members with the channel
  /// secret derive the same hash.
  ///
  /// [channelSecret] is the base64-encoded shared secret (encryption private key).
  /// [epochDuration] determines how often the hash rotates.
  /// [now] is the current time (injectable for testing).
  Future<String> deriveRoutingHash({
    required String channelSecret,
    RoutingHashEpochDuration epochDuration = RoutingHashEpochDuration.hourly,
    DateTime? now,
  }) async {
    final currentTime = now ?? DateTime.now().toUtc();
    final epochString = _computeEpochString(currentTime, epochDuration);

    return _computeHmacHash(channelSecret, epochString);
  }

  /// Derive the routing hash for a specific epoch period.
  ///
  /// This is useful for fetching chunks from a previous epoch when
  /// subscribers need to catch up on missed content.
  Future<String> deriveRoutingHashForEpoch({
    required String channelSecret,
    required int epochNumber,
    RoutingHashEpochDuration epochDuration = RoutingHashEpochDuration.hourly,
  }) async {
    final epochString = 'epoch:${epochDuration.name}:$epochNumber';
    return _computeHmacHash(channelSecret, epochString);
  }

  /// Get the current epoch number for a given time and duration.
  int getCurrentEpochNumber({
    RoutingHashEpochDuration epochDuration = RoutingHashEpochDuration.hourly,
    DateTime? now,
  }) {
    final currentTime = now ?? DateTime.now().toUtc();
    return _getEpochNumber(currentTime, epochDuration);
  }

  /// Get the epoch numbers that a subscriber should check when catching up.
  ///
  /// Returns a list of epoch numbers from [fromTime] to [toTime].
  List<int> getEpochRange({
    required DateTime fromTime,
    required DateTime toTime,
    RoutingHashEpochDuration epochDuration = RoutingHashEpochDuration.hourly,
  }) {
    final fromEpoch = _getEpochNumber(fromTime.toUtc(), epochDuration);
    final toEpoch = _getEpochNumber(toTime.toUtc(), epochDuration);

    return List.generate(toEpoch - fromEpoch + 1, (i) => fromEpoch + i);
  }

  // ---------------------------------------------------------------------------
  // Censorship detection
  // ---------------------------------------------------------------------------

  /// Record a fetch result for censorship detection.
  void recordFetchResult({
    required String routingHash,
    required String vpsUrl,
    required FetchResult result,
  }) {
    _fetchHistory.putIfAbsent(routingHash, () => []);
    _fetchHistory[routingHash]!.add((vpsUrl: vpsUrl, result: result));

    // Update VPS node health
    final node = _getOrCreateNode(vpsUrl);
    if (result == FetchResult.success) {
      node.successCount++;
      node.lastSuccess = DateTime.now();
      node.suspectedBlocking = false;
    } else if (result == FetchResult.blocked) {
      node.failureCount++;
      node.lastFailure = DateTime.now();
      node.suspectedBlocking = true;
    } else if (result == FetchResult.networkError) {
      node.failureCount++;
      node.lastFailure = DateTime.now();
    }
  }

  /// Detect whether a specific channel (identified by routing hash)
  /// is being censored.
  ///
  /// Distinguishes between:
  /// - Network issues (all requests to a VPS fail, not just this hash)
  /// - Targeted blocking (only this hash fails on a VPS that serves others)
  /// - Widespread blocking (multiple VPS nodes block the same hash)
  CensorshipDetectionResult detectCensorship({
    required String routingHash,
  }) {
    final results = _fetchHistory[routingHash];
    if (results == null || results.isEmpty) {
      return const CensorshipDetectionResult(
        isCensored: false,
        type: CensorshipType.none,
        description: 'No fetch history available',
      );
    }

    // Count blocked results per VPS
    final blockedByVps = <String, int>{};
    final totalByVps = <String, int>{};

    for (final r in results) {
      totalByVps[r.vpsUrl] = (totalByVps[r.vpsUrl] ?? 0) + 1;
      if (r.result == FetchResult.blocked) {
        blockedByVps[r.vpsUrl] = (blockedByVps[r.vpsUrl] ?? 0) + 1;
      }
    }

    // Check if any VPS is blocking this hash
    final blockingNodes = <String>[];
    for (final vps in blockedByVps.keys) {
      final total = totalByVps[vps] ?? 0;
      final blocked = blockedByVps[vps] ?? 0;
      // If more than half of requests to this VPS for this hash are blocked
      if (total >= 2 && blocked / total > 0.5) {
        // Check if the VPS is generally unhealthy (network issue)
        // or specifically blocking this hash
        final node = _getOrCreateNode(vps);
        if (node.successRate > 0.3) {
          // VPS works for other things, so this looks like targeted blocking
          blockingNodes.add(vps);
        }
      }
    }

    if (blockingNodes.isEmpty) {
      // Check for general network issues
      final allNetworkErrors = results.every(
          (r) => r.result == FetchResult.networkError);
      if (allNetworkErrors && results.length >= 2) {
        return const CensorshipDetectionResult(
          isCensored: false,
          type: CensorshipType.nodeUnreachable,
          description: 'VPS nodes appear unreachable (network issue)',
        );
      }

      return const CensorshipDetectionResult(
        isCensored: false,
        type: CensorshipType.none,
        description: 'No censorship detected',
      );
    }

    if (blockingNodes.length >= 2) {
      return CensorshipDetectionResult(
        isCensored: true,
        type: CensorshipType.widespreadBlocking,
        description:
            'Routing hash blocked by ${blockingNodes.length} VPS nodes: '
            '${blockingNodes.join(", ")}',
      );
    }

    return CensorshipDetectionResult(
      isCensored: true,
      type: CensorshipType.routingHashBlocked,
      description:
          'Routing hash appears blocked by ${blockingNodes.first}',
    );
  }

  // ---------------------------------------------------------------------------
  // VPS node management & fallback
  // ---------------------------------------------------------------------------

  /// Add a VPS node to the known nodes list.
  void addNode(String url) {
    if (!_knownNodes.any((n) => n.url == url)) {
      _knownNodes.add(VpsNodeHealth(url: url));
    }
  }

  /// Remove a VPS node from the known nodes list.
  void removeNode(String url) {
    _knownNodes.removeWhere((n) => n.url == url);
  }

  /// Get all known VPS nodes.
  List<VpsNodeHealth> get knownNodes => List.unmodifiable(_knownNodes);

  /// Get the best VPS node to use for fetching chunks.
  ///
  /// Prefers nodes that:
  /// 1. Are not suspected of blocking
  /// 2. Have the highest success rate
  /// 3. Have been recently successful
  ///
  /// Returns null if no nodes are available.
  VpsNodeHealth? getBestNode() {
    if (_knownNodes.isEmpty) return null;

    final available = _knownNodes
        .where((n) => !n.suspectedBlocking)
        .toList();

    if (available.isEmpty) {
      // All nodes are suspected of blocking; try the least-bad one
      final sorted = List<VpsNodeHealth>.from(_knownNodes)
        ..sort((a, b) => b.successRate.compareTo(a.successRate));
      return sorted.first;
    }

    // Sort by success rate descending, then by last success time
    available.sort((a, b) {
      final rateDiff = b.successRate.compareTo(a.successRate);
      if (rateDiff != 0) return rateDiff;
      // Prefer more recently successful nodes
      if (a.lastSuccess == null && b.lastSuccess == null) return 0;
      if (a.lastSuccess == null) return 1;
      if (b.lastSuccess == null) return -1;
      return b.lastSuccess!.compareTo(a.lastSuccess!);
    });

    return available.first;
  }

  /// Get an ordered list of VPS nodes to try for fetching, with automatic
  /// fallback. Nodes suspected of blocking are placed at the end.
  List<VpsNodeHealth> getNodeFallbackOrder() {
    if (_knownNodes.isEmpty) return [];

    final notBlocking = _knownNodes
        .where((n) => !n.suspectedBlocking)
        .toList()
      ..sort((a, b) => b.successRate.compareTo(a.successRate));

    final blocking = _knownNodes
        .where((n) => n.suspectedBlocking)
        .toList()
      ..sort((a, b) => b.successRate.compareTo(a.successRate));

    return [...notBlocking, ...blocking];
  }

  /// Reset the health statistics for all nodes.
  /// Useful when the routing hash epoch changes.
  void resetNodeHealth() {
    for (final node in _knownNodes) {
      node.successCount = 0;
      node.failureCount = 0;
      node.suspectedBlocking = false;
      node.lastSuccess = null;
      node.lastFailure = null;
    }
  }

  /// Clear all fetch history.
  void clearFetchHistory() {
    _fetchHistory.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  String _computeEpochString(
      DateTime time, RoutingHashEpochDuration duration) {
    final epochNumber = _getEpochNumber(time, duration);
    return 'epoch:${duration.name}:$epochNumber';
  }

  int _getEpochNumber(DateTime time, RoutingHashEpochDuration duration) {
    final utcTime = time.toUtc();
    switch (duration) {
      case RoutingHashEpochDuration.hourly:
        // Hours since Unix epoch
        return utcTime.millisecondsSinceEpoch ~/ (3600 * 1000);
      case RoutingHashEpochDuration.daily:
        // Days since Unix epoch
        return utcTime.millisecondsSinceEpoch ~/ (86400 * 1000);
    }
  }

  Future<String> _computeHmacHash(
      String channelSecret, String epochString) async {
    final Uint8List secretBytes;
    try {
      secretBytes = base64Decode(channelSecret);
    } on FormatException {
      throw RoutingHashException('Invalid base64 encoding for channel secret');
    }

    final secretKey = SecretKey(secretBytes);
    final message = utf8.encode(epochString);

    final mac = await _hmac.calculateMac(message, secretKey: secretKey);

    // Truncate to 16 bytes (128 bits) for a compact routing hash
    final truncated = mac.bytes.sublist(0, 16);
    return truncated.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  VpsNodeHealth _getOrCreateNode(String url) {
    final existing = _knownNodes.where((n) => n.url == url).firstOrNull;
    if (existing != null) return existing;
    final node = VpsNodeHealth(url: url);
    _knownNodes.add(node);
    return node;
  }
}

/// Exception thrown by routing hash operations.
class RoutingHashException implements Exception {
  final String message;
  RoutingHashException(this.message);

  @override
  String toString() => 'RoutingHashException: $message';
}
