import { useCallback, useState } from "react";
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

export const meta: MetaFunction = () => [
  { title: "Architecture - Zajel" },
  { name: "description", content: "Zajel system architecture — signaling, P2P, encryption, federation" },
];

// ── Custom Node Components ──────────────────────────────────

function DeviceNode({ data }: { data: { label: string; detail: string; icon: string } }) {
  return (
    <div style={{
      background: "#1e293b", border: "2px solid #6366f1", borderRadius: 12,
      padding: "16px 20px", color: "#f8fafc", minWidth: 180, textAlign: "center",
    }}>
      <Handle type="source" position={Position.Right} style={{ background: "#6366f1" }} />
      <Handle type="target" position={Position.Left} style={{ background: "#6366f1" }} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: "#6366f1" }} />
      <Handle type="target" position={Position.Top} id="top" style={{ background: "#6366f1" }} />
      <div style={{ fontSize: 28, marginBottom: 6 }}>{data.icon}</div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{data.label}</div>
      <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 4 }}>{data.detail}</div>
    </div>
  );
}

function ServerNode({ data }: { data: { label: string; detail: string; icon: string } }) {
  return (
    <div style={{
      background: "#0f172a", border: "2px solid #22c55e", borderRadius: 12,
      padding: "16px 20px", color: "#f8fafc", minWidth: 200, textAlign: "center",
    }}>
      <Handle type="source" position={Position.Right} style={{ background: "#22c55e" }} />
      <Handle type="target" position={Position.Left} style={{ background: "#22c55e" }} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: "#22c55e" }} />
      <Handle type="target" position={Position.Top} id="top" style={{ background: "#22c55e" }} />
      <div style={{ fontSize: 28, marginBottom: 6 }}>{data.icon}</div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{data.label}</div>
      <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 4 }}>{data.detail}</div>
    </div>
  );
}

function CloudNode({ data }: { data: { label: string; detail: string; icon: string } }) {
  return (
    <div style={{
      background: "#0f172a", border: "2px solid #eab308", borderRadius: 12,
      padding: "16px 20px", color: "#f8fafc", minWidth: 200, textAlign: "center",
    }}>
      <Handle type="source" position={Position.Right} style={{ background: "#eab308" }} />
      <Handle type="target" position={Position.Left} style={{ background: "#eab308" }} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: "#eab308" }} />
      <Handle type="target" position={Position.Top} id="top" style={{ background: "#eab308" }} />
      <div style={{ fontSize: 28, marginBottom: 6 }}>{data.icon}</div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{data.label}</div>
      <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 4 }}>{data.detail}</div>
    </div>
  );
}

function LayerNode({ data }: { data: { label: string; detail: string; color: string } }) {
  return (
    <div style={{
      background: "#1e293b", border: `2px solid ${data.color}`, borderRadius: 8,
      padding: "12px 16px", color: "#f8fafc", minWidth: 160, textAlign: "center",
    }}>
      <Handle type="source" position={Position.Right} style={{ background: data.color }} />
      <Handle type="target" position={Position.Left} style={{ background: data.color }} />
      <Handle type="source" position={Position.Bottom} id="bottom" style={{ background: data.color }} />
      <Handle type="target" position={Position.Top} id="top" style={{ background: data.color }} />
      <div style={{ fontWeight: 600, fontSize: 13, color: data.color }}>{data.label}</div>
      <div style={{ color: "#94a3b8", fontSize: 10, marginTop: 3 }}>{data.detail}</div>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  device: DeviceNode,
  server: ServerNode,
  cloud: CloudNode,
  layer: LayerNode,
};

// ── Diagram Definitions ──────────────────────────────────────

type DiagramKey = "overview" | "connection" | "encryption" | "federation";

interface DiagramDef {
  title: string;
  description: string;
  nodes: Node[];
  edges: Edge[];
}

const diagrams: Record<DiagramKey, DiagramDef> = {
  overview: {
    title: "System Overview",
    description: "How the main components interact — clients connect via signaling servers and communicate peer-to-peer.",
    nodes: [
      { id: "phone", type: "device", position: { x: 50, y: 200 }, data: { label: "Mobile App", detail: "Android / iOS", icon: "\uD83D\uDCF1" } },
      { id: "desktop", type: "device", position: { x: 50, y: 400 }, data: { label: "Desktop App", detail: "Windows / macOS / Linux", icon: "\uD83D\uDDA5\uFE0F" } },
      { id: "vps1", type: "server", position: { x: 350, y: 150 }, data: { label: "VPS Signaling", detail: "WebSocket + TURN relay", icon: "\uD83D\uDCE1" } },
      { id: "vps2", type: "server", position: { x: 350, y: 350 }, data: { label: "VPS Signaling", detail: "Federated via SWIM gossip", icon: "\uD83D\uDCE1" } },
      { id: "bootstrap", type: "cloud", position: { x: 650, y: 100 }, data: { label: "Bootstrap (CF Worker)", detail: "Server discovery + attestation", icon: "\u2601\uFE0F" } },
      { id: "diagnostics", type: "cloud", position: { x: 650, y: 270 }, data: { label: "Diagnostics (CF Worker)", detail: "Heartbeats + error reports", icon: "\uD83D\uDCCA" } },
      { id: "admin", type: "cloud", position: { x: 650, y: 440 }, data: { label: "Admin Dashboard", detail: "Monitoring + alerts", icon: "\uD83D\uDEE1\uFE0F" } },
      { id: "peer", type: "device", position: { x: 50, y: 600 }, data: { label: "Remote Peer", detail: "Any platform", icon: "\uD83D\uDC64" } },
    ],
    edges: [
      { id: "e1", source: "phone", target: "vps1", label: "WSS", style: { stroke: "#6366f1" }, animated: true },
      { id: "e2", source: "desktop", target: "vps2", label: "WSS", style: { stroke: "#6366f1" }, animated: true },
      { id: "e3", source: "vps1", target: "vps2", label: "SWIM gossip", style: { stroke: "#22c55e", strokeDasharray: "5 5" } },
      { id: "e4", source: "vps1", target: "bootstrap", label: "Register", style: { stroke: "#eab308" } },
      { id: "e5", source: "vps2", target: "bootstrap", label: "Register", style: { stroke: "#eab308" } },
      { id: "e6", source: "vps1", target: "diagnostics", style: { stroke: "#94a3b8", strokeDasharray: "3 3" } },
      { id: "e7", source: "diagnostics", target: "admin", style: { stroke: "#94a3b8", strokeDasharray: "3 3" } },
      { id: "e8", source: "phone", target: "peer", label: "WebRTC P2P", style: { stroke: "#ef4444", strokeWidth: 2 }, animated: true },
      { id: "e9", source: "desktop", target: "peer", label: "WebRTC P2P", style: { stroke: "#ef4444", strokeWidth: 2 }, animated: true },
    ],
  },

  connection: {
    title: "Connection Lifecycle",
    description: "The step-by-step flow from pairing code to encrypted P2P connection.",
    nodes: [
      { id: "start", type: "layer", position: { x: 50, y: 50 }, data: { label: "1. Bootstrap", detail: "Discover signaling servers", color: "#eab308" } },
      { id: "connect", type: "layer", position: { x: 300, y: 50 }, data: { label: "2. Connect", detail: "WebSocket to VPS", color: "#3b82f6" } },
      { id: "register", type: "layer", position: { x: 550, y: 50 }, data: { label: "3. Register", detail: "Get pairing code", color: "#22c55e" } },
      { id: "pair", type: "layer", position: { x: 50, y: 200 }, data: { label: "4. Pair Request", detail: "Enter peer's code", color: "#a855f7" } },
      { id: "approve", type: "layer", position: { x: 300, y: 200 }, data: { label: "5. Approve", detail: "Both sides accept", color: "#a855f7" } },
      { id: "exchange", type: "layer", position: { x: 550, y: 200 }, data: { label: "6. Key Exchange", detail: "X25519 ECDH", color: "#ef4444" } },
      { id: "webrtc", type: "layer", position: { x: 50, y: 350 }, data: { label: "7. WebRTC Setup", detail: "ICE + DTLS", color: "#f97316" } },
      { id: "datachannel", type: "layer", position: { x: 300, y: 350 }, data: { label: "8. Data Channel", detail: "messages + files", color: "#f97316" } },
      { id: "encrypted", type: "layer", position: { x: 550, y: 350 }, data: { label: "9. E2E Encrypted", detail: "ChaCha20-Poly1305", color: "#22c55e" } },
    ],
    edges: [
      { id: "c1", source: "start", target: "connect", animated: true, style: { stroke: "#eab308" } },
      { id: "c2", source: "connect", target: "register", animated: true, style: { stroke: "#3b82f6" } },
      { id: "c3", source: "register", target: "pair", sourceHandle: "bottom", targetHandle: "top", animated: true, style: { stroke: "#22c55e" } },
      { id: "c4", source: "pair", target: "approve", animated: true, style: { stroke: "#a855f7" } },
      { id: "c5", source: "approve", target: "exchange", animated: true, style: { stroke: "#a855f7" } },
      { id: "c6", source: "exchange", target: "webrtc", sourceHandle: "bottom", targetHandle: "top", animated: true, style: { stroke: "#ef4444" } },
      { id: "c7", source: "webrtc", target: "datachannel", animated: true, style: { stroke: "#f97316" } },
      { id: "c8", source: "datachannel", target: "encrypted", animated: true, style: { stroke: "#f97316" } },
    ],
  },

  encryption: {
    title: "Encryption Layers",
    description: "Multiple layers of encryption protect every message from device to device.",
    nodes: [
      { id: "plaintext", type: "layer", position: { x: 50, y: 100 }, data: { label: "Plaintext Message", detail: "User's message content", color: "#f8fafc" } },
      { id: "sign", type: "layer", position: { x: 300, y: 100 }, data: { label: "Ed25519 Sign", detail: "Authentication", color: "#a855f7" } },
      { id: "encrypt", type: "layer", position: { x: 550, y: 100 }, data: { label: "ChaCha20-Poly1305", detail: "AEAD encryption", color: "#ef4444" } },
      { id: "session", type: "layer", position: { x: 50, y: 270 }, data: { label: "Session Key", detail: "X25519 ECDH derived", color: "#3b82f6" } },
      { id: "hkdf", type: "layer", position: { x: 300, y: 270 }, data: { label: "HKDF-SHA256", detail: "Key derivation", color: "#3b82f6" } },
      { id: "ephemeral", type: "layer", position: { x: 550, y: 270 }, data: { label: "Ephemeral Keys", detail: "Fresh per session", color: "#22c55e" } },
      { id: "webrtc_dtls", type: "layer", position: { x: 175, y: 420 }, data: { label: "WebRTC DTLS", detail: "Transport encryption", color: "#f97316" } },
      { id: "tls", type: "layer", position: { x: 425, y: 420 }, data: { label: "WSS / TLS 1.3", detail: "Signaling transport", color: "#f97316" } },
    ],
    edges: [
      { id: "enc1", source: "plaintext", target: "sign", label: "sign", style: { stroke: "#a855f7" } },
      { id: "enc2", source: "sign", target: "encrypt", label: "encrypt", style: { stroke: "#ef4444" } },
      { id: "enc3", source: "session", target: "hkdf", style: { stroke: "#3b82f6" } },
      { id: "enc4", source: "hkdf", target: "ephemeral", style: { stroke: "#3b82f6" } },
      { id: "enc5", source: "hkdf", target: "encrypt", targetHandle: "top", sourceHandle: "bottom", label: "key", style: { stroke: "#3b82f6", strokeDasharray: "5 5" } },
      { id: "enc6", source: "encrypt", target: "webrtc_dtls", sourceHandle: "bottom", targetHandle: "top", style: { stroke: "#f97316" } },
      { id: "enc7", source: "encrypt", target: "tls", sourceHandle: "bottom", targetHandle: "top", style: { stroke: "#f97316", strokeDasharray: "3 3" } },
    ],
  },

  federation: {
    title: "Server Federation",
    description: "VPS servers discover each other via the bootstrap registry and form a federated mesh using the SWIM gossip protocol.",
    nodes: [
      { id: "bs", type: "cloud", position: { x: 300, y: 50 }, data: { label: "Bootstrap Registry", detail: "CF Worker + Durable Object", icon: "\u2601\uFE0F" } },
      { id: "s1", type: "server", position: { x: 50, y: 250 }, data: { label: "VPS Frankfurt", detail: "eu-central", icon: "\uD83C\uDDE9\uD83C\uDDEA" } },
      { id: "s2", type: "server", position: { x: 350, y: 250 }, data: { label: "VPS Helsinki", detail: "eu-north", icon: "\uD83C\uDDEB\uD83C\uDDEE" } },
      { id: "s3", type: "server", position: { x: 650, y: 250 }, data: { label: "VPS New York", detail: "us-east", icon: "\uD83C\uDDFA\uD83C\uDDF8" } },
      { id: "ring", type: "layer", position: { x: 300, y: 430 }, data: { label: "DHT Hash Ring", detail: "Pairing code routing", color: "#a855f7" } },
    ],
    edges: [
      { id: "f1", source: "s1", target: "bs", targetHandle: "top", label: "heartbeat", style: { stroke: "#eab308" } },
      { id: "f2", source: "s2", target: "bs", label: "heartbeat", style: { stroke: "#eab308" } },
      { id: "f3", source: "s3", target: "bs", targetHandle: "top", label: "heartbeat", style: { stroke: "#eab308" } },
      { id: "f4", source: "s1", target: "s2", label: "SWIM", style: { stroke: "#22c55e" }, animated: true },
      { id: "f5", source: "s2", target: "s3", label: "SWIM", style: { stroke: "#22c55e" }, animated: true },
      { id: "f6", source: "s1", target: "s3", label: "SWIM", style: { stroke: "#22c55e", strokeDasharray: "5 5" }, animated: true },
      { id: "f7", source: "s1", target: "ring", sourceHandle: "bottom", targetHandle: "top", style: { stroke: "#a855f7", strokeDasharray: "3 3" } },
      { id: "f8", source: "s2", target: "ring", sourceHandle: "bottom", style: { stroke: "#a855f7", strokeDasharray: "3 3" } },
      { id: "f9", source: "s3", target: "ring", sourceHandle: "bottom", targetHandle: "top", style: { stroke: "#a855f7", strokeDasharray: "3 3" } },
    ],
  },
};

// ── Main Component ──────────────────────────────────────────

export default function Architecture() {
  const [active, setActive] = useState<DiagramKey>("overview");
  const diagram = diagrams[active];

  return (
    <>
      <Nav />
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "2rem" }}>
        <h1 style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>Architecture</h1>
        <p style={{ color: "#94a3b8", marginBottom: "2rem" }}>
          Interactive diagrams of Zajel's system design. Click a diagram to explore.
        </p>

        {/* Diagram selector */}
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem", flexWrap: "wrap" }}>
          {(Object.keys(diagrams) as DiagramKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setActive(key)}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: 8,
                border: active === key ? "2px solid #6366f1" : "1px solid #475569",
                background: active === key ? "#6366f1" : "#1e293b",
                color: "#f8fafc",
                cursor: "pointer",
                fontWeight: active === key ? 700 : 400,
                fontSize: 14,
              }}
            >
              {diagrams[key].title}
            </button>
          ))}
        </div>

        {/* Description */}
        <p style={{ color: "#94a3b8", marginBottom: "1rem", fontSize: 14 }}>
          {diagram.description}
        </p>

        {/* React Flow diagram */}
        <div style={{
          height: 550,
          borderRadius: 12,
          border: "1px solid #334155",
          background: "#0f172a",
          overflow: "hidden",
        }}>
          <ReactFlow
            key={active}
            nodes={diagram.nodes}
            edges={diagram.edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            proOptions={{ hideAttribution: true }}
            style={{ background: "#0f172a" }}
            defaultEdgeOptions={{ type: "smoothstep" }}
          >
            <Background color="#1e293b" gap={20} />
            <Controls
              style={{ background: "#1e293b", borderColor: "#475569" }}
            />
            <MiniMap
              style={{ background: "#0f172a" }}
              nodeColor={() => "#334155"}
              maskColor="rgba(15, 23, 42, 0.7)"
            />
          </ReactFlow>
        </div>

        {/* Legend */}
        <div style={{
          display: "flex", gap: "2rem", marginTop: "1.5rem",
          color: "#94a3b8", fontSize: 12, flexWrap: "wrap",
        }}>
          <span><span style={{ color: "#6366f1" }}>---</span> Client device</span>
          <span><span style={{ color: "#22c55e" }}>---</span> VPS server</span>
          <span><span style={{ color: "#eab308" }}>---</span> Cloudflare Worker</span>
          <span><span style={{ color: "#ef4444" }}>---</span> P2P connection</span>
          <span>Animated = live data flow</span>
        </div>
      </div>
      <Footer />
    </>
  );
}
