import '../../../core/logging/logger_service.dart';
import '../../../core/network/server_discovery_service.dart';

/// Verifies VPS server identity against the bootstrap registry.
///
/// When connecting to a VPS server via WebSocket, this service checks
/// that the server's Ed25519 identity key matches what was received
/// from the bootstrap `/servers` endpoint.
///
/// Trust chain:
/// ```
/// Bootstrap (pinned key in app binary)
///   -> signs VPS server registry
///     -> each VPS server has registered identity key
///       -> app verifies VPS on every connection
/// ```
class ServerAttestationService {
  static const _tag = 'ServerAttestation';

  /// Cache of verified server identity keys, keyed by server ID.
  final Map<String, String> _verifiedServers = {};

  /// Set the list of discovered servers from bootstrap.
  ///
  /// This should be called after fetching the server list from bootstrap.
  /// The identity keys from the signed bootstrap response are trusted.
  void updateServerRegistry(List<DiscoveredServer> servers) {
    _verifiedServers.clear();
    for (final server in servers) {
      if (server.identityKey != null && server.identityKey!.isNotEmpty) {
        _verifiedServers[server.serverId] = server.identityKey!;
      }
    }
    logger.info(
      _tag,
      'Updated server registry: ${_verifiedServers.length} servers with identity keys',
    );
  }

  /// Verify a server's identity key against the bootstrap registry.
  ///
  /// Returns true if the server's identity key matches what was registered
  /// in the bootstrap server. Returns false if:
  /// - The server ID is unknown (not in bootstrap registry)
  /// - The server has no registered identity key
  /// - The identity key doesn't match
  bool verifyServer({
    required String serverId,
    required String identityKey,
  }) {
    final registeredKey = _verifiedServers[serverId];

    if (registeredKey == null) {
      logger.warning(
        _tag,
        'Server $serverId not found in registry — refusing connection',
      );
      return false;
    }

    if (registeredKey != identityKey) {
      logger.warning(
        _tag,
        'Server $serverId identity key mismatch — refusing connection. '
        'Expected: ${registeredKey.substring(0, 8)}..., '
        'Got: ${identityKey.substring(0, identityKey.length < 8 ? identityKey.length : 8)}...',
      );
      return false;
    }

    logger.info(
      _tag,
      'Server $serverId identity verified',
    );
    return true;
  }

  /// Check if a server is registered in the bootstrap registry.
  bool isServerKnown(String serverId) {
    return _verifiedServers.containsKey(serverId);
  }

  /// Get the registered identity key for a server.
  String? getServerIdentityKey(String serverId) {
    return _verifiedServers[serverId];
  }
}
