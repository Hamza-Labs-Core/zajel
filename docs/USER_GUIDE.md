# Zajel User Guide

Zajel is a peer-to-peer encrypted messaging app that allows you to communicate securely with others on the same local network without any central server.

## Getting Started

### Running the App

**Linux:**
```bash
cd zajel
flutter run -d linux
```

**Android:**
- Install the APK from the [Releases](https://github.com/Hamza-Labs-Core/zajel/releases) page
- Or build from source: `flutter build apk`

**iOS:**
- Build from source: `flutter build ios`
- Install via Xcode or TestFlight

**Windows:**
- Download from [Releases](https://github.com/Hamza-Labs-Core/zajel/releases)
- Or build: `flutter build windows`

**macOS:**
- Download DMG from [Releases](https://github.com/Hamza-Labs-Core/zajel/releases)
- Or build: `flutter build macos`

## Features

### 1. Automatic Peer Discovery

When you open Zajel, it automatically discovers other Zajel users on your local network using mDNS (multicast DNS). You'll see them appear in the peers list on the home screen.

**How it works:**
- Your device broadcasts its presence on the network
- Other devices running Zajel will appear in your peer list
- No manual IP address entry required

### 2. Connecting to Peers

To connect with a discovered peer:

1. Open Zajel on both devices
2. Wait for peer discovery (peers appear in the list)
3. Tap the **Connect** button next to a peer
4. Wait for the connection to establish

**Connection States:**
- 🔴 **Disconnected** - Not connected to the peer
- 🟡 **Connecting** - Connection in progress
- 🟢 **Connected** - Ready to send messages

### 3. Sending Messages

Once connected:

1. Tap on a connected peer to open the chat
2. Type your message in the text field
3. Tap the send button

**All messages are end-to-end encrypted** using X25519 key exchange and AES-GCM encryption.

### 4. Sending Files

To send a file:

1. Open a chat with a connected peer
2. Tap the attachment button (📎)
3. Select a file from your device
4. The file will be chunked, encrypted, and sent

### 5. Changing Your Display Name

1. Go to Settings (gear icon)
2. Tap on "Display Name"
3. Enter your preferred name
4. Tap Save

This name is what other peers will see when they discover you.

## Troubleshooting

### Peers not appearing?

1. **Check you're on the same network** - Both devices must be on the same local network (WiFi or LAN)
2. **Check firewall** - Ensure mDNS (port 5353 UDP) and the signaling port are not blocked
3. **Restart the app** - Sometimes mDNS discovery needs a restart

### Connection failing?

1. **Ensure both devices have the app open** - The peer must be actively running Zajel
2. **Check network connectivity** - Ping the other device to ensure network is working
3. **Try restarting both apps** - This refreshes the WebRTC connections

### Messages not sending?

1. **Check connection status** - Ensure the peer shows as "Connected"
2. **Wait for handshake** - The cryptographic handshake must complete before messages can be sent

## Security

Zajel uses strong encryption:

- **Key Exchange**: X25519 (Curve25519 ECDH)
- **Message Encryption**: AES-256-GCM
- **No Central Server**: All communication is peer-to-peer
- **Forward Secrecy**: Each session uses unique keys

Your messages are never stored on any server - they go directly from your device to the recipient's device.

## Architecture

```
┌─────────────────┐                    ┌─────────────────┐
│    Device A     │                    │    Device B     │
├─────────────────┤                    ├─────────────────┤
│  mDNS Discovery │◄──── WiFi LAN ────►│  mDNS Discovery │
│                 │                    │                 │
│  WebRTC P2P     │◄──── Encrypted ───►│  WebRTC P2P     │
│  Data Channel   │      Messages      │  Data Channel   │
└─────────────────┘                    └─────────────────┘
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Enter | Send message |
| Ctrl+Enter | New line in message |

## FAQ

**Q: Does Zajel work over the internet?**
A: Currently, Zajel only works on local networks. Internet connectivity via a signaling server is planned for future releases.

**Q: Is my data stored anywhere?**
A: Messages are stored locally on your device only. No cloud storage or servers are involved.

**Q: Can I use Zajel without WiFi?**
A: Both devices need to be on the same network. This can be WiFi, Ethernet, or even a mobile hotspot.

**Q: What happens if I lose connection?**
A: You'll need to reconnect. Messages sent while disconnected won't be delivered (no offline messaging yet).

## Support

- **Issues**: [GitHub Issues](https://github.com/Hamza-Labs-Core/zajel/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Hamza-Labs-Core/zajel/discussions)
