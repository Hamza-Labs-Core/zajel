import 'package:flutter/material.dart';

/// A single section within a help article.
class HelpSection {
  final String? header;
  final String body;
  final bool isWarning;

  const HelpSection({
    this.header,
    required this.body,
    this.isWarning = false,
  });
}

/// A help article displayed in the knowledge base.
class HelpArticle {
  final String id;
  final String title;
  final String subtitle;
  final IconData icon;
  final List<HelpSection> sections;

  const HelpArticle({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.sections,
  });
}

/// Static help content for the in-app knowledge base.
class HelpContent {
  static const List<HelpArticle> articles = [
    HelpArticle(
      id: 'how-it-works',
      title: 'How Zajel Works',
      subtitle: 'P2P architecture, signaling, and bootstrap',
      icon: Icons.hub,
      sections: [
        HelpSection(
          header: 'Peer-to-Peer Messaging',
          body:
              'Zajel sends messages directly between devices using WebRTC data '
              'channels. Your messages never pass through a server. When you send '
              'a message, it travels directly from your device to your contact\'s '
              'device over an encrypted peer-to-peer connection.',
        ),
        HelpSection(
          header: 'Signaling Server',
          body:
              'The signaling server only helps devices find each other. When you '
              'open the app, it connects to a signaling server and receives a '
              'temporary pairing code. The signaling server exchanges WebRTC '
              'connection offers and answers between devices, but it never sees '
              'your message content. Once two devices are connected, the signaling '
              'server is no longer involved in that conversation.',
        ),
        HelpSection(
          header: 'Bootstrap Server',
          body:
              'The bootstrap server provides a list of available signaling servers. '
              'This is how your app discovers which signaling servers are online '
              'and selects one to connect to. The bootstrap server does not handle '
              'messages or know who you are communicating with.',
        ),
        HelpSection(
          header: 'No Accounts',
          body:
              'Zajel does not use accounts, phone numbers, or email addresses. '
              'Your identity is a cryptographic keypair generated on your device. '
              'There is no registration process and no personal information is '
              'collected.',
        ),
      ],
    ),
    HelpArticle(
      id: 'identity',
      title: 'Your Identity',
      subtitle: 'How your identity works and why it matters',
      icon: Icons.fingerprint,
      sections: [
        HelpSection(
          header: 'Cryptographic Identity',
          body:
              'When you first launch Zajel, an X25519 keypair is generated on '
              'your device. The private key is your identity. It is stored in '
              'your device\'s secure storage: Keychain on iOS and macOS, Keystore '
              'on Android, libsecret on Linux, and DPAPI on Windows.',
        ),
        HelpSection(
          body:
              'Uninstalling the app permanently destroys your identity. There is '
              'no backup, no recovery, and no way to restore it. All your contacts '
              'will need to re-pair with you using a new pairing code. Your '
              'previous message history will also be lost.',
          isWarning: true,
        ),
        HelpSection(
          header: 'Regenerate Keys',
          body:
              'The "Regenerate Keys" option in Settings creates a completely new '
              'identity. All existing peers will no longer recognize you and all '
              'connections will be severed. You will need to re-pair with everyone. '
              'Use this only if you believe your keys have been compromised.',
        ),
        HelpSection(
          header: 'Clear All Data',
          body:
              'The "Clear All Data" option in Settings destroys everything: your '
              'identity keys, all messages, all contacts, and all preferences. '
              'This is equivalent to a fresh install. This action cannot be undone.',
        ),
      ],
    ),
    HelpArticle(
      id: 'pairing',
      title: 'Pairing & Connecting',
      subtitle: 'How to connect with contacts',
      icon: Icons.people,
      sections: [
        HelpSection(
          header: 'Pairing Codes',
          body: 'When your app connects to a signaling server, it receives a '
              'temporary 6-character pairing code. This code changes every time '
              'you reconnect. It is not a permanent address. Share your code with '
              'someone you want to connect with, or enter their code to initiate '
              'a connection.',
        ),
        HelpSection(
          header: 'QR Codes',
          body:
              'You can also connect by scanning a QR code. Your QR code contains '
              'your pairing code in a machine-readable format. This is often '
              'faster and less error-prone than typing a code manually.',
        ),
        HelpSection(
          header: 'Trusted Peers',
          body:
              'Once two devices are paired, they remember each other as trusted '
              'peers. Trusted peers automatically reconnect via meeting points '
              'when both devices are online. You do not need to re-enter pairing '
              'codes for established connections.',
        ),
        HelpSection(
          header: 'Both Devices Must Be Online',
          body:
              'Zajel is a real-time peer-to-peer messenger. Both devices must be '
              'online simultaneously to communicate. There is no offline message '
              'queue or store-and-forward mechanism. If your contact is offline, '
              'your message cannot be delivered until they come back online.',
          isWarning: true,
        ),
        HelpSection(
          header: 'Web Client Linking',
          body: 'You can link a web browser to your mobile device for secure '
              'messaging from your computer. The web client runs in your browser '
              'and communicates through your mobile device. It cannot independently '
              'hold an identity.',
        ),
      ],
    ),
    HelpArticle(
      id: 'encryption',
      title: 'Encryption Explained',
      subtitle: 'How your messages are protected',
      icon: Icons.lock,
      sections: [
        HelpSection(
          header: 'Always-On Encryption',
          body: 'All messages in Zajel are encrypted with ChaCha20-Poly1305, a '
              'modern authenticated encryption cipher. Encryption is always on '
              'and cannot be disabled. Every message is encrypted before it '
              'leaves your device and can only be decrypted by the intended '
              'recipient.',
        ),
        HelpSection(
          header: 'Key Exchange',
          body: 'Before two devices can communicate securely, they perform an '
              'X25519 key exchange (Elliptic Curve Diffie-Hellman). This creates '
              'a shared secret that only the two devices know. This shared secret '
              'is used to derive encryption keys for the session.',
        ),
        HelpSection(
          header: 'True End-to-End Encryption',
          body:
              'Only you and your contact have the encryption keys. No server -- '
              'not the signaling server, not the bootstrap server, and not '
              'Zajel\'s developers -- can read your messages. In a P2P messenger '
              'like Zajel, "end-to-end encrypted" means exactly what it says: '
              'the messages are encrypted on your device and decrypted only on '
              'your contact\'s device.',
        ),
        HelpSection(
          header: 'Key Fingerprints',
          body:
              'You can verify a contact\'s identity by comparing key fingerprints '
              'shown in the contact details screen. If the fingerprints match on '
              'both devices, you can be confident that no one is intercepting '
              'your communication.',
        ),
      ],
    ),
    HelpArticle(
      id: 'data-storage',
      title: 'Data Storage',
      subtitle: 'Where your data lives and how to protect it',
      icon: Icons.storage,
      sections: [
        HelpSection(
          header: 'Local-Only Messages',
          body:
              'Messages are stored in a local SQLite database on your device. '
              'They are never uploaded to any server. If your device is lost, '
              'stolen, or the app is uninstalled, your messages are permanently '
              'gone.',
        ),
        HelpSection(
          header: 'File Transfers',
          body: 'File transfers go directly between devices over the encrypted '
              'peer-to-peer connection. Files are saved to your device\'s local '
              'storage. No files are stored on any server.',
        ),
        HelpSection(
          header: 'No Cloud Backup',
          body: 'Zajel does not offer cloud backup of any kind. Your messages, '
              'contacts, and identity exist only on your device. This is by '
              'design: it ensures that your data remains under your control '
              'and cannot be accessed by third parties.',
          isWarning: true,
        ),
        HelpSection(
          header: 'What Is Stored Where',
          body:
              'Identity keypair: Device secure storage (Keychain / Keystore / '
              'libsecret / DPAPI).\n'
              'Session keys: Device secure storage.\n'
              'Trusted peers: Device secure storage.\n'
              'Messages: Local SQLite database.\n'
              'Preferences: SharedPreferences.\n\n'
              'None of this data survives an app uninstall.',
        ),
      ],
    ),
    HelpArticle(
      id: 'platform-notes',
      title: 'Platform-Specific Notes',
      subtitle: 'Tips for Android, iOS, desktop, and web',
      icon: Icons.devices,
      sections: [
        HelpSection(
          header: 'Android',
          body:
              'Camera permission is needed for QR code scanning. Notification '
              'permission is requested on first launch. Background connections '
              'may be affected by battery optimization. Consider disabling Doze '
              'mode for Zajel in your device\'s battery settings to maintain '
              'reliable connections.',
        ),
        HelpSection(
          header: 'iOS',
          body:
              'Camera permission is required for QR code scanning. Notification '
              'permission is requested on first launch. Background App Refresh '
              'affects connectivity. Ensure it is enabled for Zajel in Settings '
              'to maintain connections when the app is in the background.',
        ),
        HelpSection(
          header: 'Linux',
          body:
              'Uses libsecret for secure key storage. Ensure a keyring service '
              '(such as GNOME Keyring) is running. Desktop tray integration is '
              'not yet available.',
        ),
        HelpSection(
          header: 'Windows',
          body:
              'Uses Windows Credential Manager (DPAPI) for key storage. You may '
              'see ANGLE or DirectX warnings on older hardware. These are '
              'typically harmless and relate to graphics rendering.',
        ),
        HelpSection(
          header: 'macOS',
          body:
              'Uses Keychain for secure key storage. Camera permission is needed '
              'for QR code scanning.',
        ),
        HelpSection(
          header: 'Web (Linked Client)',
          body: 'The web client runs in your browser and must be linked to a '
              'native app instance. It cannot independently hold an identity. '
              'The web client\'s capabilities are limited by the browser\'s '
              'WebRTC implementation.',
        ),
      ],
    ),
    HelpArticle(
      id: 'troubleshooting',
      title: 'Troubleshooting',
      subtitle: 'Solutions for common issues',
      icon: Icons.build,
      sections: [
        HelpSection(
          header: '"Offline" Status',
          body: 'This means the signaling server is unreachable. Check your '
              'internet connection. The app automatically retries with '
              'exponential backoff (3s, 6s, 12s, 24s, 48s). If the problem '
              'persists, try switching networks or check if a firewall is '
              'blocking WebSocket connections.',
        ),
        HelpSection(
          header: 'Peer Shows "Offline"',
          body:
              'The other device is not connected to the signaling server. Both '
              'devices must be online for communication. Ask your contact to '
              'open the app and ensure they have an active internet connection.',
        ),
        HelpSection(
          header: '"Connection Failed"',
          body:
              'This usually means the WebRTC ICE negotiation failed, which is '
              'typically caused by a restrictive network or firewall. Try '
              'connecting from a different network. Some corporate or school '
              'networks block peer-to-peer connections.',
        ),
        HelpSection(
          header: 'Messages Not Delivering',
          body: 'The recipient must be online to receive messages. There is no '
              'offline message queue. If your contact shows as "Connected" but '
              'messages are not being delivered, try disconnecting and '
              'reconnecting.',
        ),
        HelpSection(
          header: 'Lost Identity After Reinstall',
          body: 'This is expected behavior. Uninstalling the app destroys your '
              'identity keypair. You will need to re-pair with all contacts '
              'using new pairing codes. There is no way to recover a lost '
              'identity.',
          isWarning: true,
        ),
        HelpSection(
          header: 'QR Scanner Not Working',
          body:
              'Check that camera permissions are granted in your device\'s system '
              'settings. On Android, go to Settings > Apps > Zajel > Permissions. '
              'On iOS, go to Settings > Zajel > Camera.',
        ),
      ],
    ),
  ];

  /// Find a help article by its ID.
  static HelpArticle? findArticle(String id) {
    try {
      return articles.firstWhere((article) => article.id == id);
    } catch (_) {
      return null;
    }
  }
}
