import type { MetaFunction } from "react-router";
import { Link } from "react-router";
import { Nav } from "~/components/Nav";
import { Footer } from "~/components/Footer";

export const meta: MetaFunction = () => {
  return [
    { title: "User Guide - Zajel" },
    { name: "description", content: "Learn how to use Zajel for secure peer-to-peer messaging" },
    { property: "og:title", content: "User Guide - Zajel" },
    { property: "og:description", content: "Learn how to use Zajel for secure peer-to-peer messaging" },
    { property: "og:type", content: "article" },
    { property: "og:url", content: "https://zajel.app/guide" },
    { property: "og:image", content: "https://zajel.app/og-image.png" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: "User Guide - Zajel" },
    { name: "twitter:description", content: "Learn how to use Zajel for secure peer-to-peer messaging" },
    { name: "twitter:image", content: "https://zajel.app/og-image.png" },
  ];
};

export default function Guide() {
  return (
    <>
      <Nav />

      <div className="guide-container">
        <h1>User Guide</h1>
        <p>
          Zajel is a peer-to-peer encrypted messaging app that allows you to communicate securely
          with others on the same local network without any central server.
        </p>

        {/* Table of Contents */}
        <div className="guide-nav">
          <h4>Contents</h4>
          <ul>
            <li>
              <a href="#getting-started">Getting Started</a>
            </li>
            <li>
              <a href="#features">Features</a>
            </li>
            <li>
              <a href="#troubleshooting">Troubleshooting</a>
            </li>
            <li>
              <a href="#security">Security</a>
            </li>
            <li>
              <a href="#faq">FAQ</a>
            </li>
          </ul>
        </div>

        <h2 id="getting-started">Getting Started</h2>

        <h3>Installation</h3>
        <p>
          Download Zajel for your platform from the <Link to="/#download">download section</Link> or
          build from source:
        </p>

        <ul>
          <li>
            <strong>Android</strong> - Install the APK from GitHub Releases
          </li>
          <li>
            <strong>iOS</strong> - Build from source with <code>flutter build ios</code>
          </li>
          <li>
            <strong>Windows</strong> - Download ZIP or MSIX from Releases
          </li>
          <li>
            <strong>macOS</strong> - Download DMG from Releases
          </li>
          <li>
            <strong>Linux</strong> - Download tarball from Releases
          </li>
        </ul>

        <h2 id="features">Features</h2>

        <h3>1. Automatic Peer Discovery</h3>
        <p>
          When you open Zajel, it automatically discovers other Zajel users on your local network
          using mDNS (multicast DNS). You'll see them appear in the peers list on the home screen.
        </p>
        <ul>
          <li>Your device broadcasts its presence on the network</li>
          <li>Other devices running Zajel will appear in your peer list</li>
          <li>No manual IP address entry required</li>
        </ul>

        <h3>2. Connecting to Peers</h3>
        <p>To connect with a discovered peer:</p>
        <ol>
          <li>Open Zajel on both devices</li>
          <li>Wait for peer discovery (peers appear in the list)</li>
          <li>
            Tap the <strong>Connect</strong> button next to a peer
          </li>
          <li>Wait for the connection to establish</li>
        </ol>

        <p>
          <strong>Connection States:</strong>
        </p>
        <ul>
          <li>
            🔴 <strong>Disconnected</strong> - Not connected to the peer
          </li>
          <li>
            🟡 <strong>Connecting</strong> - Connection in progress
          </li>
          <li>
            🟢 <strong>Connected</strong> - Ready to send messages
          </li>
        </ul>

        <h3>3. Sending Messages</h3>
        <p>Once connected:</p>
        <ol>
          <li>Tap on a connected peer to open the chat</li>
          <li>Type your message in the text field</li>
          <li>Tap the send button</li>
        </ol>
        <p>
          <strong>All messages are end-to-end encrypted</strong> using X25519 key exchange and
          ChaCha20-Poly1305 encryption.
        </p>

        <h3>4. Sending Files</h3>
        <p>To send a file:</p>
        <ol>
          <li>Open a chat with a connected peer</li>
          <li>Tap the attachment button (📎)</li>
          <li>Select a file from your device</li>
          <li>The file will be chunked, encrypted, and sent</li>
        </ol>

        <h3>5. Changing Your Display Name</h3>
        <ol>
          <li>Go to Settings (gear icon)</li>
          <li>Tap on your profile</li>
          <li>Enter your preferred name</li>
          <li>Tap Save</li>
        </ol>
        <p>This name is what other peers will see when they discover you.</p>

        <h3>6. Blocking Users</h3>
        <p>To block a user:</p>
        <ol>
          <li>On the home screen, tap the three-dot menu on a peer card</li>
          <li>Select "Block"</li>
          <li>Confirm the action</li>
        </ol>
        <p>
          Blocked users won't be able to connect to you. Manage blocked users in Settings &gt;
          Blocked Users.
        </p>

        <h2 id="troubleshooting">Troubleshooting</h2>

        <h3>Peers not appearing?</h3>
        <ol>
          <li>
            <strong>Check you're on the same network</strong> - Both devices must be on the same
            local network (WiFi or LAN)
          </li>
          <li>
            <strong>Check firewall</strong> - Ensure mDNS (port 5353 UDP) and the signaling port are
            not blocked
          </li>
          <li>
            <strong>Restart the app</strong> - Sometimes mDNS discovery needs a restart
          </li>
        </ol>

        <h3>Connection failing?</h3>
        <ol>
          <li>
            <strong>Ensure both devices have the app open</strong> - The peer must be actively
            running Zajel
          </li>
          <li>
            <strong>Check network connectivity</strong> - Ping the other device to ensure network is
            working
          </li>
          <li>
            <strong>Try restarting both apps</strong> - This refreshes the WebRTC connections
          </li>
        </ol>

        <h3>Messages not sending?</h3>
        <ol>
          <li>
            <strong>Check connection status</strong> - Ensure the peer shows as "Connected"
          </li>
          <li>
            <strong>Wait for handshake</strong> - The cryptographic handshake must complete before
            messages can be sent
          </li>
        </ol>

        <h2 id="security">Security</h2>

        <p>Zajel uses strong encryption:</p>
        <ul>
          <li>
            <strong>Key Exchange</strong>: X25519 (Curve25519 ECDH)
          </li>
          <li>
            <strong>Message Encryption</strong>: ChaCha20-Poly1305
          </li>
          <li>
            <strong>No Central Server</strong>: All communication is peer-to-peer
          </li>
          <li>
            <strong>Forward Secrecy</strong>: Each session uses unique keys
          </li>
        </ul>

        <p>
          Your messages are never stored on any server - they go directly from your device to the
          recipient's device.
        </p>

        <h3>Architecture</h3>
        <pre>{`┌─────────────────┐                    ┌─────────────────┐
│    Device A     │                    │    Device B     │
├─────────────────┤                    ├─────────────────┤
│  mDNS Discovery │◄──── WiFi LAN ────►│  mDNS Discovery │
│                 │                    │                 │
│  WebRTC P2P     │◄──── Encrypted ───►│  WebRTC P2P     │
│  Data Channel   │      Messages      │  Data Channel   │
└─────────────────┘                    └─────────────────┘`}</pre>

        <h2 id="faq">FAQ</h2>

        <p>
          <strong>Q: Does Zajel work over the internet?</strong>
        </p>
        <p>
          A: Yes! Enable "External Connections" in Settings to connect with peers outside your local
          network using a signaling server.
        </p>

        <p>
          <strong>Q: Is my data stored anywhere?</strong>
        </p>
        <p>
          A: Messages are stored locally on your device only. The signaling server only facilitates
          connection setup - it never sees your messages.
        </p>

        <p>
          <strong>Q: Can I use Zajel without WiFi?</strong>
        </p>
        <p>
          A: For local connections, both devices need to be on the same network (WiFi, Ethernet, or
          mobile hotspot). For external connections, you need internet access.
        </p>

        <p>
          <strong>Q: What happens if I lose connection?</strong>
        </p>
        <p>
          A: You'll need to reconnect. Messages sent while disconnected won't be delivered (no
          offline messaging yet).
        </p>

        <h2>Support</h2>
        <ul>
          <li>
            <strong>Issues</strong>:{" "}
            <a
              href="https://github.com/Hamza-Labs-Core/zajel/issues"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub Issues
            </a>
          </li>
          <li>
            <strong>Discussions</strong>:{" "}
            <a
              href="https://github.com/Hamza-Labs-Core/zajel/discussions"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub Discussions
            </a>
          </li>
        </ul>
      </div>

      <Footer />
    </>
  );
}
