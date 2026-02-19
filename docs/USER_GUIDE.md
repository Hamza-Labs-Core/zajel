# Zajel User Guide

Zajel is a peer-to-peer encrypted messaging app. It uses signaling servers to help you find and connect with peers over the internet, then establishes direct WebRTC connections for private, end-to-end encrypted communication. No account, phone number, or email is required.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [First Launch and Onboarding](#2-first-launch-and-onboarding)
3. [Your Identity](#3-your-identity)
4. [Connecting with Peers](#4-connecting-with-peers)
5. [Sending Messages](#5-sending-messages)
6. [Sending Files](#6-sending-files)
7. [Voice and Video Calls](#7-voice-and-video-calls)
8. [Channels](#8-channels)
9. [Groups](#9-groups)
10. [Contacts](#10-contacts)
11. [Settings](#11-settings)
12. [Web Client](#12-web-client)
13. [Security](#13-security)
14. [Privacy](#14-privacy)
15. [Troubleshooting](#15-troubleshooting)
16. [FAQ](#16-faq)
17. [Keyboard Shortcuts](#17-keyboard-shortcuts)

---

## 1. Getting Started

### Supported Platforms

Zajel runs on the following platforms:

- **Android** (phone and tablet)
- **iOS** (iPhone and iPad)
- **Linux** (desktop)
- **Windows** (desktop)
- **macOS** (desktop)
- **Web** (browser-based client, linked to a mobile device)

### Installation

**Android:**
- Install the APK from the [Releases](https://github.com/Hamza-Labs-Core/zajel/releases) page.
- Or build from source: `flutter build apk`

**iOS:**
- Build from source: `flutter build ios`
- Install via Xcode or TestFlight.

**Linux:**
- Download from the [Releases](https://github.com/Hamza-Labs-Core/zajel/releases) page.
- Or build from source: `flutter build linux`

**Windows:**
- Download from the [Releases](https://github.com/Hamza-Labs-Core/zajel/releases) page.
- Or build from source: `flutter build windows`

**macOS:**
- Download DMG from the [Releases](https://github.com/Hamza-Labs-Core/zajel/releases) page.
- Or build from source: `flutter build macos`

**Web Client:**
- See the [Web Client](#12-web-client) section. The web client must be linked to a mobile device.

---

## 2. First Launch and Onboarding

When you open Zajel for the first time, you will see a 4-step onboarding tutorial:

1. **Welcome** -- Introduction to Zajel and what it does.
2. **Your Identity** -- Explains that Zajel generates a unique cryptographic identity for you. This identity is stored only on your device. If you uninstall the app or clear its data, your identity is permanently lost.
3. **How to Connect** -- Shows how to connect with other Zajel users using pairing codes and QR scanning.
4. **You're Ready** -- Confirms setup is complete and takes you to the home screen.

You can swipe through these steps or skip ahead. The onboarding only appears once; subsequent launches go directly to the home screen.

---

## 3. Your Identity

When Zajel starts for the first time, it generates a cryptographic keypair for you:

- **X25519 key pair** -- Used for Elliptic Curve Diffie-Hellman (ECDH) key exchange to establish encrypted sessions with peers.
- **Public key fingerprint** -- A SHA-256 hash of your public key, displayed as a hexadecimal string. You can share this fingerprint with peers through a trusted channel (in person, phone call) to verify you are communicating with the right person.

### Important: Your identity lives only on your device

- Your private key is stored in your device's secure storage (Keychain on iOS/macOS, Keystore on Android, platform-specific secure storage on desktop).
- There is no cloud backup. There is no recovery mechanism.
- **If you uninstall Zajel, clear app data, or reset your device, your identity is permanently destroyed.** All your contacts will need to re-pair with you.
- Regenerating your keys inside the app has the same effect: all existing peer connections become invalid.

### Display Name

You can set a display name that other peers will see. Go to **Settings > Profile > Display Name** to change it. This name is transmitted to peers you connect with but is not stored on any server.

---

## 4. Connecting with Peers

Zajel connects peers through the internet using signaling servers. The connection process works as follows:

### How It Works

```
+-----------+                                        +-----------+
|  Device A |                                        |  Device B |
+-----------+                                        +-----------+
      |                                                    |
      |   1. Connect to signaling server (WebSocket)       |
      |--------------------->+------------------+<---------|
      |                      | Signaling Server |          |
      |                      | (Cloudflare/VPS) |          |
      |                      +------------------+          |
      |                                                    |
      |   2. Exchange pairing codes                        |
      |<-------------------------------------------------->|
      |                                                    |
      |   3. WebRTC signaling (SDP offer/answer, ICE)      |
      |<------- via signaling server ---------------------->|
      |                                                    |
      |   4. Direct P2P connection established             |
      |<======================WebRTC======================>|
      |       (encrypted data channel)                     |
      |                                                    |
```

1. Both devices connect to a signaling server over a secure WebSocket.
2. One user shares their pairing code with the other.
3. The signaling server facilitates WebRTC negotiation (SDP offers/answers, ICE candidates).
4. Once the WebRTC connection is established, all communication flows directly between the two devices. The signaling server is no longer involved in message delivery.

### Server Discovery

Zajel uses a bootstrap service to discover available signaling servers. The bootstrap service returns a list of VPS servers, signed with Ed25519 to prevent tampering. Servers are federated using the SWIM gossip protocol, meaning the system can scale and operate across multiple server instances.

### Pairing with a New Peer

There are three ways to pair with someone:

**Method 1: QR Code Scanning (mobile)**
1. Open Zajel and tap the **Connect** button (QR icon in the navigation bar).
2. Your 6-character pairing code is displayed along with a QR code.
3. The other person opens their Zajel app, taps Connect, and scans your QR code with their camera.
4. Both devices receive a pair request. Accept the request on both sides.
5. The WebRTC connection is established and you can begin messaging.

**Method 2: Manual Pairing Code Entry**
1. Open Zajel and tap the **Connect** button.
2. Share your 6-character pairing code with the other person through any channel (in person, phone, text, etc.).
3. The other person enters your code in the "Enter Code" field and taps **Connect**.
4. Both devices receive a pair request. Accept the request on both sides.

**Method 3: Clipboard Copy**
1. Your pairing code can be copied to the clipboard by tapping the copy icon next to it.
2. Share it however you like, and the other person enters it manually.

### Pairing Code Details

- Pairing codes are 6 characters long, alphanumeric, and uppercase.
- They are generated using cryptographically secure random sampling.
- They are temporary and change when you reconnect to the signaling server.

### Reconnecting with Existing Peers

Once you have paired with a peer and they are in your trusted contacts, Zajel uses a rendezvous system to reconnect automatically:

- **Meeting points**: Deterministic daily meeting points are derived from both peers' public keys. Zajel registers at these meeting points on the signaling server.
- **Live matching**: If both peers are online simultaneously, the server notifies each one, and they reconnect directly.
- **Dead drops**: If one peer is offline, the online peer leaves an encrypted "dead drop" message at the meeting point containing connection information. When the offline peer comes online, they retrieve the dead drop and reconnect.

This means you do not need to exchange pairing codes again with existing contacts.

---

## 5. Sending Messages

Once connected to a peer:

1. Tap on the peer in your peer list (or select them in the sidebar on desktop).
2. Type your message in the text input field at the bottom.
3. Tap the send button (or press Enter on desktop).

### Message Features

- **End-to-end encryption**: Every message is encrypted with ChaCha20-Poly1305 before it leaves your device. Only the recipient can decrypt it.
- **Message status indicators**: Messages show their delivery status:
  - Pending (queued locally)
  - Sending (in transit)
  - Sent (delivered to peer's device)
  - Delivered (peer's app received it)
  - Read (peer opened the conversation)
  - Failed (delivery failed)
- **Date dividers**: Messages are grouped by date with dividers showing "Today", "Yesterday", or the date in DD/MM/YYYY format.
- **Emoji picker**: Tap the emoji button in the input bar to open an emoji picker. The picker filters out certain emoji categories.
- **Offline queuing**: If a peer is disconnected, the app shows a warning banner. Messages sent while a peer is offline are queued and indicate that they will be delivered when the peer reconnects.

### Encryption Details

When you open a new chat with no messages, Zajel displays the encryption method being used:

> Messages are end-to-end encrypted using X25519 key exchange and ChaCha20-Poly1305 authenticated encryption.

Messages are also protected against replay attacks. Each message includes a sequence number, and a sliding window mechanism rejects duplicate or stale messages. This means an attacker cannot record and retransmit your encrypted messages to impersonate you.

---

## 6. Sending Files

To send a file to a connected peer:

1. Open the chat with the peer.
2. Tap the attachment button (paperclip icon) in the message input bar.
3. Select a file from your device.
4. The file is chunked into 16KB segments, each segment is encrypted individually with ChaCha20-Poly1305, and the chunks are sent over the WebRTC data channel.

### Receiving Files

- Incoming files appear as file message bubbles showing the file name and size.
- Tap the **Open** button on a received file to open it:
  - On desktop (Linux, Windows, macOS), the file opens with your system's default application.
  - On mobile (Android, iOS), the file is shared via the system share sheet.

### File Transfer Details

- Files are transferred directly between devices over the encrypted WebRTC data channel.
- No file data ever passes through or is stored on any server.
- Large files are split into 16KB encrypted chunks with metadata and per-chunk encryption.
- Transfer progress is tracked and displayed.
- **Integrity verification**: Each file transfer includes a SHA-256 hash. The recipient verifies that the reassembled file matches the expected hash, ensuring the file was not corrupted or tampered with during transfer.
- **Size validation**: Incoming file transfers are validated against size limits to prevent resource exhaustion.

---

## 7. Voice and Video Calls

Zajel supports voice and video calls over the P2P WebRTC connection.

### Starting a Call

1. Open a chat with a connected peer.
2. Tap the **phone icon** for a voice call, or the **video camera icon** for a video call.
3. The peer receives an incoming call notification.

### Incoming Calls

When someone calls you, an incoming call dialog appears showing:
- The caller's name and avatar.
- Whether it is a voice or video call.
- Three buttons: **Accept (audio)**, **Accept with Video**, and **Decline**.

### Call Controls

During an active call, the following controls are available:

| Control | Description |
|---------|-------------|
| Mute | Toggle your microphone on/off |
| Video | Toggle your camera on/off |
| Camera Switch | Switch between front and back cameras (mobile only) |
| Device Settings | Open audio/video device configuration |
| Hang Up | End the call |

### Call Screen

- **Remote video** fills the main screen area. If video is off, the peer's avatar is displayed.
- **Local video preview** appears in a small corner overlay (mirrored, rounded corners).
- **Call duration** is displayed while connected, formatted as MM:SS or H:MM:SS.
- **Call state** is shown as an overlay: "Calling...", "Connecting...", "Connected", or "Ended".

### In-Call Device Settings

During a call, you can open the device settings sheet to:
- Select a different audio input or output device.
- Toggle noise suppression, echo cancellation, and automatic gain control.
- Adjust background blur settings.

### Call Timeouts

- Ringing timeout: 60 seconds (if the peer does not answer, the call ends).
- Reconnection timeout: 10 seconds (if the connection drops, the call attempts to reconnect for 10 seconds).
- ICE gathering timeout: 30 seconds.

---

## 8. Channels

Channels are broadcast-style communication spaces. A channel owner publishes content that subscribers can receive. Think of them as one-to-many broadcast feeds.

### Roles

- **Owner**: Creates the channel, publishes content, manages admins, controls channel rules.
- **Admin**: Can publish content to the channel (appointed by the owner).
- **Subscriber**: Receives published content. Can send replies, votes, and reactions to the owner if the channel rules allow it.

### Creating a Channel

1. Navigate to the **Channels** section from the navigation bar.
2. Tap the **Create Channel** button (plus icon).
3. Enter a channel name and an optional description.
4. Tap **Create**.

When a channel is created, Zajel generates:
- An **Ed25519 signing keypair** for signing the channel manifest and content.
- An **X25519 encryption keypair** for encrypting channel content.
- A **channel ID** derived from the owner's public key using SHA-256.
- A **signed manifest** containing the channel name, description, owner keys, encryption key, rules, and epoch.

### Subscribing to a Channel

1. Navigate to the **Channels** section.
2. Tap the **Subscribe** button.
3. Paste a channel invite link (in the format `zajel://channel/...`).
4. Tap **Subscribe**. The app verifies the manifest signature and stores the channel.

### Sharing a Channel (Invite Links)

If you own a channel:
1. Open the channel detail screen.
2. Tap the **Share** button.
3. The invite link is displayed and can be copied to the clipboard.

The invite link is self-contained: it encodes the signed manifest and the channel decryption key so that anyone with the link can subscribe. Invite links never expose the channel's private signing key -- only the content decryption key is shared, so subscribers can read content but cannot forge messages on behalf of the channel owner.

### Publishing Content

If you are the channel owner or an admin:
1. Open the channel.
2. Type your message in the compose bar at the bottom.
3. Tap **Send**.

The message is encrypted with ChaCha20-Poly1305 using the channel's encryption key, split into 64KB chunks, signed with the author's Ed25519 key, and distributed through the relay server.

### Content Distribution

Channel content is distributed through a swarm-based system:
- Chunks are announced to the relay server.
- The relay server caches chunks temporarily (30-minute TTL).
- Other subscribers can pull chunks from the server cache or directly from peers who have them (swarm seeding).
- Background sync runs periodically (default every 5 minutes) to fetch new content.

### Polls

Channel owners can create polls:
- A poll has a question and multiple options.
- Polls can allow single or multiple selections.
- Polls can have a close time after which no more votes are accepted.
- Subscribers vote by sending an upstream message to the owner.
- The owner aggregates and publishes results.

### Upstream Messaging (Replies, Votes, Reactions)

Subscribers can interact with channel content if the channel rules permit:
- **Replies**: Send a text reply to a specific message. Replies are grouped into threads.
- **Votes**: Cast a vote on a poll.
- **Reactions**: Send an emoji reaction to a message.

Upstream messages are encrypted with the owner's public key using ephemeral keys, so only the channel owner can read them.

### Channel Rules

The owner can configure channel rules:
- Enable or disable replies.
- Enable or disable polls.
- Set maximum upstream message size.
- Restrict allowed content types (text, file, audio, video, document, poll).

### Admin Management

The channel owner can:
- **Appoint admins**: Add another user's Ed25519 public key as an admin. Admins can publish content.
- **Remove admins**: Remove an admin. When an admin is removed, the encryption key is rotated to revoke their access to future content.

### Encryption Key Rotation

The owner can rotate the channel's X25519 encryption key. This increments the channel's epoch number. Content published after rotation is encrypted with the new key, preventing removed admins or compromised keys from decrypting new content.

### Channel Info

Tap the info button on a channel to see:
- Channel name and description.
- Your role (owner, admin, or subscriber).
- Current key epoch.
- Channel rules.
- List of admins.

---

## 9. Groups

Groups are multi-party encrypted conversations. Unlike channels, all group members can send messages to each other.

### Creating a Group

1. Navigate to the **Groups** section from the navigation bar.
2. Tap the **Create Group** button.
3. Enter a group name.
4. Tap **Create**.

A new group is created with a unique ID. You are added as the first member and creator. A sender key is generated for encrypting your messages to the group.

### Inviting Members

1. Open the group detail screen.
2. Tap the **Add Member** button.
3. Select a peer from your contacts.
4. An invitation is sent over your existing 1:1 P2P connection with that peer.

The invitation includes the group metadata and all current sender keys, so the new member can decrypt messages from all existing members.

### Group Messaging

1. Open the group.
2. Type your message in the compose bar.
3. Tap **Send**.

Messages are encrypted with your sender key using ChaCha20-Poly1305 and broadcast to all connected group members over WebRTC mesh connections.

### How Group Connections Work

Groups use a full mesh WebRTC topology:
- Each group member establishes a direct WebRTC data channel with every other member.
- Messages are broadcast to all connected members simultaneously.
- If a member is temporarily disconnected, vector clock-based synchronization ensures they receive missed messages when they reconnect.

### Sender Key Encryption

Each group member has their own symmetric sender key (32 bytes, randomly generated). When you send a message:
1. Your message is encrypted with your sender key using ChaCha20-Poly1305.
2. The encrypted message is sent to all group members.
3. Each member decrypts it using your sender key (which they received during the invitation or key rotation).

When a member leaves the group, keys are rotated for forward secrecy, ensuring the departed member cannot decrypt future messages. Additionally, the departed member's sender key material is explicitly zeroized (wiped from memory and storage) so it cannot be recovered.

### Message Verification

Group messages are validated before processing to prevent abuse:
- **Sequence validation**: Each sender maintains a monotonic sequence counter. Messages with out-of-order or duplicate sequence numbers are rejected, preventing replay attacks.
- **Duplicate detection**: Messages are checked against previously seen identifiers to prevent duplicates from being displayed.
- **Schema validation**: Messages must conform to the expected group message structure before they are processed.
- **Bounded storage**: Group message history is capped to prevent unbounded storage growth.

### Message Ordering

Groups use vector clocks for causal message ordering:
- Each device maintains a sequence counter.
- Vector clocks track the latest sequence number seen from each device.
- When syncing, devices compare vector clocks to determine which messages the other is missing.
- Gap detection identifies lost or out-of-order messages.

### Message Types

Groups support the following message types:
- **Text**: Regular text messages.
- **File**: File attachments.
- **Image**: Image attachments.
- **System**: Automated messages (member joined, member left, etc.).

---

## 10. Contacts

After pairing with a peer, they are added to your trusted contacts. You can manage your contacts from the **Contacts** screen in the navigation bar.

### Contact List

- Contacts are sorted alphabetically by alias or display name.
- Blocked contacts are filtered out of the main list.
- A search bar at the top lets you filter contacts by name (case-insensitive).
- Each contact tile shows:
  - Name (alias if set, otherwise display name).
  - Online status indicator (green dot if online).
  - Last seen timestamp.
  - Connection status.

### Contact Details

Tap on a contact to open their chat. Long press (or open the details screen) to see:
- Avatar with initials.
- Display name and alias.
- Peer ID (monospace format).
- "Trusted since" timestamp (when you first paired).
- Last seen timestamp.

### Setting an Alias

You can set a local alias for any contact:
1. Open the contact detail screen.
2. Edit the alias text field.
3. Tap **Save** to keep the alias, or **Clear** to remove it.

Aliases are stored locally and are not visible to the other person.

### Blocking a Contact

1. Open the contact detail screen (or use the popup menu on the home screen).
2. Tap **Block**.
3. Confirm in the dialog.

Blocked contacts cannot connect to you. They are hidden from your contact list. You can manage blocked contacts in **Settings > Privacy & Security > Blocked Peers**.

### Removing a Contact

1. Open the contact detail screen.
2. Tap **Remove Contact**.
3. Confirm in the dialog. Note: this action is permanent. The contact is deleted from your trusted peers, their chat history is cleared, and the connection is terminated. You will need to re-pair to communicate again.

---

## 11. Settings

Access settings by tapping the **Settings** (gear) icon in the navigation bar. The settings screen is organized into the following sections:

### Profile

- **Display Name**: Change the name that other peers see.
- **Avatar**: Your avatar displays your initials.

### Appearance

- Theme and visual preferences.

### Notifications

Notification settings give you fine-grained control:
- **Do Not Disturb (DND)**: Silence all notifications.
- **Sound**: Toggle notification sounds on/off.
- **Message Preview**: Toggle whether message content appears in notifications.
- **Notification Types**: Enable/disable notifications by category:
  - Message notifications (with optional content preview).
  - Call notifications (high priority, with video indication).
  - Peer status notifications (low priority, online/offline changes).
  - File notifications (shows file name).
- **Muted Peers**: Manage per-peer mute settings.

### Audio and Video (Media Settings)

- **Audio Input**: Select your microphone.
- **Audio Output**: Select your speaker/headphones.
- **Camera**: Preview and select your camera device.
- **Noise Suppression**: Toggle AI-powered noise suppression.
- **Echo Cancellation**: Toggle echo cancellation.
- **Auto Gain Control**: Toggle automatic microphone gain.
- **Background Blur**: Enable video background blur with adjustable strength.

### Privacy and Security

- **Blocked Peers**: View, unblock, or permanently remove blocked users.
- Other privacy controls.

### External Connections

- Linked devices and web client management (see [Web Client](#12-web-client)).

### Debugging

- **Log Export**: Export application logs for troubleshooting. Logs rotate daily (5MB limit, 7-day retention).
- **Real-time Log Viewer**: Stream log entries for live debugging.

### About

- App version, build information, and open source licenses.

### Help

- Opens the in-app knowledge base. See below for details.

### In-App Help

Zajel includes a built-in knowledge base with articles covering:
1. How Zajel Works
2. Your Identity
3. Pairing and Connecting
4. Encryption Explained
5. Data Storage
6. Platform-Specific Notes
7. Troubleshooting

Each article provides detailed explanations with rich text formatting.

---

## 12. Web Client

Zajel has a browser-based web client that links to your mobile device. The web client does not operate independently; it proxies all communication through your phone.

### Linking a Web Browser

1. Open the web client in your browser.
2. The web client displays a QR code.
3. On your phone, go to **Settings > External Connections** or the **Connect** screen and switch to the **Link Browser** tab.
4. Scan the QR code with your phone, or enter the link code manually.
5. A link request appears on your phone showing the device details and key fingerprint. Review and **Approve** the request.
6. The web session is established with a 5-minute expiration for the initial pairing window.

### How It Works

The web client creates a WebRTC tunnel through your mobile app:
- Your phone acts as a bridge between the web browser and your peers.
- Messages from the web client are routed through your phone's existing P2P connections.
- The web client has access to the same conversations and contacts as your phone.

### Managing Linked Devices

In **Settings > External Connections > Linked Devices**, you can:
- View all linked web devices.
- See each device's connection status (online/offline).
- **Revoke** a linked device to disconnect it permanently.

---

## 13. Security

Zajel has undergone a comprehensive security audit covering 94 issues across all packages (client, servers, and website). The following sections describe the security properties you benefit from as a user.

### Encryption

Zajel uses the following cryptographic primitives:

| Component | Algorithm | Purpose |
|-----------|-----------|---------|
| Key Exchange | X25519 (Curve25519 ECDH) | Establish shared secrets between peers |
| Session Key Derivation | HKDF (HMAC-based Key Derivation) | Derive session-specific encryption keys from shared secret |
| Message Encryption | ChaCha20-Poly1305 (AEAD) | Authenticated encryption of messages and files |
| Channel Signing | Ed25519 | Sign channel manifests and content chunks |
| Channel Encryption | X25519 + ChaCha20-Poly1305 | Encrypt channel content for subscribers |
| Group Encryption | ChaCha20-Poly1305 | Sender key-based group message encryption |
| Fingerprinting | SHA-256 | Generate public key fingerprints for verification |
| Channel ID Derivation | SHA-256 (truncated 128-bit) | Derive channel IDs from owner public keys |

### Replay Protection

All encrypted communication channels include replay protection:
- **1:1 messages**: Each message includes a monotonically increasing sequence number. A sliding window mechanism rejects duplicate or out-of-order messages, preventing an attacker from recording and retransmitting your encrypted messages.
- **Group messages**: Each sender maintains a per-device sequence counter. Messages with duplicate or out-of-order sequence numbers are rejected.
- **Channel chunks**: Channel content chunks include sequence validation to detect and reject replayed content.

### Forward Secrecy

Each session uses ephemeral keys. When you connect with a peer, a new session key is established via X25519 ECDH key exchange. Previous session keys are not reused. In groups, sender keys are rotated when members leave, and the departed member's key material is explicitly zeroized (wiped from memory and storage).

### Secure Key Management

Zajel protects your cryptographic keys at every stage:
- **Keys encrypted at rest**: Session keys are encrypted with ChaCha20-Poly1305 before being persisted to secure storage, providing defense-in-depth even if platform secure storage is compromised.
- **Secure storage**: Private keys are stored in your device's platform secure storage (Keychain on iOS/macOS, Keystore on Android, platform-specific secure storage on desktop).
- **Key zeroization**: When you leave a group, your sender key material is explicitly wiped from memory and storage so it cannot be recovered.
- **Key binding**: Session keys are derived using both peers' public keys as salt, binding the key to the specific peer pair and preventing man-in-the-middle key substitution.

### File Transfer Security

- Each file transfer includes a **SHA-256 integrity hash**. The recipient verifies that the reassembled file matches the expected hash, detecting corruption or tampering.
- Incoming file transfers are validated against **size limits** to prevent resource exhaustion.
- File names are sanitized to prevent **path traversal attacks** (malicious file names that attempt to write outside the download directory).
- Files are encrypted per-chunk with ChaCha20-Poly1305 before transmission.

### Fingerprint Verification

To verify that you are communicating with the correct person (and not a man-in-the-middle):

1. Open a chat with the peer.
2. Tap the peer's name or info button to open the peer information sheet.
3. Expand the **Fingerprint Verification** section.
4. Compare your fingerprint and the peer's fingerprint with each other through a trusted out-of-band channel (in person, phone call, etc.).
5. If the fingerprints match, you can confirm the connection is secure.

Each fingerprint is a SHA-256 hash of the X25519 public key, displayed in monospace hexadecimal format. You can copy fingerprints to the clipboard.

### Connection Security

- **WebSocket reconnection**: If your connection to the signaling server drops, Zajel automatically reconnects with exponential backoff, maintaining your session continuity.
- **Peer identity verification**: When reconnecting with an existing peer, their cryptographic identity is verified against the stored public key to detect impersonation attempts.
- **TLS certificate pinning**: On native platforms (Android, iOS, desktop), WebSocket connections use certificate pinning to prevent TLS interception by compromised certificate authorities.
- **Input validation**: All incoming messages and signaling data are validated against strict schemas before processing.

### Channel Invite Link Security

Channel invite links contain only the content decryption key and the signed channel manifest. They never expose the channel's private signing key. This means:
- Anyone with the link can read channel content (subscriber access).
- Only the channel owner and authorized admins can publish content (signing authority is not shared in the link).
- The manifest signature is verified upon subscription, preventing tampered invite links.

### Zero-Knowledge Server

The signaling server facilitates peer discovery and WebRTC negotiation but:
- Never sees your messages (they are encrypted end-to-end before reaching the WebRTC data channel).
- Never stores your messages.
- Does not know your identity beyond a temporary pairing code.
- Cannot decrypt any content.

For channels, the relay server temporarily caches encrypted chunks (30-minute TTL) but cannot decrypt them because it does not have the channel's encryption key.

### Resource Limits and Abuse Prevention

Zajel enforces resource limits across all server endpoints to prevent abuse:
- **Rate limiting**: Server endpoints enforce per-client rate limits to prevent denial-of-service attacks.
- **Connection limits**: The number of simultaneous WebSocket connections per server is bounded.
- **Input size limits**: All HTTP and WebSocket message payloads are validated against size limits.
- **Storage bounds**: Server-side registries (rendezvous, relay, chunk cache) enforce maximum entry limits with eviction policies.
- **Bounded client storage**: Group message history and channel chunk caches are capped to prevent unbounded growth on your device.

### Server Attestation

Zajel verifies the identity of signaling servers using the bootstrap registry:
- Server responses are signed with Ed25519.
- The app verifies signatures against known public keys.
- Responses include timestamps; stale responses are rejected.
- This prevents connection to rogue servers.

### App Attestation

Zajel includes anti-tamper protections:
- Build token registration with the bootstrap server.
- Dynamic binary attestation challenges using HMAC-SHA256 with constant-time comparison.
- Session tokens with 1-hour expiration.
- Version policy enforcement (minimum version, recommended updates, blocked versions).
- Detection of debuggers, rooted/jailbroken devices, and emulators.

### Server-Side Security

The signaling and relay servers are hardened with:
- **Strict CORS policies**: Only allowed origins can access server APIs (no wildcard CORS).
- **Authenticated server registration**: VPS servers must authenticate with Ed25519 signatures to join the federation.
- **Content Security Policy**: The website enforces CSP headers to prevent cross-site scripting (XSS) attacks.
- **Security headers**: All server responses include standard security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, etc.).
- **Constant-time comparisons**: All cryptographic secret comparisons use constant-time algorithms to prevent timing attacks.
- **Error message sanitization**: Server error responses do not leak internal implementation details.

---

## 14. Privacy

### No Accounts Required

Zajel does not require:
- A phone number.
- An email address.
- A username or password.
- Any personal information.

Your identity is a cryptographic keypair generated on your device.

### What Data Is Stored Where

| Data | Location | Details |
|------|----------|---------|
| Identity keys (private) | Device secure storage | Keychain (iOS/macOS), Keystore (Android), platform-specific on desktop |
| Identity keys (public) | Shared with peers during pairing | Used for encryption and verification |
| Messages | Device local storage (SQLite) | Stored only on the sender's and recipient's devices |
| Files | Device local storage | Received files are saved to the device's file system |
| Trusted peers | Device local storage + secure storage | Peer public keys in secure storage, metadata in SQLite |
| Channel data | Device local storage (SQLite) | Channel manifests, encrypted chunks, keys in secure storage |
| Group data | Device local storage (SQLite) | Group metadata, encrypted messages, sender keys in secure storage |
| Display name | Device local storage | Transmitted to peers but not stored on any server |
| Pairing codes | Signaling server (temporary) | Ephemeral; discarded when the session ends |
| Meeting point hashes | Signaling server (48-hour TTL) | Deterministic hashes, not personally identifiable |
| Encrypted dead drops | Signaling server (48-hour TTL) | Encrypted connection info; server cannot decrypt |
| Channel chunks (cache) | Relay server (30-minute TTL) | Encrypted; server cannot decrypt |

### What Is NOT Stored Anywhere

- Your messages are never stored on a server.
- Your files are never uploaded to a server.
- Your contact list is never shared with a server.
- No analytics, telemetry, or usage data is collected.
- No IP address logging beyond what is necessary for active WebSocket connections.

### Blocking and Data Deletion

- Blocking a peer prevents them from connecting to you.
- Removing a contact permanently deletes their data from your device.
- Clearing all data wipes your identity, messages, contacts, channels, and groups. This is irreversible.

---

## 15. Troubleshooting

### Cannot connect to signaling server

1. **Check your internet connection.** Zajel requires internet access to reach the signaling server.
2. **Check firewall rules.** Ensure outbound WebSocket connections (WSS, port 443) are not blocked.
3. **Restart the app.** This forces a fresh connection to the signaling server and triggers server rediscovery.
4. **Check for updates.** If you are running a version below the minimum required, you may be blocked from connecting. The app will show an update prompt.

### Peer not appearing after entering pairing code

1. **Verify the code is correct.** Pairing codes are 6 characters, alphanumeric, uppercase.
2. **Ensure both devices are connected to the signaling server.** Both users must see their own pairing code displayed before attempting to connect.
3. **Try a fresh code.** Reconnect to the signaling server to get a new pairing code.
4. **Check that neither user has blocked the other.**

### Messages not sending

1. **Check connection status.** The peer must show as "Connected" (green status). If they are offline, messages will be queued.
2. **Wait for the cryptographic handshake.** After a WebRTC connection is established, a key exchange must complete before messages can be encrypted and sent.
3. **Check for a "Peer is offline" banner.** If displayed, your messages will be queued and sent when the peer reconnects.

### Call not connecting

1. **Ensure both peers are connected.** Voice and video calls require an active WebRTC connection.
2. **Check media permissions.** The app needs microphone permission for voice calls and camera permission for video calls.
3. **Check firewall/NAT.** WebRTC uses STUN servers to traverse NAT. If you are behind a restrictive firewall, calls may fail to establish.
4. **Wait for the timeout.** If a call is not answered within 60 seconds, it automatically ends.

### Channel content not syncing

1. **Check your internet connection.** Channel sync requires a connection to the relay server.
2. **Wait for periodic sync.** Background sync runs every 5 minutes by default.
3. **Verify your invite link is valid.** If the channel manifest signature is invalid, subscription will fail.
4. **Check if the channel encryption key has been rotated.** If you were removed as an admin, you will not be able to decrypt new content.

### Audio/video issues during calls

1. **Check device selection in Settings > Audio & Video.** Ensure the correct microphone, speaker, and camera are selected.
2. **Toggle noise suppression.** If audio is distorted, try disabling noise suppression.
3. **Toggle echo cancellation.** If you hear echo, enable echo cancellation.
4. **Switch cameras.** On mobile, use the camera switch button to toggle between front and back cameras.

### Exporting logs for debugging

1. Go to **Settings > Debugging**.
2. Tap **Export Logs**.
3. On mobile, logs are shared via the system share sheet. On desktop, you can save them to a directory.
4. Logs rotate daily, have a 5MB size limit, and are retained for 7 days.

---

## 16. FAQ

**Q: Does Zajel work over the internet?**
A: Yes. Zajel uses signaling servers to help peers discover each other and establish connections over the internet. After the initial connection setup, communication flows directly between devices via WebRTC.

**Q: Do I need a phone number or email to use Zajel?**
A: No. Zajel does not require any personal information. Your identity is a cryptographic keypair generated on your device.

**Q: Is my data stored on any server?**
A: Messages and files are stored only on your device and the recipient's device. The signaling server temporarily holds pairing codes and encrypted meeting point data but cannot read any of it. Channel relay servers temporarily cache encrypted chunks that they cannot decrypt.

**Q: What happens if I uninstall the app?**
A: Your cryptographic identity is permanently lost. All your contacts will need to re-pair with you. There is no recovery mechanism. Your messages stored on other people's devices will remain, but you will not be able to access your own message history.

**Q: Can I use Zajel on multiple devices?**
A: You can link a web browser to your phone using the web client feature. The web client operates through your phone, so your phone must be online. Each installation on a separate device gets its own identity and must pair independently.

**Q: What encryption does Zajel use?**
A: Zajel uses X25519 for key exchange, HKDF for key derivation, and ChaCha20-Poly1305 for authenticated encryption. Channel content is additionally signed with Ed25519. Group messages use sender key encryption with ChaCha20-Poly1305.

**Q: What is the maximum file size I can send?**
A: Files are chunked into 16KB encrypted segments and sent over WebRTC data channels. There is no hard file size limit, but very large files may take time to transfer over a peer-to-peer connection.

**Q: Can someone intercept my messages?**
A: Messages are end-to-end encrypted. Even if someone intercepted the encrypted data (on the network or at the signaling server), they could not decrypt it without your private key. You can verify your connection is not being intercepted by comparing fingerprints with your peer through an out-of-band channel. Additionally, replay protection prevents an attacker from recording and retransmitting your messages.

**Q: Has Zajel been security audited?**
A: Yes. Zajel underwent a comprehensive security audit covering 94 issues across all packages (mobile/desktop app, signaling servers, headless client, and website). The audit addressed issues from critical to low severity, including encryption hardening, replay protection, input validation, rate limiting, secure key management, and server-side security. For details, see the [Security Architecture](https://github.com/Hamza-Labs-Core/zajel/wiki/Security-Architecture) wiki page.

**Q: What is a channel vs. a group?**
A: A **channel** is a one-to-many broadcast. The owner (and appointed admins) publish content that subscribers receive. Subscribers can send replies, votes, and reactions to the owner if the channel rules allow it. A **group** is a many-to-many conversation where all members can send and receive messages equally.

**Q: How do I verify I am talking to the right person?**
A: Open the chat, tap the peer info button, and expand the fingerprint verification section. Compare the displayed fingerprints with your peer through a trusted channel (in person, phone call). If they match, the connection is authentic.

**Q: What happens if I lose my internet connection during a call?**
A: The call will attempt to reconnect for 10 seconds. If reconnection fails, the call ends. You can initiate a new call once your connection is restored.

**Q: Can the signaling server read my messages?**
A: No. The signaling server only facilitates the initial connection setup (exchanging WebRTC session descriptions and ICE candidates). It never sees your message content. All messages are encrypted end-to-end and sent directly between devices.

---

## 17. Keyboard Shortcuts

The following keyboard shortcuts are available on desktop platforms (Linux, Windows, macOS):

| Shortcut | Action |
|----------|--------|
| Enter | Send message |
| Shift+Enter | Insert a new line in the message |

---

## Support

- **Issues**: [GitHub Issues](https://github.com/Hamza-Labs-Core/zajel/issues)
- **Discussions**: [GitHub Discussions](https://github.com/Hamza-Labs-Core/zajel/discussions)
- **In-App Help**: Access the knowledge base from Settings > Help
