import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../logging/logger_service.dart';
import 'relay_models.dart';
import 'relay_exceptions.dart';
import 'signaling_client.dart';
import 'webrtc_service.dart';

export 'relay_models.dart';
export 'relay_exceptions.dart';

/// Client for managing relay connections and introduction protocol.
///
/// This client handles:
/// - Connecting to relay peers via WebRTC
/// - Acting as a relay for other peers (introduction forwarding)
/// - Managing relay connections and load reporting
/// - Handling introduction requests and responses
class RelayClient {
  final WebRTCService _webrtcService;
  final SignalingClient _signalingClient;
  final int maxRelayConnections;

  /// Map of relay peer IDs to their connection info.
  final Map<String, RelayConnection> _relayConnections = {};

  /// Map of source ID -> peer ID (for peers using us as relay).
  final Map<String, String> _sourceIdToPeerId = {};

  /// Map of peer ID -> source ID.
  final Map<String, String> _peerIdToSourceId = {};

  /// Our unique source ID for relay routing.
  late final String mySourceId;

  /// Current load (number of peers using us as relay).
  int _currentLoad = 0;

  /// Previous load for detecting significant changes.
  int _previousLoad = 0;

  /// Threshold for auto-reporting load changes.
  int autoReportThreshold = 5;

  /// Maximum capacity for peers using us as relay (-1 = unlimited).
  int _maxCapacity = -1;

  /// Timer for periodic load reporting.
  Timer? _loadReportTimer;

  // Stream controllers
  final _introductionController =
      StreamController<IntroductionEvent>.broadcast();
  final _introductionErrorController =
      StreamController<IntroductionErrorEvent>.broadcast();
  final _stateController = StreamController<RelayStateEvent>.broadcast();
  final _loadChangeController = StreamController<LoadChangeEvent>.broadcast();

  /// Stream of introduction events.
  Stream<IntroductionEvent> get onIntroduction =>
      _introductionController.stream;

  /// Stream of introduction error events.
  Stream<IntroductionErrorEvent> get onIntroductionError =>
      _introductionErrorController.stream;

  /// Stream of relay state change events.
  Stream<RelayStateEvent> get onRelayStateChange => _stateController.stream;

  /// Stream of load change events.
  Stream<LoadChangeEvent> get onLoadChange => _loadChangeController.stream;

  /// Current load (peers using us as relay).
  int get currentLoad => _currentLoad;

  /// Maximum capacity.
  int get maxCapacity => _maxCapacity;

  /// Whether we're at capacity.
  bool get isAtCapacity =>
      _maxCapacity > 0 && _currentLoad >= _maxCapacity;

  /// Available capacity.
  int get availableCapacity =>
      _maxCapacity < 0 ? -1 : max(0, _maxCapacity - _currentLoad);

  /// Create a new RelayClient.
  ///
  /// [webrtcService] - Service for WebRTC connections
  /// [signalingClient] - Client for signaling server communication
  /// [maxRelayConnections] - Maximum number of relay connections (default 10)
  /// [savedSourceId] - Previously saved source ID (for persistence across sessions)
  RelayClient({
    required WebRTCService webrtcService,
    required SignalingClient signalingClient,
    this.maxRelayConnections = 10,
    String? savedSourceId,
  })  : _webrtcService = webrtcService,
        _signalingClient = signalingClient {
    mySourceId = savedSourceId ?? _generateSourceId();
  }

  /// Connect to a list of relay peers.
  ///
  /// Will connect to up to [maxRelayConnections] relays from the provided list.
  /// Already connected relays are skipped.
  Future<void> connectToRelays(List<RelayInfo> relays) async {
    final toConnect = relays
        .where((r) => !_relayConnections.containsKey(r.peerId))
        .take(maxRelayConnections - _relayConnections.length)
        .toList();

    for (final relay in toConnect) {
      try {
        await _connectToRelay(relay);
      } catch (e) {
        logger.error('RelayClient', 'Failed to connect to relay ${relay.peerId}', e);
        _stateController.add(RelayStateEvent(
          relayId: relay.peerId,
          state: RelayConnectionState.failed,
          errorMessage: e.toString(),
        ));
      }
    }
  }

  /// Ensure connection to a specific relay.
  ///
  /// If already connected, does nothing.
  /// If [relayInfo] is provided, uses it. Otherwise, must already be connected.
  Future<void> ensureConnectedToRelay(
    String relayId, {
    RelayInfo? relayInfo,
  }) async {
    if (_relayConnections.containsKey(relayId)) {
      return;
    }

    if (relayInfo != null) {
      await _connectToRelay(relayInfo);
    } else {
      throw RelayNotConnectedException(relayId);
    }
  }

  /// Disconnect from a relay.
  Future<void> disconnectRelay(String relayId) async {
    final connection = _relayConnections.remove(relayId);
    if (connection != null) {
      await _webrtcService.closeConnection(relayId);

      // Clear source ID mappings
      final sourceId = _peerIdToSourceId.remove(relayId);
      if (sourceId != null) {
        _sourceIdToPeerId.remove(sourceId);
      }

      _stateController.add(RelayStateEvent(
        relayId: relayId,
        state: RelayConnectionState.disconnected,
      ));
    }
  }

  /// Get list of connected relay IDs.
  List<String> getConnectedRelayIds() {
    return _relayConnections.keys.toList();
  }

  /// Get a random connected relay ID, or null if none.
  String? getCurrentRelayId() {
    if (_relayConnections.isEmpty) return null;
    final ids = getConnectedRelayIds();
    return ids[DateTime.now().millisecondsSinceEpoch % ids.length];
  }

  /// Send an introduction request through a relay.
  ///
  /// [relayId] - The relay to send through
  /// [targetSourceId] - The source ID of the target peer
  /// [encryptedPayload] - The encrypted connection information
  Future<void> sendIntroduction({
    required String relayId,
    required String targetSourceId,
    required String encryptedPayload,
  }) async {
    final connection = _relayConnections[relayId];
    if (connection == null) {
      throw RelayNotConnectedException(relayId);
    }

    final message = jsonEncode({
      'type': 'introduction_request',
      'fromSourceId': mySourceId,
      'targetSourceId': targetSourceId,
      'payload': encryptedPayload,
      'timestamp': DateTime.now().millisecondsSinceEpoch,
    });

    await _webrtcService.sendMessage(relayId, message);
  }

  /// Handle an introduction request (when we're acting as relay).
  ///
  /// Forwards the request to the target if they're connected to us.
  Future<void> handleIntroductionRequest(
    String fromPeerId,
    IntroductionRequest request,
  ) async {
    // Find the target peer
    final targetPeerId = _sourceIdToPeerId[request.targetSourceId];

    if (targetPeerId == null ||
        !_relayConnections.containsKey(targetPeerId)) {
      // Target not connected to us
      await _sendIntroductionError(
        fromPeerId,
        request.targetSourceId,
        'target_not_found',
      );
      return;
    }

    // Forward the introduction to the target
    final forwardMessage = jsonEncode({
      'type': 'introduction_forward',
      'fromSourceId': request.fromSourceId,
      'payload': request.payload,
    });

    await _webrtcService.sendMessage(targetPeerId, forwardMessage);
  }

  /// Handle an introduction response/forward.
  Future<void> handleIntroductionResponse(
    String fromRelayId,
    IntroductionResponse response,
  ) async {
    _introductionController.add(IntroductionEvent(
      fromSourceId: response.fromSourceId,
      payload: response.payload,
      relayId: fromRelayId,
    ));
  }

  /// Handle an introduction error.
  Future<void> handleIntroductionError(
    String fromRelayId,
    IntroductionError error,
  ) async {
    _introductionErrorController.add(IntroductionErrorEvent(
      targetSourceId: error.targetSourceId,
      error: error.error,
      relayId: fromRelayId,
    ));
  }

  /// Register a peer's source ID.
  void registerSourceId(String peerId, String sourceId) {
    // Remove old mapping if exists
    final oldSourceId = _peerIdToSourceId[peerId];
    if (oldSourceId != null) {
      _sourceIdToPeerId.remove(oldSourceId);
    }

    _sourceIdToPeerId[sourceId] = peerId;
    _peerIdToSourceId[peerId] = sourceId;
  }

  /// Unregister a peer's source ID.
  void unregisterSourceId(String peerId) {
    final sourceId = _peerIdToSourceId.remove(peerId);
    if (sourceId != null) {
      _sourceIdToPeerId.remove(sourceId);
    }
  }

  /// Get source ID for a peer.
  String? getSourceId(String peerId) => _peerIdToSourceId[peerId];

  /// Get peer ID by source ID.
  String? getPeerIdBySourceId(String sourceId) => _sourceIdToPeerId[sourceId];

  /// Check if a source ID is registered.
  bool isSourceIdRegistered(String sourceId) =>
      _sourceIdToPeerId.containsKey(sourceId);

  /// Get all registered peer IDs.
  List<String> getAllRegisteredPeers() => _peerIdToSourceId.keys.toList();

  /// Get all registered source IDs.
  List<String> getAllRegisteredSourceIds() =>
      _sourceIdToPeerId.keys.toList();

  /// Clear all source ID mappings.
  void clearAllSourceIdMappings() {
    _sourceIdToPeerId.clear();
    _peerIdToSourceId.clear();
  }

  /// Export source ID mappings for persistence.
  Map<String, String> exportSourceIdMappings() =>
      Map.from(_peerIdToSourceId);

  /// Import source ID mappings from persistence.
  void importSourceIdMappings(Map<String, String> mappings) {
    for (final entry in mappings.entries) {
      registerSourceId(entry.key, entry.value);
    }
  }

  /// Handle peer handshake (receive their source ID).
  void handlePeerHandshake(String peerId, Map<String, dynamic> handshake) {
    final sourceId = handshake['sourceId'] as String?;
    if (sourceId != null) {
      registerSourceId(peerId, sourceId);
    }
  }

  /// Update local load (peers using us as relay).
  void updateLocalLoad(int count) {
    _previousLoad = _currentLoad;
    _currentLoad = count;

    _loadChangeController.add(LoadChangeEvent(
      previousLoad: _previousLoad,
      currentLoad: _currentLoad,
    ));

    // Auto-report if change is significant
    if ((_currentLoad - _previousLoad).abs() >= autoReportThreshold) {
      reportLoad();
    }
  }

  /// Increment load by one.
  void incrementLoad() {
    updateLocalLoad(_currentLoad + 1);
  }

  /// Decrement load by one (minimum 0).
  void decrementLoad() {
    updateLocalLoad(max(0, _currentLoad - 1));
  }

  /// Set maximum capacity.
  void setMaxCapacity(int capacity) {
    _maxCapacity = capacity;
  }

  /// Report current load to signaling server.
  Future<void> reportLoad() async {
    await _signalingClient.send({
      'type': 'update_load',
      'sourceId': mySourceId,
      'connectedCount': _currentLoad,
      if (_maxCapacity > 0) 'maxCapacity': _maxCapacity,
    });
  }

  /// Start periodic load reporting.
  void startPeriodicLoadReporting({
    Duration interval = const Duration(seconds: 30),
  }) {
    _loadReportTimer?.cancel();
    _loadReportTimer = Timer.periodic(interval, (_) => reportLoad());
  }

  /// Stop periodic load reporting.
  void stopPeriodicLoadReporting() {
    _loadReportTimer?.cancel();
    _loadReportTimer = null;
  }

  /// Handle incoming relay message from WebRTC.
  void handleRelayMessage(String peerId, String data) {
    try {
      final msg = jsonDecode(data) as Map<String, dynamic>;
      final type = msg['type'] as String?;

      switch (type) {
        case 'relay_handshake':
          handlePeerHandshake(peerId, msg);
          break;
        case 'introduction_request':
          handleIntroductionRequest(
              peerId, IntroductionRequest.fromJson(msg));
          break;
        case 'introduction_forward':
          handleIntroductionResponse(
              peerId, IntroductionResponse.fromJson(msg));
          break;
        case 'introduction_error':
          handleIntroductionError(peerId, IntroductionError.fromJson(msg));
          break;
      }
    } catch (e) {
      logger.error('RelayClient', 'Error handling relay message', e);
    }
  }

  /// Connect to a single relay.
  Future<void> _connectToRelay(RelayInfo relay) async {
    _stateController.add(RelayStateEvent(
      relayId: relay.peerId,
      state: RelayConnectionState.connecting,
    ));

    // Create WebRTC offer
    await _webrtcService.createOffer(relay.peerId);

    // Store connection info
    _relayConnections[relay.peerId] = RelayConnection(
      peerId: relay.peerId,
      publicKey: relay.publicKey,
      connectedAt: DateTime.now(),
      state: RelayConnectionState.connecting,
    );

    // Send our handshake with source ID
    await _webrtcService.sendMessage(
      relay.peerId,
      jsonEncode({
        'type': 'relay_handshake',
        'sourceId': mySourceId,
        'timestamp': DateTime.now().millisecondsSinceEpoch,
      }),
    );

    _stateController.add(RelayStateEvent(
      relayId: relay.peerId,
      state: RelayConnectionState.connected,
    ));
  }

  /// Send introduction error response.
  Future<void> _sendIntroductionError(
    String peerId,
    String targetSourceId,
    String error,
  ) async {
    await _webrtcService.sendMessage(
      peerId,
      jsonEncode({
        'type': 'introduction_error',
        'targetSourceId': targetSourceId,
        'error': error,
      }),
    );
  }

  /// Generate a unique source ID.
  String _generateSourceId() {
    return const Uuid().v4().replaceAll('-', '').substring(0, 16);
  }

  /// Dispose resources.
  void dispose() {
    _loadReportTimer?.cancel();
    _introductionController.close();
    _introductionErrorController.close();
    _stateController.close();
    _loadChangeController.close();

    for (final relayId in _relayConnections.keys.toList()) {
      _webrtcService.closeConnection(relayId);
    }
    _relayConnections.clear();
    _sourceIdToPeerId.clear();
    _peerIdToSourceId.clear();
  }
}

/// Provider for the relay client.
final relayClientProvider = Provider<RelayClient>((ref) {
  throw UnimplementedError('Must be overridden in ProviderScope');
});
