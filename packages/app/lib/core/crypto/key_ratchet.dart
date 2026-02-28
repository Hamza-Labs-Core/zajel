import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import '../logging/logger_service.dart';
import 'crypto_service.dart';

/// Manages in-session key ratcheting for forward secrecy.
///
/// After every [messageThreshold] messages or [timeThreshold] duration,
/// the initiating side generates a random nonce and sends a ratchet
/// control message. Both sides derive a new session key:
///
///   new_key = HKDF(current_key || nonce, "zajel_ratchet")
///
/// The old key is kept briefly (grace period in CryptoService) for
/// messages encrypted before the peer processed the ratchet.
class KeyRatchet {
  final CryptoService _cryptoService;
  final void Function(String peerId, String ratchetMessage) _sendControl;

  final int messageThreshold;
  final Duration timeThreshold;

  final Map<String, int> _messageCounters = {};
  final Map<String, DateTime> _lastRatchetTimes = {};
  final Map<String, int> _epochs = {};
  final _random = Random.secure();

  KeyRatchet({
    required CryptoService cryptoService,
    required void Function(String peerId, String ratchetMessage) sendControl,
    this.messageThreshold = 100,
    this.timeThreshold = const Duration(minutes: 30),
  })  : _cryptoService = cryptoService,
        _sendControl = sendControl;

  /// Track an outgoing message and ratchet if threshold is reached.
  Future<void> onMessageSent(String peerId) async {
    _messageCounters[peerId] = (_messageCounters[peerId] ?? 0) + 1;
    _lastRatchetTimes.putIfAbsent(peerId, () => DateTime.now());

    final count = _messageCounters[peerId]!;
    final elapsed = DateTime.now().difference(_lastRatchetTimes[peerId]!);

    if (count >= messageThreshold || elapsed >= timeThreshold) {
      await _initiateRatchet(peerId);
    }
  }

  /// Process an incoming ratchet control message from a peer.
  Future<void> onRatchetReceived(String peerId, String payload) async {
    try {
      final json = jsonDecode(payload) as Map<String, dynamic>;
      final nonceBase64 = json['nonce'] as String;
      final epoch = json['epoch'] as int;
      final version = json['version'] as int?;

      if (version != null && version != 1) {
        logger.warning('KeyRatchet',
            'Unknown ratchet version $version from $peerId, ignoring');
        return;
      }

      final nonce = base64Decode(nonceBase64);
      if (nonce.length != 32) {
        logger.warning('KeyRatchet',
            'Invalid ratchet nonce length ${nonce.length} from $peerId');
        return;
      }

      await _cryptoService.ratchetSessionKey(peerId, Uint8List.fromList(nonce));
      _epochs[peerId] = epoch;
      _resetCounters(peerId);

      logger.info('KeyRatchet', 'Applied ratchet from $peerId (epoch=$epoch)');
    } catch (e) {
      logger.error('KeyRatchet', 'Failed to process ratchet from $peerId', e);
    }
  }

  /// Initiate a ratchet: generate nonce, ratchet locally, send control.
  Future<void> _initiateRatchet(String peerId) async {
    final epoch = (_epochs[peerId] ?? 0) + 1;
    _epochs[peerId] = epoch;

    // Generate 32-byte random nonce
    final nonce = Uint8List(32);
    for (var i = 0; i < 32; i++) {
      nonce[i] = _random.nextInt(256);
    }

    // Ratchet our own key first
    await _cryptoService.ratchetSessionKey(peerId, nonce);
    _resetCounters(peerId);

    // Send ratchet control message to peer
    final control = jsonEncode({
      'type': 'key_ratchet',
      'nonce': base64Encode(nonce),
      'epoch': epoch,
      'version': 1,
    });
    _sendControl(peerId, 'ratchet:$control');

    logger.info('KeyRatchet', 'Initiated ratchet for $peerId (epoch=$epoch)');
  }

  void _resetCounters(String peerId) {
    _messageCounters[peerId] = 0;
    _lastRatchetTimes[peerId] = DateTime.now();
  }

  /// Remove tracking state for a disconnected peer.
  void removePeer(String peerId) {
    _messageCounters.remove(peerId);
    _lastRatchetTimes.remove(peerId);
    _epochs.remove(peerId);
  }

  /// Get the current ratchet epoch for a peer.
  int getEpoch(String peerId) => _epochs[peerId] ?? 0;
}
