interface KeyChangeWarningProps {
  peerCode: string;
  oldFingerprint: string;
  newFingerprint: string;
  onAccept: () => void;
  onDisconnect: () => void;
}

export function KeyChangeWarning({
  peerCode,
  oldFingerprint,
  newFingerprint,
  onAccept,
  onDisconnect,
}: KeyChangeWarningProps) {
  return (
    <div class="approval-overlay">
      <div class="approval-dialog" style={{ maxWidth: '400px' }}>
        <h3 style={{ color: 'var(--error, #ef4444)' }}>Security Warning</h3>
        <p style={{ marginBottom: '12px' }}>
          The key for <span class="code">{peerCode}</span> has changed!
        </p>
        <p style={{ fontSize: '14px', marginBottom: '12px', opacity: 0.9 }}>
          This could indicate a man-in-the-middle attack, or the peer may have
          reinstalled the app or cleared their data.
        </p>
        <div style={{ marginBottom: '12px' }}>
          <strong style={{ fontSize: '12px', display: 'block', marginBottom: '4px' }}>
            Previous Fingerprint:
          </strong>
          <code
            style={{
              display: 'block',
              fontSize: '11px',
              wordBreak: 'break-all',
              background: 'rgba(239, 68, 68, 0.2)',
              padding: '6px',
              borderRadius: '4px',
              border: '1px solid rgba(239, 68, 68, 0.3)',
            }}
          >
            {oldFingerprint}
          </code>
        </div>
        <div style={{ marginBottom: '16px' }}>
          <strong style={{ fontSize: '12px', display: 'block', marginBottom: '4px' }}>
            New Fingerprint:
          </strong>
          <code
            style={{
              display: 'block',
              fontSize: '11px',
              wordBreak: 'break-all',
              background: 'rgba(34, 197, 94, 0.2)',
              padding: '6px',
              borderRadius: '4px',
              border: '1px solid rgba(34, 197, 94, 0.3)',
            }}
          >
            {newFingerprint}
          </code>
        </div>
        <p style={{ fontSize: '12px', marginBottom: '16px', opacity: 0.8 }}>
          Verify with your peer through a trusted channel (voice call, in person)
          before accepting the new key.
        </p>
        <div class="btn-row">
          <button class="btn btn-danger" onClick={onDisconnect}>
            Disconnect
          </button>
          <button class="btn" onClick={onAccept} style={{ background: 'var(--warning, #f59e0b)' }}>
            Accept New Key
          </button>
        </div>
      </div>
    </div>
  );
}
