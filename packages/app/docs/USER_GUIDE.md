# Zajel User Guide

Welcome to Zajel, a peer-to-peer encrypted messaging application that prioritizes your privacy and security. This guide will help you get started and make the most of Zajel's features.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Connecting with Peers](#connecting-with-peers)
3. [Messaging](#messaging)
4. [Voice and Video Calls](#voice-and-video-calls)
5. [Settings and Privacy](#settings-and-privacy)
6. [Security Features](#security-features)
7. [Troubleshooting](#troubleshooting)

---

## Getting Started

### First Launch

When you first open Zajel, the app will:

1. Generate your unique encryption keys (stored securely on your device)
2. Create a random display name (you can change this later)
3. Connect to a signaling server to help you find peers
4. Generate your pairing code

[Screenshot: Home Screen with status indicator]

### Understanding Your Pairing Code

Your pairing code is a 6-character code displayed on the home screen. This code:

- Changes when you restart the app or reconnect to the signaling server
- Allows others to find and connect to you
- Is temporary and session-based
- Does NOT compromise your security (all connections are encrypted)

**Example:** `ABC123`

You'll see your pairing code displayed under your name on the home screen and in the Connect screen.

### Connection Status Indicator

The home screen shows your connection status in the top-right corner:

- **Green "Online"**: Connected to the signaling server, ready to receive connections
- **Orange "Connecting..."**: Attempting to connect to the signaling server
- **Red "Offline"**: Not connected to the signaling server

When offline, you can still communicate with peers on your local network, but cannot connect to new remote peers.

---

## Connecting with Peers

Zajel offers multiple ways to connect with peers, depending on whether they're on the same network or remote.

### First Time Pairing (Remote Peers)

To connect with someone for the first time:

1. **Option 1: Scan QR Code**
   - Tap the QR code scanner icon in the top-right of the home screen
   - Switch to the "Scan" tab
   - Point your camera at the other person's QR code
   - Connection will start automatically

[Screenshot: QR Code Scanner]

2. **Option 2: Share Your QR Code**
   - Tap the QR code scanner icon or the floating "Connect" button
   - Go to the "My Code" tab
   - Show your QR code to the other person or share your pairing code
   - Wait for them to scan it or enter your code

[Screenshot: My QR Code screen]

3. **Option 3: Manual Code Entry**
   - On the "My Code" tab, scroll down to "Or enter a code manually"
   - Type in the 6-character pairing code from the other person
   - Tap "Connect"
   - Wait for the secure connection to establish

[Screenshot: Manual code entry]

### Local Network Discovery

If both devices are on the same Wi-Fi network:

- Peers will automatically appear on your home screen
- Look for devices showing in the "Connected Peers" list
- Tap "Connect" next to a peer to establish an encrypted connection
- No pairing code needed for local network peers

### Reconnecting with Trusted Peers

Once you've connected with someone:

- Their information is stored securely on your device
- They'll automatically appear in your peers list when online
- Tap their name to start chatting immediately
- The app will automatically try to reconnect when both devices are online

[Screenshot: Peer list with connected peers]

### Linking Web Browser (Desktop)

To use Zajel in your web browser securely:

1. Open the Connect screen and go to the "Link Web" tab
2. Tap "Generate Link Code"
3. A QR code and 6-character link code will appear
4. On your web browser, visit the Zajel web app
5. Scan the QR code or enter the link code
6. Approve the link request on your mobile device
7. Your web browser can now send/receive messages through your mobile device

**Why link?** Web browsers cannot verify server certificates like mobile apps can. Linking ensures your web browser uses your mobile device's secure connection.

[Screenshot: Link Web screen with QR code]

### Managing Linked Devices

- View all linked devices in the "Link Web" tab
- See connection status (Connected/Offline)
- Revoke access to any linked device by tapping the menu and selecting "Revoke"

---

## Messaging

### Sending Messages

1. From the home screen, tap on a connected peer
2. Type your message in the text field at the bottom
3. Press Enter or tap the send button
4. Your message is encrypted and sent directly to the peer

[Screenshot: Chat screen with messages]

### Message Status Indicators

Messages show different icons to indicate their status:

- **Loading circle**: Sending...
- **Single checkmark**: Sent to the peer
- **Double checkmark (gray)**: Delivered
- **Double checkmark (blue)**: Read by the peer
- **Red exclamation**: Failed to send

### File Transfers

To send a file:

1. Open a chat with a connected peer
2. Tap the paperclip icon (attach file)
3. Select a file from your device
4. The file will be encrypted and sent to the peer

To receive a file:

1. File messages appear with a file icon and name
2. Tap the "Open" icon on received files
3. Choose how to open or save the file

**Note:** Files are encrypted during transfer and only decrypted on the recipient's device.

[Screenshot: File transfer message bubble]

### Understanding Encryption

Every message you send is protected with end-to-end encryption:

- Messages are encrypted on your device before sending
- Only the recipient can decrypt them
- Uses X25519 key exchange and ChaCha20-Poly1305 encryption
- Not even Zajel servers can read your messages

When you first open a chat, you'll see a message explaining that the conversation is end-to-end encrypted.

[Screenshot: Encryption notice in empty chat]

---

## Voice and Video Calls

### Starting a Call

To make a voice call:

1. Open a chat with a connected peer
2. Tap the phone icon in the top-right corner
3. Wait for the peer to answer

To make a video call:

1. Open a chat with a connected peer
2. Tap the video camera icon in the top-right corner
3. Wait for the peer to answer

[Screenshot: Call buttons in chat header]

### Receiving a Call

When someone calls you:

1. You'll see an incoming call dialog with the caller's name
2. Choose:
   - **Answer** (audio only)
   - **Answer with Video**
   - **Reject**

[Screenshot: Incoming call dialog]

### During a Call

The call screen shows:

- Remote video (full screen) or avatar if no video
- Your video preview (top-right corner)
- Call duration timer
- Call controls at the bottom

**Call Controls:**

- **Mute/Unmute**: Toggle your microphone
- **Video Off/Video On**: Toggle your camera
- **Flip**: Switch between front/back camera
- **End**: Hang up the call

[Screenshot: Active call screen]

### Call Quality Tips

For the best call quality:

- Use a stable Wi-Fi connection
- Keep your device close to the router
- Ensure good lighting for video calls
- Close other apps that might use bandwidth

---

## Settings and Privacy

### Changing Your Display Name

1. Tap the settings icon (gear) on the home screen
2. In the "Profile" section, tap on your name
3. Enter a new display name
4. Tap "Save"

[Screenshot: Display name dialog]

### Privacy and Security Settings

Access these from the Settings screen:

**End-to-End Encryption**
- Always enabled - cannot be disabled
- All messages and calls are encrypted

**Regenerate Keys**
- Creates new encryption keys
- Disconnects all peers (you'll need to reconnect)
- Use this if you suspect your keys are compromised
- **Warning:** This is a destructive action

**Auto-delete Messages** (Coming soon)
- Automatically delete messages after 24 hours
- Currently not implemented

**Blocked Users**
- Manage users you've blocked
- Blocked users cannot send you messages or connect
- Blocking is now based on public keys (permanent)
- View and unblock users in the "Blocked Users" screen

[Screenshot: Privacy and Security settings]

### Blocking and Unblocking Users

To block a user:

1. On the home screen, tap the menu icon (⋮) next to their name
2. Select "Block"
3. Confirm the action

To unblock a user:

1. Go to Settings > Blocked Users
2. Tap "Unblock" next to the user's name
3. Confirm the action

**Note:** Blocking is based on the user's public key, so they remain blocked even if they change their display name or reconnect.

### External Connections

The "External Connections" section shows:

- **Connection Status**: Whether you're connected to the signaling server
- **Your Pairing Code**: The code others can use to connect to you
- **Selected Server**: Which VPS server you're connected to
- **Bootstrap Server**: The server that helps you find available VPS servers

**Bootstrap Server Configuration:**

The bootstrap server helps your app discover available signaling servers. You usually don't need to change this unless:

- You're running your own Zajel infrastructure
- Your organization has a private Zajel deployment

To change the bootstrap server:

1. Tap "Bootstrap Server" in settings
2. Enter the new URL (e.g., `https://bootstrap.example.com`)
3. Tap "Save" or "Reset" to restore the default

[Screenshot: External Connections settings]

---

## Security Features

### End-to-End Encryption

All communications in Zajel are encrypted using industry-standard cryptography:

- **Key Exchange**: X25519 elliptic curve Diffie-Hellman
- **Encryption**: ChaCha20-Poly1305 authenticated encryption
- **Key Derivation**: HKDF (HMAC-based Key Derivation Function)
- **Hashing**: SHA-256

This means:
- Messages are encrypted on your device
- Only the recipient can decrypt them
- Not even Zajel servers can read your messages
- Forward secrecy protects past messages if keys are compromised

### Public Key Verification

To verify you're talking to the right person and not an attacker:

1. Open a chat with the peer
2. Tap the info icon (ⓘ) in the top-right
3. Scroll to "Verify Connection Security"
4. Tap to expand the fingerprint section
5. Compare your fingerprints through a trusted channel:
   - In person
   - Phone call
   - Video chat
   - Text message (less secure)

[Screenshot: Fingerprint verification section]

**Understanding Fingerprints:**

- Each device has a unique fingerprint (SHA-256 hash of public key)
- Fingerprints are displayed as space-separated hex characters
- Example: `ABCD 1234 EF56 7890 ...`
- If fingerprints match, your connection is secure

**How to Verify:**

1. You read your fingerprint to your peer
2. They verify it matches what they see on their device
3. They read their fingerprint to you
4. You verify it matches what you see
5. If both match, your connection is verified

### Certificate Pinning (Desktop Platforms)

On desktop platforms (Windows, macOS, Linux), Zajel uses certificate pinning to prevent man-in-the-middle attacks:

- The app has built-in knowledge of valid server certificates
- Connections are rejected if the certificate doesn't match
- Protects against compromised certificate authorities
- Provides an extra layer of security for signaling server connections

**Note:** Certificate pinning is not available on web browsers. This is why we recommend linking your browser to a mobile device.

### Key Regeneration

If you suspect your encryption keys have been compromised:

1. Go to Settings > Privacy & Security
2. Tap "Regenerate Keys"
3. Confirm the action
4. All current connections will be disconnected
5. You'll need to reconnect with all peers

**When to regenerate keys:**

- If your device was lost or stolen (and later recovered)
- If you suspect someone accessed your device
- For maximum privacy, some users regenerate keys periodically

### Clear All Data

To completely reset Zajel:

1. Scroll to the bottom of the Settings screen
2. Tap "Clear All Data" (red text)
3. Confirm the action

This will delete:
- All messages
- All peer connections
- All encryption keys
- All app settings

**Warning:** This action cannot be undone.

---

## Troubleshooting

### Connection Issues

**Problem:** Cannot connect to the signaling server (stuck on "Connecting...")

**Solutions:**
- Check your internet connection
- Try switching between Wi-Fi and mobile data
- Restart the app
- Check if the bootstrap server URL is correct in settings
- Ensure your firewall isn't blocking the connection

**Problem:** Pairing code doesn't appear

**Solutions:**
- Wait a few seconds - the app needs to connect to the server first
- Check the connection status indicator in the top-right
- If offline, check your internet connection
- Try restarting the app

### Peer Connection Problems

**Problem:** Cannot connect to a peer using their pairing code

**Solutions:**
- Verify you entered the code correctly (6 characters, case-sensitive)
- Make sure both devices are connected to the signaling server
- Check that the peer's app is running and online
- Try having the peer connect to you instead

**Problem:** Peer appears offline but they say they're online

**Solutions:**
- Both devices need to be connected to the signaling server
- Check connection status in the top-right corner
- Try reconnecting to the signaling server (restart the app)
- Check that neither user has blocked the other

**Problem:** Local network peer not appearing

**Solutions:**
- Ensure both devices are on the same Wi-Fi network
- Check that local network discovery isn't blocked by router settings
- Some corporate/school networks block device discovery
- Try using pairing codes instead

### Reconnection Issues

**Problem:** Cannot reconnect to a previously trusted peer

**Solutions:**
- Make sure both devices are online
- Check if you or the peer regenerated encryption keys
- If keys were regenerated, you need to pair again
- Try removing and re-adding the peer

**Problem:** Peer says "Handshaking..." for a long time

**Solutions:**
- This is normal for the first connection (establishing encryption)
- Wait 10-30 seconds
- If it takes longer, cancel and try again
- Check your internet connection speed

### Message and File Transfer Issues

**Problem:** Messages show as "Failed to send"

**Solutions:**
- Check if the peer is still connected
- Verify your internet connection
- Try sending the message again (tap to retry)
- Reconnect to the peer if needed

**Problem:** File transfer fails or gets stuck

**Solutions:**
- Check available storage space on the recipient's device
- Ensure stable internet connection (especially for large files)
- Try sending smaller files
- Both devices need to stay connected during the transfer

### Call Issues

**Problem:** Cannot start a voice/video call

**Solutions:**
- Ensure you have a stable internet connection
- Check that microphone/camera permissions are granted
- Make sure the peer is connected
- Try restarting the app
- Check if your device supports WebRTC

**Problem:** Poor call quality or choppy video

**Solutions:**
- Use a Wi-Fi connection instead of mobile data
- Move closer to your Wi-Fi router
- Close other apps using bandwidth
- Turn off video to reduce bandwidth usage
- Check if others on your network are using bandwidth

**Problem:** No audio or video during call

**Solutions:**
- Check microphone/camera permissions in device settings
- Ensure the peer has granted permissions
- Try toggling video/mute during the call
- Restart the app and try again

### Debug Logs

If you're experiencing persistent issues:

1. Go to Settings > Debugging
2. Tap "Export Logs" to share with support
3. Tap "View Logs" to see what's happening
4. Logs show connection attempts, errors, and diagnostic information

**Note:** Logs do not contain message content, only technical information.

[Screenshot: Debug logs screen]

### Getting Help

If these solutions don't resolve your issue:

1. Export your debug logs (Settings > Debugging > Export Logs)
2. Visit the Zajel GitHub repository
3. Check existing issues or create a new one
4. Include:
   - What you were trying to do
   - What happened instead
   - Steps to reproduce the problem
   - Your debug logs (if relevant)

---

## Tips for Best Experience

### Privacy Best Practices

1. **Verify fingerprints** for important contacts
2. **Regenerate keys periodically** if you're very privacy-conscious
3. **Use local network connections** when possible (more private, faster)
4. **Link web browsers** instead of using them standalone
5. **Review blocked users** periodically

### Performance Tips

1. **Use Wi-Fi** for calls and large file transfers
2. **Close unused chats** to save memory
3. **Clear old messages** periodically (or wait for auto-delete feature)
4. **Keep the app updated** for performance improvements

### Security Tips

1. **Never share your pairing code publicly** (one-on-one only)
2. **Verify you're connecting to the right person** before sharing sensitive info
3. **Use fingerprint verification** for high-security conversations
4. **Keep your device locked** when not in use
5. **Don't link unknown web browsers** to your device

---

## Frequently Asked Questions

**Q: Is Zajel really private?**

A: Yes. All messages and calls use end-to-end encryption. The signaling servers only help devices find each other - they never see your message content.

**Q: Can I use Zajel without internet?**

A: You can communicate with peers on the same local network without internet. Remote connections require internet for the initial connection through the signaling server.

**Q: Why do I need a pairing code?**

A: The pairing code helps devices find each other through the signaling server. It's like a temporary phone number that changes each session.

**Q: What happens if I lose my device?**

A: Your messages are only stored on your device. If you lose it, you lose your messages. We recommend backing up important information externally.

**Q: Can I use the same account on multiple devices?**

A: Zajel doesn't have traditional accounts. Each device has its own encryption keys. You can link a web browser to your mobile device for multi-device access.

**Q: Why does my pairing code change?**

A: Pairing codes are temporary and session-based. They change when you restart the app or reconnect to the signaling server for privacy reasons.

**Q: Is there a message size limit?**

A: There's no hard limit, but very large messages may take longer to encrypt/decrypt and send. Consider using file transfers for large content.

**Q: What file types can I send?**

A: Any file type can be sent through Zajel. Files are encrypted during transfer.

---

## Version Information

**Current Version:** 1.0.0

**Platform Support:**
- Android
- iOS
- Windows (desktop)
- macOS (desktop)
- Linux (desktop)
- Web (with device linking)

**Open Source:**
Zajel is open source and auditable. View the source code at:
https://github.com/Hamza-Labs-Core/zajel

---

## Privacy Policy

Zajel is designed with privacy as the top priority:

- No user accounts or registration required
- No message content stored on servers
- No analytics or tracking
- No data collection
- All data stays on your device

For the full privacy policy, visit:
https://github.com/Hamza-Labs-Core/zajel/blob/main/PRIVACY.md

---

## Support and Community

- **GitHub Issues**: Report bugs and request features
- **Source Code**: Contribute to the project
- **Documentation**: Technical details and API docs

Thank you for using Zajel!
