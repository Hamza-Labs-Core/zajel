import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/crypto/crypto_service.dart';
import '../../../core/models/peer.dart';
import '../../../core/providers/app_providers.dart';
import '../../../core/utils/identity_utils.dart';

/// Full-screen view for comparing safety numbers with a peer.
///
/// Displays a 60-digit safety number derived from both peers' public keys.
/// Both peers independently compute the same number — if the numbers match
/// when compared out-of-band (phone call, in person), the connection is
/// verified as free from MITM attacks.
class SafetyNumberScreen extends ConsumerStatefulWidget {
  final String peerId;

  const SafetyNumberScreen({super.key, required this.peerId});

  @override
  ConsumerState<SafetyNumberScreen> createState() => _SafetyNumberScreenState();
}

class _SafetyNumberScreenState extends ConsumerState<SafetyNumberScreen> {
  String? _safetyNumber;
  String? _myFingerprint;
  String? _peerFingerprint;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _computeSafetyNumber();
  }

  Future<void> _computeSafetyNumber() async {
    final cryptoService = ref.read(cryptoServiceProvider);
    final myKeyBase64 = await cryptoService.getPublicKeyBase64();
    final peerKeyBase64 = cryptoService.getPeerPublicKey(widget.peerId);

    if (peerKeyBase64 != null) {
      final number =
          CryptoService.computeSafetyNumber(myKeyBase64, peerKeyBase64);
      final myFp = await cryptoService.getPublicKeyFingerprint();
      final peerFp = cryptoService.getPeerPublicKeyFingerprint(peerKeyBase64);
      if (mounted) {
        setState(() {
          _safetyNumber = number;
          _myFingerprint = myFp;
          _peerFingerprint = peerFp;
          _loading = false;
        });
      }
    } else {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  void _copyToClipboard() {
    if (_safetyNumber == null) return;
    Clipboard.setData(ClipboardData(text: _safetyNumber!));
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Safety number copied to clipboard'),
        duration: Duration(seconds: 3),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final peer = switch (ref.watch(peersProvider)) {
      AsyncData(:final value) => value.firstWhere(
          (p) => p.id == widget.peerId,
          orElse: () => Peer(
              id: widget.peerId, displayName: 'Peer', lastSeen: DateTime.now()),
        ),
      _ => null,
    };
    final aliases = ref.watch(peerAliasesProvider);
    final peerName = peer != null
        ? resolvePeerDisplayName(peer, alias: aliases[peer.id])
        : 'Peer';

    return Scaffold(
      appBar: AppBar(
        title: const Text('Safety Number'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _safetyNumber == null
              ? _buildUnavailable()
              : _buildContent(context, peerName),
    );
  }

  Widget _buildUnavailable() {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(32),
        child: Text(
          'Safety number not available. The peer may need to reconnect.',
          textAlign: TextAlign.center,
        ),
      ),
    );
  }

  Widget _buildContent(BuildContext context, String peerName) {
    final formatted =
        CryptoService.formatSafetyNumberForDisplay(_safetyNumber!);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        children: [
          Icon(
            Icons.verified_user_outlined,
            size: 48,
            color: Theme.of(context).colorScheme.primary,
          ),
          const SizedBox(height: 16),
          Text(
            'Verify Safety Number',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 8),
          Text(
            'Compare this number with $peerName through a trusted channel '
            '(phone call, video chat, or in person).',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 32),
          // Safety number grid
          Container(
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Text(
              formatted,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontSize: 22,
                letterSpacing: 2,
                height: 1.8,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              OutlinedButton.icon(
                onPressed: _copyToClipboard,
                icon: const Icon(Icons.copy, size: 18),
                label: const Text('Copy'),
              ),
            ],
          ),
          const SizedBox(height: 32),
          // Individual fingerprints
          if (_myFingerprint != null) ...[
            _FingerprintRow(
              label: 'Your fingerprint',
              fingerprint: _myFingerprint!,
            ),
            const SizedBox(height: 12),
          ],
          if (_peerFingerprint != null)
            _FingerprintRow(
              label: '$peerName\'s fingerprint',
              fingerprint: _peerFingerprint!,
            ),
          const SizedBox(height: 24),
          Card(
            color: Theme.of(context).colorScheme.secondaryContainer,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Icon(Icons.info_outline,
                      color:
                          Theme.of(context).colorScheme.onSecondaryContainer),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'If the safety number matches what $peerName sees, '
                      'your connection is secure from interception.',
                      style: TextStyle(
                        fontSize: 13,
                        color:
                            Theme.of(context).colorScheme.onSecondaryContainer,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _FingerprintRow extends StatelessWidget {
  final String label;
  final String fingerprint;

  const _FingerprintRow({required this.label, required this.fingerprint});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 4),
        Text(
          fingerprint,
          style: const TextStyle(
            fontFamily: 'monospace',
            fontSize: 11,
            letterSpacing: 0.5,
          ),
        ),
      ],
    );
  }
}
