import type { ConnectionState } from '../lib/protocol';

interface StatusIndicatorProps {
  state: ConnectionState;
}

const stateLabels: Record<ConnectionState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting...',
  registered: 'Ready',
  pairing: 'Pairing...',
  waiting_approval: 'Waiting for approval...',
  pending_approval: 'Pending approval',
  matched: 'Matched',
  webrtc_connecting: 'Establishing connection...',
  handshaking: 'Handshaking...',
  connected: 'Connected',
};

// Additional descriptions for screen readers
const stateDescriptions: Record<ConnectionState, string> = {
  disconnected: 'Not connected to any peer',
  connecting: 'Connecting to signaling server, please wait',
  registered: 'Ready to connect with a peer',
  pairing: 'Pairing with peer, please wait',
  waiting_approval: 'Waiting for peer to accept your connection request',
  pending_approval: 'You have a pending connection request',
  matched: 'Matched with peer, establishing secure connection',
  webrtc_connecting: 'Establishing peer-to-peer connection, please wait',
  handshaking: 'Performing cryptographic handshake',
  connected: 'Securely connected to peer',
};

export function StatusIndicator({ state }: StatusIndicatorProps) {
  const isConnected = state === 'connected';
  const isConnecting =
    state === 'connecting' ||
    state === 'pairing' ||
    state === 'webrtc_connecting' ||
    state === 'handshaking';
  const isDisconnected = state === 'disconnected';

  let dotClass = 'dot';
  if (isConnected) dotClass += ' connected';
  else if (isConnecting) dotClass += ' connecting';

  return (
    <div
      class="status-indicator"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {/* Visual indicator - hidden from screen readers */}
      <span
        class={dotClass}
        aria-hidden="true"
        role="presentation"
      />

      {/* Visible label */}
      <span aria-hidden="true">{stateLabels[state]}</span>

      {/* Screen reader accessible description */}
      <span class="sr-only">
        Connection status: {stateLabels[state]}.{' '}
        {stateDescriptions[state]}
        {isConnected && ' - Your messages are end-to-end encrypted.'}
        {isDisconnected && ' - Enter a peer code to connect.'}
      </span>
    </div>
  );
}
