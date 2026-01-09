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

export function StatusIndicator({ state }: StatusIndicatorProps) {
  const isConnected = state === 'connected';
  const isConnecting =
    state === 'connecting' ||
    state === 'pairing' ||
    state === 'webrtc_connecting' ||
    state === 'handshaking';

  let dotClass = 'dot';
  if (isConnected) dotClass += ' connected';
  else if (isConnecting) dotClass += ' connecting';

  return (
    <div class="status-indicator">
      <span class={dotClass} />
      <span>{stateLabels[state]}</span>
    </div>
  );
}
