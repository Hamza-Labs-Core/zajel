import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:uuid/uuid.dart';

import '../models/channel.dart';
import '../models/upstream_message.dart';
import 'channel_crypto_service.dart';

/// Callback type for sending messages over WebSocket.
typedef WebSocketSender = void Function(Map<String, dynamic> message);

/// Callback type for receiving upstream messages (used by the owner).
typedef UpstreamMessageHandler = void Function(UpstreamMessage message);

/// Service for upstream message routing.
///
/// Handles the subscriber -> VPS -> owner upstream path:
/// - Subscriber encrypts message with owner's public key
/// - Sends to VPS via WebSocket
/// - VPS routes to owner only
/// - Neither party sees the other's IP
class UpstreamService {
  final ChannelCryptoService _cryptoService;
  final _uuid = const Uuid();
  final X25519 _x25519 = X25519();
  final Chacha20 _chacha20 = Chacha20.poly1305Aead();
  final Ed25519 _ed25519 = Ed25519();

  /// Pending upstream messages queued when no WebSocket is available.
  final List<Map<String, dynamic>> _pendingMessages = [];

  /// Maximum number of pending messages to queue.
  static const int maxPendingMessages = 100;

  /// Handler for incoming upstream messages (set by the channel owner).
  UpstreamMessageHandler? onUpstreamMessage;

  /// WebSocket sender function (set when connected).
  WebSocketSender? _sender;

  UpstreamService({
    required ChannelCryptoService cryptoService,
  }) : _cryptoService = cryptoService;

  /// Set the WebSocket sender for outgoing messages.
  void setSender(WebSocketSender sender) {
    _sender = sender;
    // Flush any pending messages
    _flushPendingMessages();
  }

  /// Clear the WebSocket sender (e.g., on disconnect).
  void clearSender() {
    _sender = null;
  }

  /// Get the number of pending messages.
  int get pendingMessageCount => _pendingMessages.length;

  // ---------------------------------------------------------------------------
  // Subscriber side: sending upstream messages
  // ---------------------------------------------------------------------------

  /// Send a reply upstream to the channel owner.
  ///
  /// [channel] is the subscribed channel.
  /// [replyTo] is the message ID being replied to.
  /// [content] is the reply text.
  Future<UpstreamMessage> sendReply({
    required Channel channel,
    required String replyTo,
    required String content,
  }) async {
    final payload = UpstreamPayload(
      type: UpstreamMessageType.reply,
      content: content,
      replyTo: replyTo,
      timestamp: DateTime.now(),
    );

    return _sendUpstream(
      channel: channel,
      payload: payload,
      type: UpstreamMessageType.reply,
    );
  }

  /// Send a vote upstream to the channel owner.
  ///
  /// [channel] is the subscribed channel.
  /// [pollId] is the poll being voted on.
  /// [optionIndex] is the index of the selected option.
  Future<UpstreamMessage> sendVote({
    required Channel channel,
    required String pollId,
    required int optionIndex,
  }) async {
    final payload = UpstreamPayload(
      type: UpstreamMessageType.vote,
      content: '',
      pollId: pollId,
      voteOptionIndex: optionIndex,
      timestamp: DateTime.now(),
    );

    return _sendUpstream(
      channel: channel,
      payload: payload,
      type: UpstreamMessageType.vote,
    );
  }

  /// Send a reaction upstream to the channel owner.
  ///
  /// [channel] is the subscribed channel.
  /// [replyTo] is the message ID being reacted to.
  /// [reaction] is the emoji/reaction identifier.
  Future<UpstreamMessage> sendReaction({
    required Channel channel,
    required String replyTo,
    required String reaction,
  }) async {
    final payload = UpstreamPayload(
      type: UpstreamMessageType.reaction,
      content: reaction,
      replyTo: replyTo,
      timestamp: DateTime.now(),
    );

    return _sendUpstream(
      channel: channel,
      payload: payload,
      type: UpstreamMessageType.reaction,
    );
  }

  /// Core upstream send method.
  ///
  /// Encrypts the payload with the owner's public key using X25519 key
  /// exchange + ChaCha20-Poly1305 AEAD, signs with an ephemeral key,
  /// and sends via WebSocket.
  Future<UpstreamMessage> _sendUpstream({
    required Channel channel,
    required UpstreamPayload payload,
    required UpstreamMessageType type,
  }) async {
    // Validate payload size against channel rules
    final payloadBytes = payload.toBytes();
    if (payloadBytes.length > channel.manifest.rules.maxUpstreamSize) {
      throw UpstreamServiceException(
        'Upstream message too large: ${payloadBytes.length} bytes '
        '(max: ${channel.manifest.rules.maxUpstreamSize})',
      );
    }

    // Check channel rules
    if (type == UpstreamMessageType.reply &&
        !channel.manifest.rules.repliesEnabled) {
      throw UpstreamServiceException('Replies are disabled for this channel');
    }
    if (type == UpstreamMessageType.vote &&
        !channel.manifest.rules.pollsEnabled) {
      throw UpstreamServiceException('Polls are disabled for this channel');
    }

    // Generate an ephemeral X25519 keypair for this message
    final ephemeralKeyPair = await _x25519.newKeyPair();
    final ephemeralPublicKey = await ephemeralKeyPair.extractPublicKey();

    // Derive a shared secret with the owner's encryption public key
    final ownerPublicKeyBytes = base64Decode(channel.manifest.currentEncryptKey);
    final ownerPublicKey = SimplePublicKey(
      ownerPublicKeyBytes,
      type: KeyPairType.x25519,
    );

    final sharedSecret = await _x25519.sharedSecretKey(
      keyPair: ephemeralKeyPair,
      remotePublicKey: ownerPublicKey,
    );

    // Derive an encryption key from the shared secret
    final hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
    final contentKey = await hkdf.deriveKey(
      secretKey: sharedSecret,
      info: utf8.encode('zajel_upstream_message'),
      nonce: const [],
    );

    // Encrypt the payload
    final nonce = _chacha20.newNonce();
    final secretBox = await _chacha20.encrypt(
      payloadBytes,
      secretKey: contentKey,
      nonce: nonce,
    );

    // Combine: nonce (12) + ciphertext + mac (16)
    final encryptedBytes = Uint8List(
      nonce.length + secretBox.cipherText.length + secretBox.mac.bytes.length,
    );
    encryptedBytes.setAll(0, nonce);
    encryptedBytes.setAll(nonce.length, secretBox.cipherText);
    encryptedBytes.setAll(
      nonce.length + secretBox.cipherText.length,
      secretBox.mac.bytes,
    );

    // Generate an ephemeral Ed25519 key for signing
    final signingKeyPair = await _ed25519.newKeyPair();
    final signingPublicKey = await signingKeyPair.extractPublicKey();
    final ed25519Signature = await _ed25519.sign(
      encryptedBytes,
      keyPair: signingKeyPair,
    );

    final messageId = 'up_${_uuid.v4().substring(0, 8)}';

    final message = UpstreamMessage(
      id: messageId,
      channelId: channel.id,
      type: type,
      encryptedPayload: encryptedBytes,
      signature: base64Encode(ed25519Signature.bytes),
      senderEphemeralKey: base64Encode(signingPublicKey.bytes),
      timestamp: DateTime.now(),
    );

    // Build the WebSocket message including the ephemeral X25519 public key
    // so the owner can derive the same shared secret for decryption.
    final wsMessage = <String, dynamic>{
      'type': 'upstream-message',
      'channelId': channel.id,
      'message': message.toJson(),
      'ephemeralPublicKey': base64Encode(ephemeralPublicKey.bytes),
    };

    _sendOrQueue(wsMessage);

    return message;
  }

  // ---------------------------------------------------------------------------
  // Owner side: receiving and decrypting upstream messages
  // ---------------------------------------------------------------------------

  /// Handle an incoming upstream message from the VPS.
  ///
  /// Called when the WebSocket receives an upstream-message type.
  void handleIncomingMessage(Map<String, dynamic> data) {
    try {
      final messageJson = data['message'] as Map<String, dynamic>;
      final message = UpstreamMessage.fromJson(messageJson);
      onUpstreamMessage?.call(message);
    } catch (e) {
      // Silently drop malformed upstream messages
    }
  }

  /// Decrypt an upstream message as the channel owner.
  ///
  /// [message] is the received upstream message.
  /// [encryptionPrivateKeyBase64] is the owner's X25519 private key.
  /// [ephemeralPublicKeyBase64] is the sender's ephemeral X25519 public key
  /// (included in the WebSocket message envelope).
  Future<UpstreamPayload> decryptUpstreamMessage({
    required UpstreamMessage message,
    required String encryptionPrivateKeyBase64,
    required String ephemeralPublicKeyBase64,
  }) async {
    // Verify the signature first
    final signatureValid = await _verifyUpstreamSignature(message);
    if (!signatureValid) {
      throw UpstreamServiceException('Upstream message signature is invalid');
    }

    // Reconstruct the shared secret
    final ownerPrivateKeyBytes = base64Decode(encryptionPrivateKeyBase64);
    final ownerKeyPair = await _x25519.newKeyPairFromSeed(ownerPrivateKeyBytes);

    final ephemeralPublicKeyBytes = base64Decode(ephemeralPublicKeyBase64);
    final ephemeralPublicKey = SimplePublicKey(
      ephemeralPublicKeyBytes,
      type: KeyPairType.x25519,
    );

    final sharedSecret = await _x25519.sharedSecretKey(
      keyPair: ownerKeyPair,
      remotePublicKey: ephemeralPublicKey,
    );

    // Derive the same encryption key
    final hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: 32);
    final contentKey = await hkdf.deriveKey(
      secretKey: sharedSecret,
      info: utf8.encode('zajel_upstream_message'),
      nonce: const [],
    );

    // Decrypt
    final encrypted = message.encryptedPayload;
    const nonceLength = 12;
    const macLength = 16;

    if (encrypted.length < nonceLength + macLength) {
      throw UpstreamServiceException('Encrypted upstream payload too short');
    }

    final nonce = encrypted.sublist(0, nonceLength);
    final cipherText =
        encrypted.sublist(nonceLength, encrypted.length - macLength);
    final mac = Mac(encrypted.sublist(encrypted.length - macLength));

    final secretBox = SecretBox(cipherText, nonce: nonce, mac: mac);

    try {
      final plaintextBytes =
          await _chacha20.decrypt(secretBox, secretKey: contentKey);
      return UpstreamPayload.fromBytes(Uint8List.fromList(plaintextBytes));
    } on SecretBoxAuthenticationError {
      throw UpstreamServiceException(
        'MAC verification failed: upstream message has been tampered with or wrong key',
      );
    } catch (e) {
      throw UpstreamServiceException(
        'Failed to decrypt upstream message: $e',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Reply threading
  // ---------------------------------------------------------------------------

  /// Group a list of decrypted upstream payloads into reply threads.
  ///
  /// Returns a map of parent message ID -> [ReplyThread].
  /// Only includes payloads of type [UpstreamMessageType.reply].
  Map<String, ReplyThread> groupRepliesIntoThreads(
    List<UpstreamPayload> payloads,
  ) {
    final threads = <String, ReplyThread>{};

    for (final payload in payloads) {
      if (payload.type != UpstreamMessageType.reply) continue;
      if (payload.replyTo == null) continue;

      final parentId = payload.replyTo!;
      final existing = threads[parentId] ??
          ReplyThread(parentMessageId: parentId);
      threads[parentId] = existing.addReply(payload);
    }

    return threads;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /// Verify the Ed25519 signature on an upstream message.
  Future<bool> _verifyUpstreamSignature(UpstreamMessage message) async {
    try {
      final signatureBytes = base64Decode(message.signature);
      final publicKeyBytes = base64Decode(message.senderEphemeralKey);

      final publicKey =
          SimplePublicKey(publicKeyBytes, type: KeyPairType.ed25519);
      final signature = Signature(signatureBytes, publicKey: publicKey);

      return await _ed25519.verify(
        message.encryptedPayload,
        signature: signature,
      );
    } catch (_) {
      return false;
    }
  }

  void _sendOrQueue(Map<String, dynamic> wsMessage) {
    if (_sender != null) {
      _sender!(wsMessage);
    } else {
      // Queue the message for later delivery
      if (_pendingMessages.length < maxPendingMessages) {
        _pendingMessages.add(wsMessage);
      }
      // Drop if queue is full (DoS protection)
    }
  }

  void _flushPendingMessages() {
    if (_sender == null) return;
    final toSend = List<Map<String, dynamic>>.from(_pendingMessages);
    _pendingMessages.clear();
    for (final msg in toSend) {
      _sender!(msg);
    }
  }

  /// Clear all pending messages.
  void clearPendingMessages() {
    _pendingMessages.clear();
  }
}

/// Exception thrown by upstream service operations.
class UpstreamServiceException implements Exception {
  final String message;
  UpstreamServiceException(this.message);

  @override
  String toString() => 'UpstreamServiceException: $message';
}
