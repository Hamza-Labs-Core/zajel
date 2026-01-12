import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../crypto/crypto_service.dart';
import '../logging/logger_service.dart';
import '../models/linked_device.dart';
import '../models/peer.dart';
import 'webrtc_service.dart';

/// Constants for device linking.
class DeviceLinkConstants {
  /// Duration before a link session expires.
  static const sessionTimeout = Duration(minutes: 5);

  /// Link code length (6 characters).
  static const linkCodeLength = 6;

  /// Character set for link codes (excludes ambiguous characters).
  static const linkCodeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  /// Storage key prefix for linked devices.
  static const storagePrefix = 'zajel_linked_device_';

  /// Data channel label for link tunnel.
  static const tunnelChannelLabel = 'zajel_link_tunnel';

  /// Protocol prefix for QR codes.
  static const qrProtocol = 'zajel-link://';
}

/// Sealed class for device link service state.
sealed class DeviceLinkState {}

/// No active link session.
class DeviceLinkIdle extends DeviceLinkState {}

/// Waiting for web client to scan QR and connect.
class DeviceLinkWaitingForScan extends DeviceLinkState {
  final LinkSession session;
  DeviceLinkWaitingForScan(this.session);
}

/// Web client connected, performing handshake.
class DeviceLinkHandshaking extends DeviceLinkState {
  final LinkSession session;
  final String webClientId;
  DeviceLinkHandshaking(this.session, this.webClientId);
}

/// Fully linked and proxying messages.
class DeviceLinkActive extends DeviceLinkState {
  final LinkedDevice device;
  DeviceLinkActive(this.device);
}

/// Event types for linked device communication.
sealed class LinkTunnelMessage {}

/// Web client wants to send a message to a peer.
class LinkTunnelSend extends LinkTunnelMessage {
  final String peerId;
  final String plaintext;
  LinkTunnelSend({required this.peerId, required this.plaintext});
}

/// Mobile app forwarding a received message to web client.
class LinkTunnelReceive extends LinkTunnelMessage {
  final String peerId;
  final String plaintext;
  LinkTunnelReceive({required this.peerId, required this.plaintext});
}

/// Mobile app forwarding peer connection state to web client.
class LinkTunnelPeerState extends LinkTunnelMessage {
  final String peerId;
  final PeerConnectionState state;
  LinkTunnelPeerState({required this.peerId, required this.state});
}

/// Service for linking web clients to this mobile app.
///
/// Web browsers cannot implement certificate pinning, so they're vulnerable
/// to MITM attacks on the signaling connection. By linking to a mobile app,
/// web clients proxy all their communication through the mobile app's
/// secure, certificate-pinned connection.
///
/// Flow:
/// 1. Mobile app creates link session → generates QR code
/// 2. Web client scans QR → extracts link code, mobile's public key, server URL
/// 3. Web client connects to mobile's signaling server with link code
/// 4. WebRTC P2P connection established (encrypted tunnel)
/// 5. All web client messages proxied through mobile app
class DeviceLinkService {
  final CryptoService _cryptoService;
  final WebRTCService _webrtcService;
  final FlutterSecureStorage _secureStorage;

  /// Current service state.
  DeviceLinkState _state = DeviceLinkIdle();

  /// All linked devices (persisted).
  final Map<String, LinkedDevice> _linkedDevices = {};

  /// Stream controller for linked devices list changes.
  final _devicesController = StreamController<List<LinkedDevice>>.broadcast();

  /// Stream controller for incoming messages from web clients.
  final _webMessagesController =
      StreamController<(String deviceId, LinkTunnelMessage message)>.broadcast();

  /// Current link session (if any).
  LinkSession? _currentSession;

  DeviceLinkService({
    required CryptoService cryptoService,
    required WebRTCService webrtcService,
    FlutterSecureStorage? secureStorage,
  })  : _cryptoService = cryptoService,
        _webrtcService = webrtcService,
        _secureStorage = secureStorage ?? const FlutterSecureStorage();

  /// Stream of linked devices list.
  Stream<List<LinkedDevice>> get linkedDevices => _devicesController.stream;

  /// Stream of messages from linked web clients.
  Stream<(String, LinkTunnelMessage)> get webClientMessages =>
      _webMessagesController.stream;

  /// Current list of linked devices.
  List<LinkedDevice> get currentLinkedDevices => _linkedDevices.values.toList();

  /// Current state.
  DeviceLinkState get state => _state;

  /// Current link session QR data (if waiting for scan).
  String? get currentQrData => switch (_state) {
        DeviceLinkWaitingForScan(session: final s) => s.qrData,
        _ => null,
      };

  /// Current link code (if waiting for scan).
  String? get currentLinkCode => switch (_state) {
        DeviceLinkWaitingForScan(session: final s) => s.linkCode,
        _ => null,
      };

  /// Initialize service and load persisted linked devices.
  Future<void> initialize() async {
    await _loadLinkedDevices();
  }

  /// Create a new link session for a web client to connect.
  ///
  /// [signalingServerUrl] - The signaling server URL for the web client to connect to.
  /// Returns the LinkSession containing QR code data.
  Future<LinkSession> createLinkSession(String signalingServerUrl) async {
    // Cancel any existing session
    await cancelLinkSession();

    // Generate temporary key pair for this session
    final keyPair = await _cryptoService.generateEphemeralKeyPair();

    // Generate link code
    final linkCode = _generateLinkCode();

    // Build QR data: zajel-link://{code}:{pubkey}:{server_url}
    final qrData = '${DeviceLinkConstants.qrProtocol}'
        '$linkCode:'
        '${keyPair.publicKey}:'
        '${Uri.encodeComponent(signalingServerUrl)}';

    final session = LinkSession(
      linkCode: linkCode,
      qrData: qrData,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      expiresAt: DateTime.now().add(DeviceLinkConstants.sessionTimeout),
      signalingServerUrl: signalingServerUrl,
    );

    _currentSession = session;
    _state = DeviceLinkWaitingForScan(session);

    logger.info('DeviceLinkService', 'Created link session: $linkCode');

    // Start timeout timer
    _startSessionTimeout(session);

    return session;
  }

  /// Cancel the current link session.
  Future<void> cancelLinkSession() async {
    _currentSession = null;
    _state = DeviceLinkIdle();
  }

  /// Handle an incoming link request from a web client.
  ///
  /// This is called when a web client connects via the signaling server
  /// with a valid link code.
  Future<void> handleLinkRequest({
    required String linkCode,
    required String webPublicKey,
    required String webClientId,
    required String deviceName,
  }) async {
    final session = _currentSession;
    if (session == null || session.linkCode != linkCode) {
      logger.warning('DeviceLinkService', 'Invalid link code: $linkCode');
      throw DeviceLinkException('Invalid or expired link code');
    }

    if (session.isExpired) {
      await cancelLinkSession();
      throw DeviceLinkException('Link session expired');
    }

    _state = DeviceLinkHandshaking(session, webClientId);

    try {
      // Establish encrypted session with web client
      await _cryptoService.establishSession(webClientId, webPublicKey);

      // Create linked device
      final device = LinkedDevice(
        id: webClientId,
        deviceName: deviceName,
        publicKey: webPublicKey,
        linkedAt: DateTime.now(),
        lastSeen: DateTime.now(),
        state: LinkedDeviceState.connected,
      );

      // Store and persist
      _linkedDevices[webClientId] = device;
      await _persistLinkedDevice(device);

      _currentSession = null;
      _state = DeviceLinkActive(device);

      _notifyDevicesChanged();

      logger.info('DeviceLinkService', 'Linked device: $deviceName ($webClientId)');
    } catch (e) {
      _state = DeviceLinkWaitingForScan(session);
      rethrow;
    }
  }

  /// Handle WebRTC connection established with a linked device.
  void handleDeviceConnected(String deviceId) {
    final device = _linkedDevices[deviceId];
    if (device != null) {
      _linkedDevices[deviceId] = device.copyWith(
        state: LinkedDeviceState.connected,
        lastSeen: DateTime.now(),
      );
      _notifyDevicesChanged();
    }
  }

  /// Handle WebRTC connection lost with a linked device.
  void handleDeviceDisconnected(String deviceId) {
    final device = _linkedDevices[deviceId];
    if (device != null) {
      _linkedDevices[deviceId] = device.copyWith(
        state: LinkedDeviceState.disconnected,
        lastSeen: DateTime.now(),
      );
      _notifyDevicesChanged();
    }
  }

  /// Proxy a message from a linked web client to a peer.
  ///
  /// The web client sends encrypted tunnel traffic. We decrypt it,
  /// then re-encrypt for the destination peer using the peer's session key.
  Future<void> proxyMessageToPeer({
    required String fromDeviceId,
    required String toPeerId,
    required String encryptedTunnelData,
  }) async {
    // Verify this is a linked device
    if (!_linkedDevices.containsKey(fromDeviceId)) {
      throw DeviceLinkException('Unknown linked device: $fromDeviceId');
    }

    // Decrypt from web client's tunnel
    final plaintext = await _cryptoService.decrypt(fromDeviceId, encryptedTunnelData);

    // Re-encrypt for destination peer and send
    await _webrtcService.sendMessage(toPeerId, plaintext);

    // Update last seen
    _updateLastSeen(fromDeviceId);
  }

  /// Proxy a message from a peer to a linked web client.
  ///
  /// We receive plaintext from the peer (already decrypted by WebRTCService),
  /// then re-encrypt for the web client's tunnel.
  Future<void> proxyMessageToDevice({
    required String toDeviceId,
    required String fromPeerId,
    required String plaintext,
  }) async {
    final device = _linkedDevices[toDeviceId];
    if (device == null || device.state != LinkedDeviceState.connected) {
      throw DeviceLinkException('Device not connected: $toDeviceId');
    }

    // Encrypt for device tunnel
    final encryptedForDevice = await _cryptoService.encrypt(toDeviceId, plaintext);

    // Build tunnel message
    final tunnelMessage = jsonEncode({
      'type': 'message',
      'from': fromPeerId,
      'data': encryptedForDevice,
    });

    // Send via WebRTC data channel to linked device
    await _webrtcService.sendMessage(toDeviceId, tunnelMessage);
  }

  /// Broadcast a message to all connected linked devices.
  Future<void> broadcastToLinkedDevices({
    required String fromPeerId,
    required String plaintext,
  }) async {
    for (final device in _linkedDevices.values) {
      if (device.state == LinkedDeviceState.connected) {
        try {
          await proxyMessageToDevice(
            toDeviceId: device.id,
            fromPeerId: fromPeerId,
            plaintext: plaintext,
          );
        } catch (e) {
          logger.warning(
            'DeviceLinkService',
            'Failed to broadcast to ${device.id}: $e',
          );
        }
      }
    }
  }

  /// Revoke a linked device.
  Future<void> revokeDevice(String deviceId) async {
    // Close WebRTC connection
    await _webrtcService.closeConnection(deviceId);

    // Remove from storage
    await _secureStorage.delete(
      key: '${DeviceLinkConstants.storagePrefix}$deviceId',
    );

    // Remove from memory
    _linkedDevices.remove(deviceId);
    _notifyDevicesChanged();

    logger.info('DeviceLinkService', 'Revoked device: $deviceId');
  }

  /// Revoke all linked devices.
  Future<void> revokeAllDevices() async {
    for (final deviceId in _linkedDevices.keys.toList()) {
      await revokeDevice(deviceId);
    }
  }

  /// Dispose resources.
  Future<void> dispose() async {
    await cancelLinkSession();
    await _devicesController.close();
    await _webMessagesController.close();
  }

  // Private methods

  /// Generate a random link code using rejection sampling.
  String _generateLinkCode() {
    final secureRandom = Random.secure();
    final buffer = StringBuffer();
    final chars = DeviceLinkConstants.linkCodeChars;
    final maxValid = (256 ~/ chars.length) * chars.length;

    for (var i = 0; i < DeviceLinkConstants.linkCodeLength; i++) {
      int byte;
      do {
        byte = secureRandom.nextInt(256);
      } while (byte >= maxValid);
      buffer.write(chars[byte % chars.length]);
    }

    return buffer.toString();
  }

  /// Start timeout timer for link session.
  void _startSessionTimeout(LinkSession session) {
    Future.delayed(DeviceLinkConstants.sessionTimeout, () {
      if (_currentSession == session) {
        logger.info('DeviceLinkService', 'Link session expired: ${session.linkCode}');
        cancelLinkSession();
      }
    });
  }

  /// Load linked devices from secure storage.
  Future<void> _loadLinkedDevices() async {
    try {
      final allKeys = await _secureStorage.readAll();
      for (final entry in allKeys.entries) {
        if (entry.key.startsWith(DeviceLinkConstants.storagePrefix)) {
          try {
            final json = jsonDecode(entry.value) as Map<String, dynamic>;
            final device = LinkedDevice.fromJson(json).copyWith(
              state: LinkedDeviceState.disconnected, // Always start disconnected
            );
            _linkedDevices[device.id] = device;
          } catch (e) {
            logger.warning(
              'DeviceLinkService',
              'Failed to load device ${entry.key}: $e',
            );
          }
        }
      }
      _notifyDevicesChanged();
    } catch (e) {
      logger.error('DeviceLinkService', 'Failed to load linked devices', e);
    }
  }

  /// Persist a linked device to secure storage.
  Future<void> _persistLinkedDevice(LinkedDevice device) async {
    await _secureStorage.write(
      key: '${DeviceLinkConstants.storagePrefix}${device.id}',
      value: jsonEncode(device.toJson()),
    );
  }

  /// Update last seen timestamp for a device.
  void _updateLastSeen(String deviceId) {
    final device = _linkedDevices[deviceId];
    if (device != null) {
      _linkedDevices[deviceId] = device.copyWith(lastSeen: DateTime.now());
      // Don't notify for every message - batch updates
    }
  }

  /// Notify listeners of device list changes.
  void _notifyDevicesChanged() {
    _devicesController.add(_linkedDevices.values.toList());
  }
}

/// Exception for device link operations.
class DeviceLinkException implements Exception {
  final String message;
  DeviceLinkException(this.message);

  @override
  String toString() => 'DeviceLinkException: $message';
}

/// Parse QR code data into components.
///
/// Format: zajel-link://{code}:{pubkey}:{server_url}
/// Returns null if parsing fails.
({String linkCode, String publicKey, String serverUrl})? parseQrData(String qrData) {
  if (!qrData.startsWith(DeviceLinkConstants.qrProtocol)) {
    return null;
  }

  final data = qrData.substring(DeviceLinkConstants.qrProtocol.length);
  final parts = data.split(':');

  if (parts.length < 3) {
    return null;
  }

  // The server URL might contain colons, so rejoin everything after the pubkey
  final serverUrlEncoded = parts.sublist(2).join(':');

  try {
    return (
      linkCode: parts[0],
      publicKey: parts[1],
      serverUrl: Uri.decodeComponent(serverUrlEncoded),
    );
  } catch (e) {
    return null;
  }
}
