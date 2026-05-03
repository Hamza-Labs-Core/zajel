import { useMemo, useState } from "react";
import type { MetaFunction } from "react-router";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Nav } from "~/components/Nav";
import { Footer } from "~/components/Footer";

const darkFlowStyles = `
.react-flow__controls {
  background: #1e293b !important;
  border: 1px solid #475569 !important;
  border-radius: 8px !important;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4) !important;
}
.react-flow__controls button {
  background: #1e293b !important;
  border-color: #475569 !important;
  fill: #f8fafc !important;
}
.react-flow__controls button:hover { background: #334155 !important; }
.react-flow__controls button svg { fill: #f8fafc !important; }
.react-flow__minimap {
  background: #0f172a !important;
  border: 1px solid #475569 !important;
  border-radius: 8px !important;
}
.react-flow__minimap-mask { fill: rgba(15, 23, 42, 0.7) !important; }
.react-flow__edge-text { fill: #94a3b8 !important; font-size: 11px !important; }
.react-flow__edge-textbg { fill: #0f172a !important; }
.react-flow__panel { margin: 8px !important; }
`;

export const meta: MetaFunction = () => [
  { title: "Architecture - Zajel" },
  {
    name: "description",
    content: "Zajel system architecture — signaling, P2P, encryption, federation",
  },
];

// ── Custom Nodes ──────────────────────────────────────────

const handles = (color: string) => (
  <>
    <Handle type="source" position={Position.Right} style={{ background: color }} />
    <Handle type="target" position={Position.Left} style={{ background: color }} />
    <Handle type="source" position={Position.Bottom} id="b" style={{ background: color }} />
    <Handle type="target" position={Position.Top} id="t" style={{ background: color }} />
  </>
);

function DeviceNode({ data }: { data: Record<string, string> }) {
  return (
    <div style={{ background: "#1e293b", border: "2px solid #6366f1", borderRadius: 12, padding: "14px 18px", color: "#f8fafc", width: 180, textAlign: "center" }}>
      {handles("#6366f1")}
      <div style={{ fontSize: 26 }}>{data.icon}</div>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{data.label}</div>
      <div style={{ color: "#94a3b8", fontSize: 10, marginTop: 2 }}>{data.detail}</div>
    </div>
  );
}
function ServerNode({ data }: { data: Record<string, string> }) {
  return (
    <div style={{ background: "#0f172a", border: "2px solid #22c55e", borderRadius: 12, padding: "14px 18px", color: "#f8fafc", width: 190, textAlign: "center" }}>
      {handles("#22c55e")}
      <div style={{ fontSize: 26 }}>{data.icon}</div>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{data.label}</div>
      <div style={{ color: "#94a3b8", fontSize: 10, marginTop: 2 }}>{data.detail}</div>
    </div>
  );
}
function CloudNode({ data }: { data: Record<string, string> }) {
  return (
    <div style={{ background: "#0f172a", border: "2px solid #eab308", borderRadius: 12, padding: "14px 18px", color: "#f8fafc", width: 200, textAlign: "center" }}>
      {handles("#eab308")}
      <div style={{ fontSize: 26 }}>{data.icon}</div>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{data.label}</div>
      <div style={{ color: "#94a3b8", fontSize: 10, marginTop: 2 }}>{data.detail}</div>
    </div>
  );
}
function StepNode({ data }: { data: Record<string, string> }) {
  const c = data.color || "#94a3b8";
  return (
    <div style={{ background: "#1e293b", border: `2px solid ${c}`, borderRadius: 8, padding: "10px 14px", color: "#f8fafc", width: 170, textAlign: "center" }}>
      {handles(c)}
      <div style={{ fontWeight: 700, fontSize: 12, color: c }}>{data.label}</div>
      <div style={{ color: "#94a3b8", fontSize: 10, marginTop: 2 }}>{data.detail}</div>
    </div>
  );
}

const nodeTypes: NodeTypes = { device: DeviceNode, server: ServerNode, cloud: CloudNode, step: StepNode };
const measured = { width: 190, height: 80 };

// ── Diagrams ──────────────────────────────────────────────

type DiagramKey = "overview" | "discovery" | "connection" | "encryption" | "federation";

interface DiagramDef {
  title: string;
  description: string;
  detail: string;
  nodes: Node[];
  edges: Edge[];
}

const edge = (id: string, src: string, tgt: string, label: string, color: string, opts?: Partial<Edge>): Edge => ({
  id, source: src, target: tgt, label, style: { stroke: color }, type: "smoothstep", ...opts,
});
const anim = (id: string, src: string, tgt: string, label: string, color: string, opts?: Partial<Edge>): Edge => ({
  ...edge(id, src, tgt, label, color, opts), animated: true,
});
const dash = (id: string, src: string, tgt: string, label: string, color: string, opts?: Partial<Edge>): Edge => ({
  ...edge(id, src, tgt, label, color, opts), style: { stroke: color, strokeDasharray: "6 3" },
});

const diagrams: Record<DiagramKey, DiagramDef> = {
  // ─── 1. SYSTEM OVERVIEW ───────────────────────────────
  overview: {
    title: "System Overview",
    description: "The high-level architecture showing all major components and how they interact.",
    detail: "Clients (mobile & desktop) discover VPS signaling servers via the Bootstrap CF Worker, then connect over WebSocket. Once paired, peers communicate directly via WebRTC data channels. VPS servers federate with each other using the SWIM gossip protocol. Cloudflare Workers handle server registry, diagnostics collection, and the admin dashboard.",
    nodes: [
      // Left column: clients
      { id: "mobile", type: "device", position: { x: 0, y: 0 }, measured, data: { label: "Mobile App", detail: "Android / iOS", icon: "\uD83D\uDCF1" } },
      { id: "desktop", type: "device", position: { x: 0, y: 220 }, measured, data: { label: "Desktop App", detail: "Win / macOS / Linux", icon: "\uD83D\uDDA5\uFE0F" } },
      // Center: signaling
      { id: "vps1", type: "server", position: { x: 280, y: 0 }, measured, data: { label: "VPS Server 1", detail: "Signaling + TURN relay", icon: "\uD83D\uDCE1" } },
      { id: "vps2", type: "server", position: { x: 280, y: 220 }, measured, data: { label: "VPS Server 2", detail: "Signaling + TURN relay", icon: "\uD83D\uDCE1" } },
      // Right column: cloud services
      { id: "bootstrap", type: "cloud", position: { x: 570, y: -60 }, measured, data: { label: "Bootstrap Registry", detail: "CF Worker \u2022 server discovery", icon: "\u2601\uFE0F" } },
      { id: "diag", type: "cloud", position: { x: 570, y: 110 }, measured, data: { label: "Diagnostics", detail: "CF Worker \u2022 heartbeats + errors", icon: "\uD83D\uDCCA" } },
      { id: "admin", type: "cloud", position: { x: 570, y: 280 }, measured, data: { label: "Admin Dashboard", detail: "CF Worker \u2022 monitoring", icon: "\uD83D\uDEE1\uFE0F" } },
      // Bottom: P2P
      { id: "peer", type: "device", position: { x: 140, y: 420 }, measured, data: { label: "Remote Peer", detail: "Direct P2P connection", icon: "\uD83D\uDD12" } },
    ],
    edges: [
      anim("e1", "mobile", "vps1", "WSS", "#6366f1"),
      anim("e2", "desktop", "vps2", "WSS", "#6366f1"),
      anim("e3", "mobile", "bootstrap", "GET /servers", "#eab308"),
      dash("e4", "vps1", "vps2", "SWIM gossip", "#22c55e"),
      edge("e5", "vps1", "bootstrap", "heartbeat", "#eab308"),
      edge("e6", "vps2", "bootstrap", "heartbeat", "#eab308"),
      dash("e7", "vps1", "diag", "metrics", "#94a3b8"),
      dash("e8", "diag", "admin", "D1 + R2", "#94a3b8"),
      anim("e9", "mobile", "peer", "WebRTC P2P", "#ef4444", { style: { stroke: "#ef4444", strokeWidth: 3 }, sourceHandle: "b", targetHandle: "t" }),
      anim("e10", "desktop", "peer", "WebRTC P2P", "#ef4444", { style: { stroke: "#ef4444", strokeWidth: 3 }, sourceHandle: "b", targetHandle: "t" }),
    ],
  },

  // ─── 2. BOOTSTRAP DISCOVERY ───────────────────────────
  discovery: {
    title: "Server Discovery",
    description: "How clients find and connect to signaling servers via the bootstrap registry.",
    detail: "On first launch, the app queries the Bootstrap CF Worker (GET /servers) which returns a list of healthy VPS servers with their WebSocket endpoints and regions. The app selects the best server (preferring the user's region) and connects via WSS. VPS servers register themselves with the bootstrap by sending periodic heartbeats containing their health metrics, connection count, and region.",
    nodes: [
      { id: "app", type: "device", position: { x: 0, y: 120 }, measured, data: { label: "Zajel App", detail: "First launch", icon: "\uD83D\uDCF1" } },
      { id: "bs", type: "cloud", position: { x: 260, y: 0 }, measured, data: { label: "Bootstrap Registry", detail: "CF Worker + Durable Object", icon: "\u2601\uFE0F" } },
      { id: "s1", type: "server", position: { x: 530, y: -40 }, measured, data: { label: "VPS Frankfurt", detail: "eu-central \u2022 healthy", icon: "\uD83C\uDDE9\uD83C\uDDEA" } },
      { id: "s2", type: "server", position: { x: 530, y: 120 }, measured, data: { label: "VPS Helsinki", detail: "eu-north \u2022 healthy", icon: "\uD83C\uDDEB\uD83C\uDDEE" } },
      { id: "s3", type: "server", position: { x: 530, y: 280 }, measured, data: { label: "VPS New York", detail: "us-east \u2022 healthy", icon: "\uD83C\uDDFA\uD83C\uDDF8" } },
      // Response
      { id: "select", type: "step", position: { x: 0, y: 310 }, measured, data: { label: "Select Best Server", detail: "Prefer user's region", color: "#22c55e" } },
      { id: "connect", type: "step", position: { x: 260, y: 310 }, measured, data: { label: "WSS Connect", detail: "WebSocket + TLS", color: "#3b82f6" } },
      { id: "register", type: "step", position: { x: 530, y: 420 }, measured, data: { label: "Register", detail: "Get pairing code A7X2M9", color: "#6366f1" } },
    ],
    edges: [
      anim("d1", "app", "bs", "GET /servers", "#eab308"),
      edge("d2", "s1", "bs", "heartbeat", "#22c55e"),
      edge("d3", "s2", "bs", "heartbeat", "#22c55e"),
      edge("d4", "s3", "bs", "heartbeat", "#22c55e"),
      anim("d5", "app", "select", "", "#22c55e", { sourceHandle: "b", targetHandle: "t" }),
      anim("d6", "select", "connect", "best server", "#22c55e"),
      anim("d7", "connect", "s2", "WSS", "#3b82f6"),
      anim("d8", "connect", "register", "", "#6366f1", { sourceHandle: "b", targetHandle: "t" }),
    ],
  },

  // ─── 3. CONNECTION LIFECYCLE ──────────────────────────
  connection: {
    title: "Connection Lifecycle",
    description: "Step-by-step flow from first launch to encrypted P2P communication.",
    detail: "After discovering servers (see Server Discovery), the app registers and receives a 6-character pairing code. To connect, one peer enters the other's code. The server forwards the request; both sides approve. An X25519 key exchange derives a shared secret, then WebRTC establishes a direct data channel encrypted with ChaCha20-Poly1305. For returning peers, the rendezvous system uses blinded tokens to auto-reconnect without re-entering codes.",
    nodes: [
      // Row 1
      { id: "s1", type: "step", position: { x: 0, y: 0 }, measured, data: { label: "1. Discover Servers", detail: "Bootstrap GET /servers", color: "#eab308" } },
      { id: "s2", type: "step", position: { x: 220, y: 0 }, measured, data: { label: "2. WSS Connect", detail: "Connect to best VPS", color: "#3b82f6" } },
      { id: "s3", type: "step", position: { x: 440, y: 0 }, measured, data: { label: "3. Register", detail: "Receive pairing code", color: "#22c55e" } },
      // Row 2
      { id: "s4", type: "step", position: { x: 0, y: 140 }, measured, data: { label: "4. Pair Request", detail: "Enter peer's code", color: "#a855f7" } },
      { id: "s5", type: "step", position: { x: 220, y: 140 }, measured, data: { label: "5. Both Approve", detail: "Mutual consent", color: "#a855f7" } },
      { id: "s6", type: "step", position: { x: 440, y: 140 }, measured, data: { label: "6. Key Exchange", detail: "X25519 ECDH", color: "#ef4444" } },
      // Row 3
      { id: "s7", type: "step", position: { x: 0, y: 280 }, measured, data: { label: "7. ICE + DTLS", detail: "WebRTC negotiation", color: "#f97316" } },
      { id: "s8", type: "step", position: { x: 220, y: 280 }, measured, data: { label: "8. Data Channels", detail: '"messages" + "files"', color: "#f97316" } },
      { id: "s9", type: "step", position: { x: 440, y: 280 }, measured, data: { label: "9. E2E Encrypted", detail: "ChaCha20-Poly1305", color: "#22c55e" } },
      // Rendezvous side
      { id: "rv", type: "step", position: { x: 660, y: 140 }, measured, data: { label: "Rendezvous", detail: "Auto-reconnect trusted peers", color: "#06b6d4" } },
    ],
    edges: [
      anim("c1", "s1", "s2", "", "#eab308"),
      anim("c2", "s2", "s3", "", "#3b82f6"),
      anim("c3", "s3", "s4", "", "#22c55e", { sourceHandle: "b", targetHandle: "t" }),
      anim("c4", "s4", "s5", "", "#a855f7"),
      anim("c5", "s5", "s6", "", "#a855f7"),
      anim("c6", "s6", "s7", "", "#ef4444", { sourceHandle: "b", targetHandle: "t" }),
      anim("c7", "s7", "s8", "", "#f97316"),
      anim("c8", "s8", "s9", "", "#f97316"),
      dash("c9", "s6", "rv", "trusted peers", "#06b6d4"),
      dash("c10", "rv", "s7", "skip 1-6", "#06b6d4", { sourceHandle: "b", targetHandle: "t" }),
    ],
  },

  // ─── 4. ENCRYPTION ────────────────────────────────────
  encryption: {
    title: "Encryption Stack",
    description: "Three independent layers protect every message end-to-end.",
    detail: "Layer 1 (Application): Each message is signed with the sender's Ed25519 key, then encrypted with ChaCha20-Poly1305 using a session key derived via X25519 ECDH + HKDF-SHA256. Ephemeral keys provide forward secrecy. Layer 2 (Transport P2P): WebRTC DTLS encrypts the data channel between peers. Layer 3 (Transport Signaling): WSS/TLS 1.3 protects signaling traffic. An attacker must break all three layers to read a message.",
    nodes: [
      // Application layer
      { id: "msg", type: "step", position: { x: 0, y: 0 }, measured, data: { label: "Plaintext", detail: "Message content", color: "#f8fafc" } },
      { id: "sign", type: "step", position: { x: 220, y: 0 }, measured, data: { label: "Ed25519 Sign", detail: "Sender authentication", color: "#a855f7" } },
      { id: "enc", type: "step", position: { x: 440, y: 0 }, measured, data: { label: "ChaCha20-Poly1305", detail: "AEAD encryption", color: "#ef4444" } },
      // Key derivation
      { id: "eph", type: "step", position: { x: 0, y: 170 }, measured, data: { label: "Ephemeral X25519", detail: "Fresh key per session", color: "#3b82f6" } },
      { id: "ecdh", type: "step", position: { x: 220, y: 170 }, measured, data: { label: "ECDH Shared Secret", detail: "Diffie-Hellman exchange", color: "#3b82f6" } },
      { id: "hkdf", type: "step", position: { x: 440, y: 170 }, measured, data: { label: "HKDF-SHA256", detail: "Derive session key + nonce", color: "#3b82f6" } },
      // Transport layers
      { id: "dtls", type: "step", position: { x: 110, y: 330 }, measured, data: { label: "WebRTC DTLS", detail: "P2P transport encryption", color: "#f97316" } },
      { id: "tls", type: "step", position: { x: 330, y: 330 }, measured, data: { label: "TLS 1.3 (WSS)", detail: "Signaling transport", color: "#f97316" } },
    ],
    edges: [
      anim("k1", "msg", "sign", "sign", "#a855f7"),
      anim("k2", "sign", "enc", "encrypt", "#ef4444"),
      edge("k3", "eph", "ecdh", "", "#3b82f6"),
      edge("k4", "ecdh", "hkdf", "", "#3b82f6"),
      dash("k5", "hkdf", "enc", "session key", "#3b82f6", { sourceHandle: "t", targetHandle: "b" }),
      edge("k6", "enc", "dtls", "", "#f97316", { sourceHandle: "b", targetHandle: "t" }),
      edge("k7", "enc", "tls", "", "#f97316", { sourceHandle: "b", targetHandle: "t" }),
    ],
  },

  // ─── 5. FEDERATION ────────────────────────────────────
  federation: {
    title: "Server Federation",
    description: "VPS servers form a federated mesh for cross-server pairing and routing.",
    detail: "Each VPS registers with the Bootstrap Registry via heartbeats. Servers discover each other and form a SWIM gossip mesh for membership, failure detection, and metadata propagation. A consistent hash ring (DHT) determines which servers are responsible for which pairing codes (replication factor = 3). When a client registers, the server computes redirect targets from the hash ring so the code is reachable from multiple servers. Federation enables cross-server pairing without a central coordinator.",
    nodes: [
      { id: "bs", type: "cloud", position: { x: 250, y: 0 }, measured, data: { label: "Bootstrap Registry", detail: "Server list + health", icon: "\u2601\uFE0F" } },
      { id: "s1", type: "server", position: { x: 0, y: 180 }, measured, data: { label: "VPS Frankfurt", detail: "eu-central", icon: "\uD83C\uDDE9\uD83C\uDDEA" } },
      { id: "s2", type: "server", position: { x: 260, y: 180 }, measured, data: { label: "VPS Helsinki", detail: "eu-north", icon: "\uD83C\uDDEB\uD83C\uDDEE" } },
      { id: "s3", type: "server", position: { x: 520, y: 180 }, measured, data: { label: "VPS New York", detail: "us-east", icon: "\uD83C\uDDFA\uD83C\uDDF8" } },
      { id: "ring", type: "step", position: { x: 130, y: 370 }, measured, data: { label: "DHT Hash Ring", detail: "Pairing code \u2192 responsible servers", color: "#a855f7" } },
      { id: "redirect", type: "step", position: { x: 390, y: 370 }, measured, data: { label: "Redirect Targets", detail: "Register code on 3 servers", color: "#06b6d4" } },
    ],
    edges: [
      edge("f1", "s1", "bs", "heartbeat", "#eab308", { sourceHandle: "t" }),
      edge("f2", "s2", "bs", "heartbeat", "#eab308", { sourceHandle: "t" }),
      edge("f3", "s3", "bs", "heartbeat", "#eab308", { sourceHandle: "t" }),
      anim("f4", "s1", "s2", "SWIM", "#22c55e"),
      anim("f5", "s2", "s3", "SWIM", "#22c55e"),
      dash("f6", "s1", "s3", "SWIM", "#22c55e"),
      dash("f7", "s1", "ring", "", "#a855f7", { sourceHandle: "b", targetHandle: "t" }),
      dash("f8", "s2", "ring", "", "#a855f7", { sourceHandle: "b" }),
      dash("f9", "s3", "ring", "", "#a855f7", { sourceHandle: "b", targetHandle: "t" }),
      anim("f10", "ring", "redirect", "", "#06b6d4"),
    ],
  },
};

// Set measured dimensions on all nodes for MiniMap rendering
for (const d of Object.values(diagrams)) {
  for (const n of d.nodes) {
    (n as any).measured = measured;
  }
}

// ── Component ────────────────────────────────────────────

export default function Architecture() {
  const [active, setActive] = useState<DiagramKey>("overview");
  const diagram = diagrams[active];

  return (
    <>
      <Nav />
      <style dangerouslySetInnerHTML={{ __html: darkFlowStyles }} />
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "2rem" }}>
        <h1 style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>Architecture</h1>
        <p style={{ color: "#94a3b8", marginBottom: "2rem", maxWidth: 700 }}>
          Zajel is a peer-to-peer encrypted messaging system built on WebRTC, federated
          signaling servers, and Cloudflare Workers. Explore the interactive diagrams below.
        </p>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
          {(Object.keys(diagrams) as DiagramKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setActive(key)}
              style={{
                padding: "0.5rem 1.25rem", borderRadius: 8,
                border: active === key ? "2px solid #6366f1" : "1px solid #475569",
                background: active === key ? "#6366f1" : "#1e293b",
                color: "#f8fafc", cursor: "pointer",
                fontWeight: active === key ? 700 : 400, fontSize: 14,
              }}
            >
              {diagrams[key].title}
            </button>
          ))}
        </div>

        {/* Description */}
        <h2 style={{ fontSize: "1.4rem", marginBottom: "0.5rem" }}>{diagram.title}</h2>
        <p style={{ color: "#94a3b8", marginBottom: "0.75rem", fontSize: 14, maxWidth: 800 }}>
          {diagram.description}
        </p>

        {/* Diagram */}
        <div style={{ height: 550, borderRadius: 12, border: "1px solid #334155", background: "#0f172a", overflow: "hidden" }}>
          <ReactFlow
            key={active}
            nodes={diagram.nodes}
            edges={diagram.edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            style={{ background: "#0f172a" }}
            defaultEdgeOptions={{ type: "smoothstep" }}
          >
            <Background color="#1e293b" gap={20} />
            <Controls />
            <MiniMap
              nodeColor={(node) => {
                switch (node.type) {
                  case "device": return "#6366f1";
                  case "server": return "#22c55e";
                  case "cloud": return "#eab308";
                  case "step": return (node.data as Record<string, string>).color || "#94a3b8";
                  default: return "#475569";
                }
              }}
              maskColor="rgba(15, 23, 42, 0.75)"
            />
          </ReactFlow>
        </div>

        {/* Detailed explanation */}
        <div style={{ marginTop: "1.5rem", padding: "1.25rem", background: "#1e293b", borderRadius: 10, border: "1px solid #334155" }}>
          <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem", color: "#f8fafc" }}>How it works</h3>
          <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.7 }}>{diagram.detail}</p>
        </div>

        {/* Legend */}
        <div style={{ display: "flex", gap: "1.5rem", marginTop: "1.25rem", color: "#94a3b8", fontSize: 12, flexWrap: "wrap" }}>
          <span><span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: "#6366f1", marginRight: 4, verticalAlign: "middle" }} /> Client</span>
          <span><span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: "#22c55e", marginRight: 4, verticalAlign: "middle" }} /> VPS Server</span>
          <span><span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: "#eab308", marginRight: 4, verticalAlign: "middle" }} /> CF Worker</span>
          <span><span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 3, background: "#ef4444", marginRight: 4, verticalAlign: "middle" }} /> P2P Link</span>
          <span>Animated = live flow &nbsp; Dashed = background/async</span>
        </div>
      </div>
      <Footer />
    </>
  );
}
