import 'dart:async';

import 'package:bonsoir/bonsoir.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../models/peer.dart';

/// Service for discovering peers on the local network using mDNS/DNS-SD.
///
/// Uses the Bonsoir package which wraps platform-specific implementations:
/// - Linux: Avahi
/// - macOS/iOS: Bonjour
/// - Windows: Windows DNS-SD
/// - Android: NSD
class DiscoveryService {
  static const String _serviceType = '_zajel._tcp';

  final String _instanceId;
  final String _displayName;
  final int _port;

  BonsoirBroadcast? _broadcast;
  BonsoirDiscovery? _discovery;
  StreamSubscription? _discoverySubscription;

  final _peersController = StreamController<List<Peer>>.broadcast();
  final Map<String, Peer> _discoveredPeers = {};

  bool _isRunning = false;

  DiscoveryService({
    required String displayName,
    required int port,
    String? instanceId,
  })  : _displayName = displayName,
        _port = port,
        _instanceId = instanceId ?? const Uuid().v4();

  /// Stream of discovered peers.
  Stream<List<Peer>> get peers => _peersController.stream;

  /// Current list of discovered peers.
  List<Peer> get currentPeers => _discoveredPeers.values.toList();

  /// Our instance ID for identification.
  String get instanceId => _instanceId;

  /// Whether the service is currently running.
  bool get isRunning => _isRunning;

  /// Start broadcasting our presence and discovering other peers.
  Future<void> start() async {
    if (_isRunning) return;

    try {
      await _startBroadcast();
    } catch (e, stack) {
      print('Broadcast failed: $e\n$stack');
    }

    try {
      await _startDiscovery();
    } catch (e, stack) {
      print('Discovery failed: $e\n$stack');
    }

    _isRunning = true;
  }

  /// Stop broadcasting and discovery.
  Future<void> stop() async {
    if (!_isRunning) return;

    await _stopBroadcast();
    await _stopDiscovery();
    _discoveredPeers.clear();
    _isRunning = false;
  }

  /// Restart the service (useful when network changes).
  Future<void> restart() async {
    await stop();
    await start();
  }

  /// Dispose of resources.
  Future<void> dispose() async {
    await stop();
    await _peersController.close();
  }

  // Private methods

  Future<void> _startBroadcast() async {
    final service = BonsoirService(
      name: _displayName,
      type: _serviceType,
      port: _port,
      attributes: {
        'id': _instanceId,
        'version': '1',
      },
    );

    _broadcast = BonsoirBroadcast(service: service);
    // Must initialize before start on Linux (Avahi requires it)
    await _broadcast!.initialize();
    await _broadcast!.start();
  }

  Future<void> _stopBroadcast() async {
    await _broadcast?.stop();
    _broadcast = null;
  }

  Future<void> _startDiscovery() async {
    _discovery = BonsoirDiscovery(type: _serviceType);

    // Must initialize before start on Linux (Avahi requires it)
    await _discovery!.initialize();

    // Subscribe to event stream before starting
    final eventStream = _discovery!.eventStream;
    if (eventStream != null) {
      _discoverySubscription = eventStream.listen((event) {
        _handleDiscoveryEvent(event);
      });
    }

    await _discovery!.start();
  }

  Future<void> _stopDiscovery() async {
    await _discoverySubscription?.cancel();
    _discoverySubscription = null;
    await _discovery?.stop();
    _discovery = null;
  }

  void _handleDiscoveryEvent(BonsoirDiscoveryEvent event) {
    switch (event) {
      case BonsoirDiscoveryStartedEvent():
        // Discovery started - nothing to do
        break;

      case BonsoirDiscoveryServiceFoundEvent():
        // Service found, not yet resolved - ignore for now
        break;

      case BonsoirDiscoveryServiceResolvedEvent():
        final service = event.service;
        // Skip our own service
        final serviceId = service.attributes['id'];
        if (serviceId == _instanceId) return;
        _handleServiceResolved(service);
        break;

      case BonsoirDiscoveryServiceUpdatedEvent():
        // Service updated - treat same as resolved
        final service = event.service;
        final serviceId = service.attributes['id'];
        if (serviceId == _instanceId) return;
        _handleServiceResolved(service);
        break;

      case BonsoirDiscoveryServiceLostEvent():
        final service = event.service;
        _handleServiceLost(service);
        break;

      case BonsoirDiscoveryServiceResolveFailedEvent():
        // Service resolution failed - ignore
        break;

      default:
        // Handle any other event types (stopped, etc.)
        break;
    }
  }

  void _handleServiceResolved(BonsoirService service) {
    final peerId = service.attributes['id'];
    if (peerId == null) return;

    // Get resolved service details
    String? ipAddress;
    int port = service.port;

    // Try to get the host/IP from the resolved service
    if (service.attributes.containsKey('host')) {
      ipAddress = service.attributes['host'];
    }

    final peer = Peer(
      id: peerId,
      displayName: service.name,
      ipAddress: ipAddress,
      port: port,
      connectionState: PeerConnectionState.disconnected,
      lastSeen: DateTime.now(),
      isLocal: true,
    );

    _discoveredPeers[peerId] = peer;
    _notifyPeersChanged();
  }

  void _handleServiceLost(BonsoirService service) {
    final peerId = service.attributes['id'];
    if (peerId == null) return;

    _discoveredPeers.remove(peerId);
    _notifyPeersChanged();
  }

  void _notifyPeersChanged() {
    _peersController.add(_discoveredPeers.values.toList());
  }
}

/// Provider for the discovery service.
final discoveryServiceProvider = Provider<DiscoveryService>((ref) {
  throw UnimplementedError('Must be overridden in ProviderScope');
});

/// Provider for the stream of discovered peers.
final discoveredPeersProvider = StreamProvider<List<Peer>>((ref) {
  final discoveryService = ref.watch(discoveryServiceProvider);
  return discoveryService.peers;
});
