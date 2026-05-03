import 'server_discovery_service.dart' show DiscoveredServer;

/// A process-local "do not retry" list for signaling endpoints.
///
/// When a connection attempt to a signaling server fails, the endpoint is
/// added here so subsequent connection attempts skip it for a short window.
/// This prevents the client from wasting its retry budget on servers that
/// are currently broken — either because their Cranl/hosting container is
/// crash-looping, their DNS has not propagated, or they are overloaded.
///
/// The skip list is consulted by every connection site: initial signaling
/// connect, reconnect loop, pairing redirects, and federation. One shared
/// instance is held via the [ProviderScope] tree so a failure observed by
/// one path is respected by all paths.
///
/// The TTL defaults to 5 minutes, matching the bootstrap worker's
/// heartbeat TTL — by the time the skip expires, a genuinely dead server
/// will also have been evicted from the registry.
class ServerSkipList {
  final Duration ttl;
  final DateTime Function() _clock;
  final Map<String, DateTime> _skipUntil = <String, DateTime>{};

  ServerSkipList({
    this.ttl = const Duration(minutes: 5),
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  /// Mark [endpoint] as skipped for the TTL window starting now.
  /// Calling [add] again on an already-skipped endpoint re-arms the TTL
  /// from the later call.
  void add(String endpoint) {
    _skipUntil[endpoint] = _clock().add(ttl);
  }

  /// Returns true if [endpoint] is currently in the skip window.
  /// Expired entries are cleaned up lazily on read.
  bool isSkipped(String endpoint) {
    final until = _skipUntil[endpoint];
    if (until == null) return false;
    if (!_clock().isBefore(until)) {
      _skipUntil.remove(endpoint);
      return false;
    }
    return true;
  }

  /// Returns the subset of [servers] whose endpoints are not currently
  /// skipped.
  List<DiscoveredServer> filter(List<DiscoveredServer> servers) {
    return servers.where((s) => !isSkipped(s.endpoint)).toList();
  }

  /// Remove every entry. Primarily for tests.
  void clear() {
    _skipUntil.clear();
  }
}
