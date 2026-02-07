import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import '../crypto/bootstrap_verifier.dart';
import '../logging/logger_service.dart';

/// Represents a discovered VPS server from the bootstrap service.
class DiscoveredServer {
  final String serverId;
  final String endpoint;
  final String publicKey;
  final String region;
  final int registeredAt;
  final int lastSeen;

  const DiscoveredServer({
    required this.serverId,
    required this.endpoint,
    required this.publicKey,
    required this.region,
    required this.registeredAt,
    required this.lastSeen,
  });

  factory DiscoveredServer.fromJson(Map<String, dynamic> json) {
    return DiscoveredServer(
      serverId: json['serverId'] as String,
      endpoint: json['endpoint'] as String,
      publicKey: json['publicKey'] as String,
      region: json['region'] as String? ?? 'unknown',
      registeredAt: json['registeredAt'] as int? ?? 0,
      lastSeen: json['lastSeen'] as int? ?? 0,
    );
  }

  /// Check if the server was seen recently (within last 2 minutes).
  bool get isRecent {
    final now = DateTime.now().millisecondsSinceEpoch;
    return now - lastSeen < 2 * 60 * 1000;
  }

  @override
  String toString() => 'DiscoveredServer($serverId, $endpoint, region=$region)';
}

/// Service for discovering VPS servers via the Cloudflare Workers bootstrap server.
///
/// The bootstrap server (CF Workers) maintains a registry of active VPS servers.
/// This service fetches that list and helps select the best server to connect to.
class ServerDiscoveryService {
  /// The URL of the CF Workers bootstrap server.
  final String bootstrapUrl;

  /// HTTP client for making requests.
  final http.Client _client;

  /// Optional verifier for bootstrap response signatures.
  final BootstrapVerifier? _verifier;

  /// Cached list of discovered servers.
  List<DiscoveredServer> _cachedServers = [];

  /// When the cache was last refreshed.
  DateTime? _cacheTime;

  /// Cache duration (servers are refreshed after this time).
  static const cacheDuration = Duration(minutes: 2);

  /// Controller for server list updates.
  final _serversController = StreamController<List<DiscoveredServer>>.broadcast();

  /// Timer for periodic refresh.
  Timer? _refreshTimer;

  ServerDiscoveryService({
    required this.bootstrapUrl,
    http.Client? client,
    BootstrapVerifier? bootstrapVerifier,
  })  : _client = client ?? http.Client(),
        _verifier = bootstrapVerifier;

  /// Stream of server list updates.
  Stream<List<DiscoveredServer>> get servers => _serversController.stream;

  /// Get the current cached servers (may be stale).
  List<DiscoveredServer> get cachedServers => List.unmodifiable(_cachedServers);

  /// Fetch available VPS servers from the bootstrap server.
  ///
  /// Returns a list of discovered servers, or an empty list if the
  /// bootstrap server is unreachable.
  Future<List<DiscoveredServer>> fetchServers({bool forceRefresh = false}) async {
    // Return cached servers if still fresh
    if (!forceRefresh && _cacheTime != null) {
      final age = DateTime.now().difference(_cacheTime!);
      if (age < cacheDuration && _cachedServers.isNotEmpty) {
        return _cachedServers;
      }
    }

    try {
      final uri = Uri.parse('$bootstrapUrl/servers');
      final response = await _client.get(uri).timeout(
        const Duration(seconds: 10),
        onTimeout: () => throw TimeoutException('Bootstrap server timeout'),
      );

      if (response.statusCode != 200) {
        throw Exception('Bootstrap server returned ${response.statusCode}');
      }

      // Verify bootstrap response signature if verifier is configured
      if (_verifier != null) {
        final signature = response.headers['x-bootstrap-signature'];
        if (signature == null || signature.isEmpty) {
          throw Exception('Bootstrap response missing signature');
        }
        final valid = await _verifier.verify(response.body, signature);
        if (!valid) {
          throw Exception('Bootstrap response signature verification failed');
        }
      }

      final json = jsonDecode(response.body) as Map<String, dynamic>;
      final serverList = json['servers'] as List<dynamic>? ?? [];

      _cachedServers = serverList
          .map((s) => DiscoveredServer.fromJson(s as Map<String, dynamic>))
          .where((s) => s.isRecent) // Only include recently seen servers
          .toList();

      _cacheTime = DateTime.now();
      _serversController.add(_cachedServers);

      return _cachedServers;
    } catch (e) {
      // Graceful degradation: Return cached servers on discovery error.
      // Network errors, timeouts, or server unavailability shouldn't block the app.
      // Cached servers may be stale but still usable for connection attempts.
      logger.error('ServerDiscovery', 'Discovery failed (url: $bootstrapUrl/servers), using cache', e);
      return _cachedServers;
    }
  }

  /// Select the best server to connect to.
  ///
  /// Selection strategy:
  /// 1. Prefer servers in the same region (if region is provided)
  /// 2. Prefer servers seen most recently
  /// 3. Random selection among top candidates
  ///
  /// Returns null if no servers are available.
  Future<DiscoveredServer?> selectServer({String? preferredRegion}) async {
    final servers = await fetchServers();

    if (servers.isEmpty) {
      return null;
    }

    // Filter by region if preferred
    List<DiscoveredServer> candidates = servers;
    if (preferredRegion != null) {
      final regionServers = servers.where((s) => s.region == preferredRegion).toList();
      if (regionServers.isNotEmpty) {
        candidates = regionServers;
      }
    }

    // Sort by lastSeen (most recent first)
    candidates.sort((a, b) => b.lastSeen.compareTo(a.lastSeen));

    // Take top 3 candidates and pick randomly for load distribution
    final topCandidates = candidates.take(3).toList();
    final random = Random();
    return topCandidates[random.nextInt(topCandidates.length)];
  }

  /// Get the WebSocket URL for connecting to a server.
  ///
  /// The endpoint stored in the registry is typically a WebSocket URL.
  /// This method ensures it's properly formatted.
  String getWebSocketUrl(DiscoveredServer server) {
    final endpoint = server.endpoint;

    // Already a WebSocket URL
    if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) {
      return endpoint;
    }

    // Convert HTTP to WS
    if (endpoint.startsWith('https://')) {
      return endpoint.replaceFirst('https://', 'wss://');
    }
    if (endpoint.startsWith('http://')) {
      return endpoint.replaceFirst('http://', 'ws://');
    }

    // Assume wss by default
    return 'wss://$endpoint';
  }

  /// Start periodic server list refresh.
  ///
  /// Useful for keeping the server list up-to-date while the app is running.
  void startPeriodicRefresh({Duration interval = const Duration(minutes: 1)}) {
    stopPeriodicRefresh();
    _refreshTimer = Timer.periodic(interval, (_) => fetchServers(forceRefresh: true));
  }

  /// Stop periodic server list refresh.
  void stopPeriodicRefresh() {
    _refreshTimer?.cancel();
    _refreshTimer = null;
  }

  /// Dispose resources.
  void dispose() {
    stopPeriodicRefresh();
    _serversController.close();
    _client.close();
  }
}
