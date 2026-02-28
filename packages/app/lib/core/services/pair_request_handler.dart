import 'dart:async';

import 'package:flutter/material.dart';

import '../logging/logger_service.dart';
import '../network/connection_manager.dart';

/// Handles incoming pair and link request dialogs.
///
/// Subscribes to [ConnectionManager.pairRequests] and
/// [ConnectionManager.linkRequests], shows approval dialogs, and
/// calls back to respond.
class PairRequestHandler {
  final ConnectionManager _connectionManager;
  final GlobalKey<NavigatorState> _navigatorKey;

  StreamSubscription<(String, String, String?)>? _pairRequestSubscription;
  StreamSubscription<(String, String, String)>? _linkRequestSubscription;

  PairRequestHandler({
    required ConnectionManager connectionManager,
    required GlobalKey<NavigatorState> navigatorKey,
  })  : _connectionManager = connectionManager,
        _navigatorKey = navigatorKey;

  void start() {
    _pairRequestSubscription = _connectionManager.pairRequests.listen((event) {
      final (fromCode, fromPublicKey, proposedName) = event;
      logger.info(
          'PairRequestHandler', 'Showing pair request dialog for $fromCode');
      _showPairRequestDialog(fromCode, fromPublicKey,
          proposedName: proposedName);
    });

    _linkRequestSubscription = _connectionManager.linkRequests.listen((event) {
      final (linkCode, publicKey, deviceName) = event;
      logger.info('PairRequestHandler',
          'Showing link request dialog for $linkCode from $deviceName');
      _showLinkRequestDialog(linkCode, publicKey, deviceName);
    });
  }

  Future<void> _showPairRequestDialog(String fromCode, String fromPublicKey,
      {String? proposedName}) async {
    final context = _navigatorKey.currentContext;
    if (context == null) {
      logger.warning(
          'PairRequestHandler', 'No context for pair request dialog');
      return;
    }

    final accepted = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.person_add, color: Colors.blue),
            SizedBox(width: 8),
            Text('Connection Request'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (proposedName != null)
              Text('$proposedName (code: $fromCode) wants to connect.')
            else
              Text('Device with code $fromCode wants to connect.'),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.grey.shade100,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Device Code',
                    style: TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  Text(
                    fromCode,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 2,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.orange.shade50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.orange.shade200),
              ),
              child: const Row(
                children: [
                  Icon(Icons.warning_amber, color: Colors.orange, size: 20),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Only accept if you know this device.',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Decline'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Accept'),
          ),
        ],
      ),
    );

    _connectionManager.respondToPairRequest(fromCode, accept: accepted == true);

    if (accepted == true) {
      logger.info('PairRequestHandler', 'Pair request from $fromCode accepted');
    } else {
      logger.info('PairRequestHandler', 'Pair request from $fromCode declined');
    }
  }

  Future<void> _showLinkRequestDialog(
    String linkCode,
    String publicKey,
    String deviceName,
  ) async {
    final context = _navigatorKey.currentContext;
    if (context == null) {
      logger.warning(
          'PairRequestHandler', 'No context for link request dialog');
      return;
    }

    // Generate fingerprint for verification (first 32 chars, grouped by 4)
    final truncated =
        publicKey.length > 32 ? publicKey.substring(0, 32) : publicKey;
    final fingerprint = truncated
        .replaceAllMapped(
          RegExp(r'.{4}'),
          (match) => '${match.group(0)} ',
        )
        .trim();

    final approved = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: const Row(
          children: [
            Icon(Icons.computer, color: Colors.blue),
            SizedBox(width: 8),
            Text('Link Request'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('$deviceName wants to link with this device.'),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.grey.shade100,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Link Code',
                    style: TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  Text(
                    linkCode,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 2,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    'Key Fingerprint',
                    style: TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                  Text(
                    fingerprint,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 10,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.orange.shade50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.orange.shade200),
              ),
              child: const Row(
                children: [
                  Icon(Icons.warning_amber, color: Colors.orange, size: 20),
                  SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Only approve if you initiated this link request.',
                      style: TextStyle(fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Reject'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Approve'),
          ),
        ],
      ),
    );

    _connectionManager.respondToLinkRequest(
      linkCode,
      accept: approved == true,
      deviceId: approved == true ? 'link_$linkCode' : null,
    );

    if (approved == true) {
      logger.info(
          'PairRequestHandler', 'Link request from $deviceName approved');
    } else {
      logger.info(
          'PairRequestHandler', 'Link request from $deviceName rejected');
    }
  }

  void dispose() {
    _pairRequestSubscription?.cancel();
    _linkRequestSubscription?.cancel();
  }
}
