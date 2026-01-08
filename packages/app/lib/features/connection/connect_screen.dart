import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:qr_flutter/qr_flutter.dart';

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

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _enableExternalConnections();
  }

  Future<void> _enableExternalConnections() async {
    try {
      // First, discover and select a VPS server
      final discoveryService = ref.read(serverDiscoveryServiceProvider);
      final selectedServer = await discoveryService.selectServer();

      if (selectedServer == null) {
        setState(() => _error = 'No servers available. Please try again later.');
        return;
      }

      // Store the selected server
      ref.read(selectedServerProvider.notifier).state = selectedServer;

      // Get the WebSocket URL for the selected server
      final serverUrl = discoveryService.getWebSocketUrl(selectedServer);

      // Now connect to the VPS server
      final connectionManager = ref.read(connectionManagerProvider);
      final code = await connectionManager.enableExternalConnections(
        serverUrl: serverUrl,
      );

      ref.read(pairingCodeProvider.notifier).state = code;
      ref.read(externalConnectionEnabledProvider.notifier).state = true;
    } catch (e) {
      setState(() => _error = 'Failed to enable external connections: $e');
    }
  }

  @override
  void dispose() {
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
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          _buildMyCodeTab(),
          _buildScanTab(),
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
                onPressed: _enableExternalConnections,
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
          Text(
            'Share this code with others to connect',
            style: Theme.of(context).textTheme.bodyLarge,
          ),
          const SizedBox(height: 24),
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
              size: 200,
              backgroundColor: Colors.white,
            ),
          ),
          const SizedBox(height: 24),
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
          const SizedBox(height: 16),
          Text(
            'Visible as: $displayName',
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 32),
          const Divider(),
          const SizedBox(height: 16),
          Text(
            'Or enter a code manually',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _codeController,
                  decoration: const InputDecoration(
                    hintText: 'Enter pairing code',
                  ),
                  textCapitalization: TextCapitalization.characters,
                  inputFormatters: [
                    FilteringTextInputFormatter.allow(RegExp(r'[A-Z0-9]')),
                    LengthLimitingTextInputFormatter(6),
                  ],
                ),
              ),
              const SizedBox(width: 16),
              ElevatedButton(
                onPressed: _isConnecting ? null : _connectWithCode,
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
    if (code.isEmpty || code.length != 6) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter a valid 6-character code')),
      );
      return;
    }

    setState(() => _isConnecting = true);

    try {
      final connectionManager = ref.read(connectionManagerProvider);
      await connectionManager.connectToExternalPeer(code);

      if (mounted) {
        context.pop();
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Connecting to peer...')),
        );
      }
    } catch (e) {
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
