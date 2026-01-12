interface SecurityInfoPanelProps {
  myFingerprint: string;
  peerFingerprint: string;
  peerCode: string;
  isConnected: boolean;
  onClose: () => void;
}

export function SecurityInfoPanel({
  myFingerprint,
  peerFingerprint,
  peerCode,
  isConnected,
  onClose,
}: SecurityInfoPanelProps) {
  return (
    <aside
      class="card"
      style={{ background: 'var(--warning, #f59e0b)', marginBottom: '16px', color: '#000' }}
      role="complementary"
      aria-labelledby="security-info-heading"
    >
      <h3 id="security-info-heading" style={{ margin: '0 0 8px 0' }}>Security Information</h3>
      <p style={{ margin: '0 0 8px 0', fontSize: '14px' }}>
        <span aria-hidden="true">✓</span> Keys are ephemeral (memory-only, never stored)
      </p>
      {myFingerprint && (
        <div style={{ marginTop: '12px' }}>
          <strong id="my-fingerprint-label" style={{ fontSize: '12px' }}>Your Key Fingerprint:</strong>
          <code
            aria-labelledby="my-fingerprint-label"
            tabIndex={0}
            style={{ display: 'block', fontSize: '11px', marginTop: '4px', wordBreak: 'break-all', background: 'rgba(0,0,0,0.1)', padding: '4px', borderRadius: '4px' }}
          >
            {myFingerprint}
          </code>
        </div>
      )}
      {isConnected && peerFingerprint && (
        <div style={{ marginTop: '8px' }}>
          <strong id="peer-fingerprint-label" style={{ fontSize: '12px' }}>Peer Key Fingerprint ({peerCode}):</strong>
          <code
            aria-labelledby="peer-fingerprint-label"
            tabIndex={0}
            style={{ display: 'block', fontSize: '11px', marginTop: '4px', wordBreak: 'break-all', background: 'rgba(0,0,0,0.1)', padding: '4px', borderRadius: '4px' }}
          >
            {peerFingerprint}
          </code>
          <p style={{ margin: '8px 0 0 0', fontSize: '12px' }}>
            Compare these fingerprints with your peer through a trusted channel
            (voice call, in person) to verify you're not being intercepted.
          </p>
        </div>
      )}
      <button
        class="btn btn-sm"
        style={{ marginTop: '12px', background: 'rgba(0,0,0,0.2)' }}
        onClick={onClose}
        aria-label="Close security information panel"
      >
        Close
      </button>
    </aside>
  );
}
