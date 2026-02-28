import 'dart:async';

import 'package:flutter/material.dart';

import '../logging/logger_service.dart';

/// Handles incoming pair request dialogs.
///
/// Uses closure-based DI for testability -- Riverpod stays in main.dart.
class PairRequestHandler {
  final Stream<(String, String, String?)> pairRequests;
  final void Function(String code, {required bool accept}) respondToPairRequest;
  final BuildContext? Function() getContext;

  StreamSubscription<(String, String, String?)>? _subscription;

  PairRequestHandler({
    required this.pairRequests,
    required this.respondToPairRequest,
    required this.getContext,
  });

  /// Start listening for pair requests.
  void listen() {
    _subscription = pairRequests.listen((event) {
      final (fromCode, fromPublicKey, proposedName) = event;
      logger.info(
          'PairRequestHandler', 'Showing pair request dialog for $fromCode');
      _showDialog(fromCode, fromPublicKey, proposedName: proposedName);
    });
  }

  Future<void> _showDialog(String fromCode, String fromPublicKey,
      {String? proposedName}) async {
    final context = getContext();
    if (context == null) {
      logger.warning('PairRequestHandler',
          'No context available to show pair request dialog');
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

    respondToPairRequest(fromCode, accept: accepted == true);

    if (accepted == true) {
      logger.info('PairRequestHandler', 'Pair request from $fromCode accepted');
    } else {
      logger.info('PairRequestHandler', 'Pair request from $fromCode declined');
    }
  }

  /// Cancel the subscription.
  void dispose() {
    _subscription?.cancel();
  }
}
