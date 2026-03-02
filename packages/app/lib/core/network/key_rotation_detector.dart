import 'dart:async';

import 'package:uuid/uuid.dart';

import '../crypto/crypto_service.dart';
import '../logging/logger_service.dart';
import '../models/models.dart';
import '../storage/message_storage.dart';
import '../storage/trusted_peers_storage.dart';

/// Detects key rotation using the TOFU (Trust On First Use) model.
///
/// When a known stableId presents a new publicKey:
/// 1. Records the rotation in TrustedPeersStorage
/// 2. Updates the CryptoService with the new key
/// 3. Emits a key change event for the UI
/// 4. Inserts a system message into chat history
class KeyRotationDetector {
  final TrustedPeersStorage _trustedPeersStorage;
  final CryptoService _cryptoService;
  final MessageStorage? _messageStorage;

  final _keyChangeController = StreamController<
      (String peerId, String oldKey, String newKey)>.broadcast();

  /// Stream of key rotation events (peerId, oldKey, newKey).
  Stream<(String, String, String)> get keyChanges =>
      _keyChangeController.stream;

  KeyRotationDetector({
    required TrustedPeersStorage trustedPeersStorage,
    required CryptoService cryptoService,
    MessageStorage? messageStorage,
  })  : _trustedPeersStorage = trustedPeersStorage,
        _cryptoService = cryptoService,
        _messageStorage = messageStorage;

  /// Check if a peer's public key has rotated and handle accordingly.
  ///
  /// TOFU: first key associated with a stableId is trusted.
  /// Subsequent key changes are auto-accepted, logged, and produce a UI warning
  /// via the keyChanges stream and a system message in the chat.
  Future<void> checkKeyRotation(String stableId, String newPublicKey) async {
    try {
      final existingPeer = await _trustedPeersStorage.getPeer(stableId);
      if (existingPeer != null && existingPeer.publicKey != newPublicKey) {
        logger.warning(
            'KeyRotationDetector',
            'Key rotation detected for $stableId '
                '(old: ${existingPeer.publicKey.substring(0, 8)}..., '
                'new: ${newPublicKey.substring(0, 8)}...)');

        final oldKey = existingPeer.publicKey;

        // Record key rotation in storage (sets keyChangeAcknowledged = false)
        await _trustedPeersStorage.recordKeyRotation(
            stableId, oldKey, newPublicKey);
        _cryptoService.setPeerPublicKey(stableId, newPublicKey);

        // Emit key change event for UI
        _keyChangeController.add((stableId, oldKey, newPublicKey));

        // Insert system message in chat history
        if (_messageStorage != null) {
          final msg = Message(
            localId: const Uuid().v4(),
            peerId: stableId,
            content: 'Safety number changed. Tap to verify.',
            type: MessageType.system,
            timestamp: DateTime.now(),
            isOutgoing: false,
            status: MessageStatus.delivered,
          );
          await _messageStorage.saveMessage(msg);
        }

        logger.info(
            'KeyRotationDetector', 'Key rotation persisted for $stableId');
      }
    } catch (e) {
      logger.error('KeyRotationDetector',
          'Failed to process key rotation for $stableId: $e');
    }
  }

  void dispose() {
    _keyChangeController.close();
  }
}
