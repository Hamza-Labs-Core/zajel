import 'dart:async';

import 'package:flutter/material.dart';

import '../logging/logger_service.dart';

/// Handles incoming web client link request dialogs.
///
/// Uses closure-based DI for testability -- Riverpod stays in main.dart.
class LinkRequestHandler {
  final Stream<(String, String, String)> linkRequests;
  final void Function(String linkCode, {required bool accept, String? deviceId})
      respondToLinkRequest;
  final BuildContext? Function() getContext;

  StreamSubscription<(String, String, String)>? _subscription;

  LinkRequestHandler({
    required this.linkRequests,
    required this.respondToLinkRequest,
    required this.getContext,
  });

  /// Start listening for link requests.
  void listen() {
    _subscription = linkRequests.listen((event) {
      final (linkCode, publicKey, deviceName) = event;
      logger.info('LinkRequestHandler',
          'Showing link request dialog for $linkCode from $deviceName');
      _showDialog(linkCode, publicKey, deviceName);
    });
  }

  Future<void> _showDialog(
    String linkCode,
    String publicKey,
    String deviceName,
  ) async {
    final context = getContext();
    if (context == null) {
      logger.warning('LinkRequestHandler',
          'No context available to show link request dialog');
      return;
    }

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

    respondToLinkRequest(
      linkCode,
      accept: approved == true,
      deviceId: approved == true ? 'link_$linkCode' : null,
    );

    if (approved == true) {
      logger.info(
          'LinkRequestHandler', 'Link request from $deviceName approved');
    } else {
      logger.info(
          'LinkRequestHandler', 'Link request from $deviceName rejected');
    }
  }

  /// Cancel the subscription.
  void dispose() {
    _subscription?.cancel();
  }
}
