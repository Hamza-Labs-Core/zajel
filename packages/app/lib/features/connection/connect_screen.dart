import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../../core/logging/logger_service.dart';
import '../../core/models/linked_device.dart';
import '../../core/providers/app_providers.dart';

/// Screen for connecting to external peers via QR code or pairing code.
class ConnectScreen extends ConsumerStatefulWidget {
  const ConnectScreen({super.key});

  @override
  ConsumerState<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends ConsumerState<ConnectScreen>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  final _codeController = TextEditingController();
  final _scannerController = MobileScannerController();
  bool _isConnecting = false;
  String? _error;

  LinkSession? _linkSession;
  StreamSubscription<(String, String, String)>? _linkRequestsSubscription;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    // Defer provider modifications to avoid "modify provider during build" error.
    // initState runs during the widget tree build phase; Riverpod forbids
    // provider writes at that point.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _connectToServer();
      _listenForLinkRequests();
    });
  }

  /// Listen for incoming link requests from web clients and show approval dialog.
  void _listenForLinkRequests() {
    final connectionManager = ref.read(connectionManagerProvider);
    _linkRequestsSubscription =
        connectionManager.linkRequests.listen((request) {
      final (linkCode, publicKey, deviceName) = request;
      _showLinkApprovalDialog(linkCode, publicKey, deviceName);
    });
  }

  /// Show dialog to approve or reject a web client link request.
  Future<void> _showLinkApprovalDialog(
    String linkCode,
    String publicKey,
    String deviceName,
  ) async {
    if (!mounted) return;

    // Generate fingerprint for verification
    final fingerprint = _generateFingerprint(publicKey);

    final approved = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: Row(
          children: [
            Icon(Icons.computer, color: Theme.of(context).colorScheme.primary),
            const SizedBox(width: 8),
            const Text('Link Request'),
          ],
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '$deviceName wants to link with this device.',
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Link Code',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                  Text(
                    linkCode,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          fontFamily: 'monospace',
                          letterSpacing: 2,
                        ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Key Fingerprint',
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                  Text(
                    fingerprint,
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
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
              child: Row(
                children: [
                  Icon(Icons.warning_amber,
                      color: Colors.orange.shade800, size: 20),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'Only approve if you initiated this link request.',
                      style: TextStyle(
                        fontSize: 12,
                        color: Colors.orange.shade900,
                      ),
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
            child: const Text('Reject'),
          ),
          ElevatedButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Approve'),
          ),
        ],
      ),
    );

    if (!mounted) return;

    final connectionManager = ref.read(connectionManagerProvider);
    connectionManager.respondToLinkRequest(
      linkCode,
      accept: approved == true,
      deviceId: approved == true ? 'link_$linkCode' : null,
    );

    if (approved == true) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Linked with $deviceName')),
      );
      // Cancel the link session since it's now used
      setState(() => _linkSession = null);
    }
  }

  /// Generate a fingerprint from a public key for display.
  String _generateFingerprint(String publicKey) {
    // Simple fingerprint: first 16 characters of the public key
    // In production, this would use SHA-256 hash
    final truncated =
        publicKey.length > 32 ? publicKey.substring(0, 32) : publicKey;
    return truncated
        .replaceAllMapped(
          RegExp(r'.{4}'),
          (match) => '${match.group(0)} ',
        )
        .trim();
  }

  Future<void> _connectToServer() async {
    // If already connected to signaling (e.g. from main.dart auto-connect),
    // skip reconnection to avoid replacing the existing SignalingClient and
    // generating a new pairing code.
    final connectionManager = ref.read(connectionManagerProvider);
    if (connectionManager.externalPairingCode != null) {
      return;
    }

    // Update UI state to show "Connecting..."
    ref.read(signalingDisplayStateProvider.notifier).state =
        SignalingDisplayState.connecting;

    try {
      // First, discover and select a VPS server
      final discoveryService = ref.read(serverDiscoveryServiceProvider);
      final selectedServer = await discoveryService.selectServer();

      if (selectedServer == null) {
        setState(
            () => _error = 'No servers available. Please try again later.');
        ref.read(signalingDisplayStateProvider.notifier).state =
            SignalingDisplayState.disconnected;
        return;
      }

      // Store the selected server
      ref.read(selectedServerProvider.notifier).state = selectedServer;

      // Get the WebSocket URL for the selected server
      final serverUrl = discoveryService.getWebSocketUrl(selectedServer);

      // Now connect to the VPS server
      final connectionManager = ref.read(connectionManagerProvider);
      final code = await connectionManager.connect(
        serverUrl: serverUrl,
      );

      ref.read(pairingCodeProvider.notifier).state = code;
      ref.read(signalingClientProvider.notifier).state =
          connectionManager.signalingClient;
      ref.read(signalingConnectedProvider.notifier).state = true;
      ref.read(signalingDisplayStateProvider.notifier).state =
          SignalingDisplayState.connected;

      // Re-register meeting points for trusted peer reconnection
      await connectionManager.reconnectTrustedPeers();
    } catch (e) {
      setState(() => _error = 'Failed to connect to server: $e');
      ref.read(signalingDisplayStateProvider.notifier).state =
          SignalingDisplayState.disconnected;
    }
  }

  @override
  void dispose() {
    _linkRequestsSubscription?.cancel();
    _tabController.dispose();
    _codeController.dispose();
    _scannerController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Connect'),
        bottom: TabBar(
          controller: _tabController,
          tabs: const [
            Tab(text: 'My Code', icon: Icon(Icons.qr_code)),
            Tab(text: 'Scan', icon: Icon(Icons.qr_code_scanner)),
            Tab(text: 'Link Web', icon: Icon(Icons.computer)),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildMyCodeTab(),
          _buildScanTab(),
          _buildLinkWebTab(),
        ],
      ),
    );
  }

  Widget _buildMyCodeTab() {
    final pairingCode = ref.watch(pairingCodeProvider);
    final displayName = ref.watch(displayNameProvider);

    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                Icons.error_outline,
                size: 64,
                color: Theme.of(context).colorScheme.error,
              ),
              const SizedBox(height: 16),
              Text(
                _error!,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: _connectToServer,
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }

    if (pairingCode == null) {
      return const Center(child: CircularProgressIndicator());
    }

    final qrData = 'zajel://$pairingCode';

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        children: [
          // Manual code entry at TOP for easy access
          Text(
            'Enter a pairing code',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _codeController,
                  decoration: const InputDecoration(
                    hintText: 'Enter 6-character code',
                    border: OutlineInputBorder(),
                  ),
                  textCapitalization: TextCapitalization.characters,
                  textInputAction: TextInputAction.go,
                  onSubmitted: (_) => _isConnecting ? null : _connectWithCode(),
                  inputFormatters: [
                    // Allow both cases - uppercase conversion happens on submit
                    FilteringTextInputFormatter.allow(RegExp(r'[A-Za-z0-9]')),
                    LengthLimitingTextInputFormatter(6),
                    // Convert to uppercase as user types
                    _UpperCaseTextFormatter(),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              ElevatedButton(
                onPressed: _isConnecting ? null : _connectWithCode,
                style: ElevatedButton.styleFrom(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                ),
                child: _isConnecting
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Connect'),
              ),
            ],
          ),
          const SizedBox(height: 24),
          const Divider(),
          const SizedBox(height: 24),
          // Your code section below
          Text(
            'Your code',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 8),
          Text(
            'Share this with others to let them connect to you',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: 24,
              vertical: 16,
            ),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  pairingCode,
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                        letterSpacing: 4,
                        fontWeight: FontWeight.bold,
                      ),
                ),
                const SizedBox(width: 16),
                IconButton(
                  icon: const Icon(Icons.copy),
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: pairingCode));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Code copied to clipboard')),
                    );
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Visible as: $displayName',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 24),
          // QR code at bottom (optional, less important)
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withOpacity(0.1),
                  blurRadius: 10,
                ),
              ],
            ),
            child: QrImageView(
              data: qrData,
              version: QrVersions.auto,
              size: 180,
              backgroundColor: Colors.white,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildScanTab() {
    return Column(
      children: [
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: MobileScanner(
              controller: _scannerController,
              onDetect: _handleBarcode,
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              Text(
                'Scan a QR code to connect',
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              const SizedBox(height: 8),
              Text(
                'Point your camera at a Zajel QR code',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildLinkWebTab() {
    final linkedDevicesAsync = ref.watch(linkedDevicesProvider);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        children: [
          // Header explanation
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Theme.of(context)
                  .colorScheme
                  .primaryContainer
                  .withOpacity(0.3),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              children: [
                Icon(
                  Icons.security,
                  color: Theme.of(context).colorScheme.primary,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    'Web browsers cannot verify server certificates. Link your web browser to this device for secure messaging.',
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),

          // QR Code for linking
          if (_linkSession != null) ...[
            Text(
              'Scan this code with your web browser',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.1),
                    blurRadius: 10,
                  ),
                ],
              ),
              child: QrImageView(
                data: _linkSession!.qrData,
                version: QrVersions.auto,
                size: 200,
                backgroundColor: Colors.white,
              ),
            ),
            const SizedBox(height: 16),
            // Link code for manual entry
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    _linkSession!.linkCode,
                    style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                          letterSpacing: 4,
                          fontWeight: FontWeight.bold,
                        ),
                  ),
                  const SizedBox(width: 16),
                  IconButton(
                    icon: const Icon(Icons.copy),
                    onPressed: () {
                      Clipboard.setData(
                          ClipboardData(text: _linkSession!.linkCode));
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('Link code copied')),
                      );
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Expires in 5 minutes',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              onPressed: _cancelLinkSession,
              icon: const Icon(Icons.close),
              label: const Text('Cancel'),
            ),
          ] else ...[
            ElevatedButton.icon(
              onPressed: _createLinkSession,
              icon: const Icon(Icons.qr_code),
              label: const Text('Generate Link Code'),
            ),
          ],

          const SizedBox(height: 32),
          const Divider(),
          const SizedBox(height: 16),

          // Linked devices list
          Row(
            children: [
              Text(
                'Linked Devices',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const Spacer(),
              linkedDevicesAsync.when(
                data: (devices) => Text(
                  '${devices.length} device${devices.length != 1 ? 's' : ''}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                loading: () => const SizedBox.shrink(),
                error: (_, __) => const SizedBox.shrink(),
              ),
            ],
          ),
          const SizedBox(height: 16),

          linkedDevicesAsync.when(
            data: (devices) {
              if (devices.isEmpty) {
                return Container(
                  padding: const EdgeInsets.all(24),
                  decoration: BoxDecoration(
                    color:
                        Theme.of(context).colorScheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Column(
                    children: [
                      Icon(
                        Icons.devices,
                        size: 48,
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'No linked devices',
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant,
                            ),
                      ),
                    ],
                  ),
                );
              }

              return Column(
                children: devices
                    .map((device) => _buildLinkedDeviceCard(device))
                    .toList(),
              );
            },
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Text('Error: $e'),
          ),
        ],
      ),
    );
  }

  Widget _buildLinkedDeviceCard(LinkedDevice device) {
    final isConnected = device.state == LinkedDeviceState.connected;

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: Stack(
          children: [
            CircleAvatar(
              backgroundColor: isConnected
                  ? Colors.green.shade100
                  : Theme.of(context).colorScheme.surfaceContainerHighest,
              child: Icon(
                Icons.computer,
                color: isConnected
                    ? Colors.green
                    : Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
            Positioned(
              right: 0,
              bottom: 0,
              child: Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  color: isConnected ? Colors.green : Colors.grey,
                  shape: BoxShape.circle,
                  border: Border.all(color: Colors.white, width: 2),
                ),
              ),
            ),
          ],
        ),
        title: Text(device.deviceName),
        subtitle: Text(
          isConnected ? 'Connected' : 'Offline',
          style: TextStyle(color: isConnected ? Colors.green : null),
        ),
        trailing: PopupMenuButton<String>(
          onSelected: (value) async {
            if (value == 'revoke') {
              await _revokeDevice(device);
            }
          },
          itemBuilder: (context) => [
            const PopupMenuItem(
              value: 'revoke',
              child: Row(
                children: [
                  Icon(Icons.link_off, color: Colors.red),
                  SizedBox(width: 8),
                  Text('Revoke'),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _createLinkSession() async {
    final serverUrl = ref.read(signalingServerUrlProvider);
    if (serverUrl == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text('No server selected. Please wait or retry.')),
      );
      return;
    }

    try {
      final deviceLinkService = ref.read(deviceLinkServiceProvider);
      final session = await deviceLinkService.createLinkSession(serverUrl);
      setState(() => _linkSession = session);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to create link session: $e')),
        );
      }
    }
  }

  Future<void> _cancelLinkSession() async {
    final deviceLinkService = ref.read(deviceLinkServiceProvider);
    await deviceLinkService.cancelLinkSession();
    setState(() => _linkSession = null);
  }

  Future<void> _revokeDevice(LinkedDevice device) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Revoke Device?'),
        content: Text(
          'Revoke ${device.deviceName}? It will need to be linked again to access messages.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.red,
              foregroundColor: Colors.white,
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Revoke'),
          ),
        ],
      ),
    );

    if (confirmed == true) {
      final deviceLinkService = ref.read(deviceLinkServiceProvider);
      await deviceLinkService.revokeDevice(device.id);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('${device.deviceName} revoked')),
        );
      }
    }
  }

  void _handleBarcode(BarcodeCapture capture) {
    if (_isConnecting) return;

    final barcode = capture.barcodes.firstOrNull;
    if (barcode == null || barcode.rawValue == null) return;

    final value = barcode.rawValue!;

    // Parse zajel:// URI
    if (value.startsWith('zajel://')) {
      final code = value.substring('zajel://'.length);
      _codeController.text = code;
      _connectWithCode();
    }
  }

  Future<void> _connectWithCode() async {
    final code = _codeController.text.trim();
    logger.info('ConnectScreen',
        '_connectWithCode called with code: "$code" (length: ${code.length})');
    if (code.isEmpty || code.length != 6) {
      logger.warning('ConnectScreen', 'Invalid code - empty or wrong length');
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter a valid 6-character code')),
      );
      return;
    }

    setState(() => _isConnecting = true);

    try {
      final connectionManager = ref.read(connectionManagerProvider);
      logger.info('ConnectScreen', 'Calling connectToPeer with code: $code');
      await connectionManager.connectToPeer(code);

      logger.info('ConnectScreen', 'connectToPeer succeeded, popping screen');
      if (mounted) {
        context.pop();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Connecting to peer...')),
        );
      }
    } catch (e) {
      logger.error('ConnectScreen', 'connectToPeer failed', e);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to connect: $e')),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _isConnecting = false);
      }
    }
  }
}

/// Converts all text input to uppercase.
class _UpperCaseTextFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    return TextEditingValue(
      text: newValue.text.toUpperCase(),
      selection: newValue.selection,
    );
  }
}
