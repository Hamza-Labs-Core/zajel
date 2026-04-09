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
    { property: "og:image", content: "https://zajel.qa.hamzalabs.dev/og-image.png" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: "User Guide - Zajel" },
    { name: "twitter:description", content: "Learn how to use Zajel for secure peer-to-peer messaging" },
    { name: "twitter:image", content: "https://zajel.qa.hamzalabs.dev/og-image.png" },
  ];
};

export default function Guide() {
  return (
    <>
      <Nav />

      <div className="guide-container">
        <h1>User Guide</h1>
        <p>
          Zajel is a peer-to-peer encrypted messaging app. Connect with anyone using a
          6-character pairing code — no account, phone number, or email required.
        </p>

        <div className="guide-nav">
          <h4>Contents</h4>
          <ul>
            <li><a href="#getting-started">Getting Started</a></li>
            <li><a href="#pairing">Connecting with a Peer</a></li>
            <li><a href="#messaging">Messaging</a></li>
            <li><a href="#channels">Channels</a></li>
            <li><a href="#groups">Groups</a></li>
            <li><a href="#calls">Voice & Video Calls</a></li>
            <li><a href="#files">File Sharing</a></li>
            <li><a href="#settings">Settings</a></li>
            <li><a href="#security">Security</a></li>
            <li><a href="#faq">FAQ</a></li>
          </ul>
        </div>

        <h2 id="getting-started">Getting Started</h2>

        <h3>Installation</h3>
        <p>
          Download Zajel for your platform from the{" "}
          <Link to="/#download">download section</Link>:
        </p>
        <ul>
          <li><strong>Android</strong> — APK from GitHub Releases (Play Store coming soon)</li>
          <li><strong>iOS</strong> — IPA from Releases (App Store coming soon)</li>
          <li><strong>Windows</strong> — ZIP from Releases (extract and run)</li>
          <li><strong>macOS</strong> — DMG from Releases</li>
          <li><strong>Linux</strong> — AppImage, .deb, or tarball from Releases</li>
        </ul>

        <h3>First Launch</h3>
        <p>
          When you open Zajel for the first time, the app generates your encryption keys
          and connects to a signaling server. You'll see your <strong>pairing code</strong> — a
          6-character code like <code>A7X2M9</code> — displayed on the home screen. Share this
          code with someone to connect.
        </p>

        <h2 id="pairing">Connecting with a Peer</h2>

        <h3>How Pairing Works</h3>
        <p>
          Zajel uses pairing codes to establish connections. Each device gets a unique
          6-character code when it connects to the signaling server. To connect with someone:
        </p>
        <ol>
          <li>Share your pairing code with the other person (via any channel — text, email, in person)</li>
          <li>They enter your code in the app (or you enter theirs)</li>
          <li>Both sides approve the connection request</li>
          <li>A direct encrypted P2P connection is established via WebRTC</li>
        </ol>

        <h3>Trusted Peers</h3>
        <p>
          Once paired, the peer is saved as a <strong>trusted contact</strong>. On future app launches,
          Zajel automatically reconnects with your trusted peers using a rendezvous system — no
          need to re-enter pairing codes. The rendezvous uses blinded tokens so the server
          never learns who your contacts are.
        </p>

        <h2 id="messaging">Messaging</h2>

        <p>Once connected to a peer:</p>
        <ol>
          <li>Tap the peer to open the conversation</li>
          <li>Type your message and tap send</li>
          <li>Messages are encrypted end-to-end and travel directly between devices</li>
        </ol>
        <p>
          Messages are stored locally on your device. The signaling server never sees
          message content — it only helps establish the P2P connection.
        </p>

        <h2 id="channels">Channels</h2>

        <p>
          Channels are broadcast feeds — one owner publishes, subscribers receive. Useful for
          announcements, news feeds, or one-to-many communication.
        </p>
        <ol>
          <li>Create a channel from the Channels tab</li>
          <li>Share the channel with peers — they can subscribe</li>
          <li>Publish messages that all subscribers receive</li>
        </ol>
        <p>Channel messages are encrypted and delivered via the signaling relay.</p>

        <h2 id="groups">Groups</h2>

        <p>
          Groups are multi-party conversations where all members can send and receive messages.
        </p>
        <ol>
          <li>Create a group from the Groups tab</li>
          <li>Add members from your trusted contacts</li>
          <li>All members can send messages to the group</li>
        </ol>

        <h2 id="calls">Voice & Video Calls</h2>

        <p>
          Make encrypted voice and video calls over the P2P connection:
        </p>
        <ol>
          <li>Open a conversation with a connected peer</li>
          <li>Tap the phone or video icon</li>
          <li>The peer receives a call notification and can accept or decline</li>
        </ol>
        <p>
          Calls use WebRTC with the same end-to-end encryption as messages. Audio and video
          travel directly between devices.
        </p>

        <h2 id="files">File Sharing</h2>

        <p>Send files of any type securely:</p>
        <ol>
          <li>Open a chat with a connected peer</li>
          <li>Tap the attachment button (📎)</li>
          <li>Select a file from your device</li>
          <li>The file is chunked, encrypted, and sent over the P2P data channel</li>
        </ol>

        <h2 id="settings">Settings</h2>

        <ul>
          <li><strong>Display Name</strong> — Set the name others see when you connect</li>
          <li><strong>Notifications</strong> — Configure sounds, DND, and per-peer muting</li>
          <li><strong>Blocked Peers</strong> — Manage blocked contacts</li>
          <li><strong>Updates</strong> (desktop) — Check for updates, enable auto-download</li>
          <li><strong>Server URL</strong> — Change the bootstrap/signaling server</li>
        </ul>

        <h2 id="security">Security</h2>

        <p>Zajel uses strong modern cryptography:</p>
        <ul>
          <li><strong>Key Exchange</strong> — X25519 (Curve25519 ECDH) per session</li>
          <li><strong>Message Encryption</strong> — ChaCha20-Poly1305 AEAD</li>
          <li><strong>Identity</strong> — Ed25519 signing keys for peer authentication</li>
          <li><strong>Forward Secrecy</strong> — Each session uses fresh ephemeral keys</li>
          <li><strong>No Account</strong> — No phone number, email, or personal info required</li>
        </ul>

        <h3>Architecture</h3>
        <pre>{`┌──────────────┐    Signaling     ┌──────────────┐
│   Device A   │◄──── Server ────►│   Device B   │
│              │   (pairing only) │              │
│  Pairing:    │                  │  Pairing:    │
│  A7X2M9      │                  │  K3P8N2      │
├──────────────┤                  ├──────────────┤
│  WebRTC P2P  │◄═══ Encrypted ══►│  WebRTC P2P  │
│  Data Channel│    Direct Link   │  Data Channel│
└──────────────┘                  └──────────────┘

  The signaling server only helps devices find each other.
  All messages, calls, and files go directly peer-to-peer.`}</pre>

        <h2 id="faq">FAQ</h2>

        <p><strong>Q: Do I need an account?</strong></p>
        <p>
          A: No. Zajel generates encryption keys locally on your device. There's no signup,
          no phone number, and no email. You're identified by your public key.
        </p>

        <p><strong>Q: Does Zajel work over the internet?</strong></p>
        <p>
          A: Yes. Zajel uses signaling servers to discover peers and TURN relay servers when
          direct P2P connections aren't possible (e.g., behind strict NATs).
        </p>

        <p><strong>Q: Is my data stored on any server?</strong></p>
        <p>
          A: Messages are stored only on your device. The signaling server handles connection
          setup and never sees message content. Relay servers (TURN) forward encrypted
          traffic when needed but cannot decrypt it.
        </p>

        <p><strong>Q: What happens if I lose connection?</strong></p>
        <p>
          A: When you reopen the app, Zajel automatically reconnects with your trusted peers
          via the rendezvous system. Messages sent while offline aren't delivered — both peers
          need to be online for real-time communication.
        </p>

        <p><strong>Q: Can I self-host the signaling server?</strong></p>
        <p>
          A: Yes. The VPS signaling server is open source. You can run your own and point
          the app to it via Settings &gt; Server URL. Servers federate automatically via the
          SWIM gossip protocol.
        </p>

        <h2>Support</h2>
        <ul>
          <li>
            <strong>Issues</strong>:{" "}
            <a href="https://github.com/Hamza-Labs-Core/zajel/issues" target="_blank" rel="noopener noreferrer">
              GitHub Issues
            </a>
          </li>
          <li>
            <strong>Wiki</strong>:{" "}
            <Link to="/wiki/en">Developer Documentation</Link>
          </li>
        </ul>
      </div>

      <Footer />
    </>
  );
}
