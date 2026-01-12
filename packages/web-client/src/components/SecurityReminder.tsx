interface SecurityReminderProps {
  myFingerprint: string;
  peerFingerprint: string;
  peerCode: string;
  onDismiss: () => void;
  onVerified: () => void;
}

export function SecurityReminder({
  myFingerprint,
  peerFingerprint,
  peerCode,
  onDismiss,
  onVerified,
}: SecurityReminderProps) {
  return (
    <div
      class="card"
      role="alertdialog"
      aria-labelledby="security-reminder-title"
      aria-describedby="security-reminder-desc"
      style={{
        background: 'linear-gradient(135deg, #dc2626, #b91c1c)',
        marginBottom: '16px',
        border: '2px solid #fca5a5'
      }}
    >
      <h3 id="security-reminder-title" style={{ margin: '0 0 8px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span aria-hidden="true">⚠️</span> Verify Your Connection
      </h3>
      <div id="security-reminder-desc">
        <p style={{ margin: '0 0 12px 0', fontSize: '14px' }}>
          <strong>Warning:</strong> Without verification, a man-in-the-middle attack could intercept your messages.
          Compare fingerprints with your peer through a trusted channel (phone call, in person).
        </p>
      </div>
      <div
        role="group"
        aria-label="Fingerprint comparison for verification"
        style={{
          background: 'rgba(0,0,0,0.2)',
          padding: '12px',
          borderRadius: '8px',
          marginBottom: '12px'
        }}
      >
        <div style={{ marginBottom: '8px' }}>
          <strong id="reminder-my-fp-label" style={{ fontSize: '12px' }}>Your Fingerprint:</strong>
          <code
            aria-labelledby="reminder-my-fp-label"
            tabIndex={0}
            style={{
              display: 'block',
              fontSize: '11px',
              marginTop: '4px',
              wordBreak: 'break-all',
              background: 'rgba(255,255,255,0.1)',
              padding: '4px',
              borderRadius: '4px'
            }}
          >
            {myFingerprint}
          </code>
        </div>
        <div>
          <strong id="reminder-peer-fp-label" style={{ fontSize: '12px' }}>Peer Fingerprint ({peerCode}):</strong>
          <code
            aria-labelledby="reminder-peer-fp-label"
            tabIndex={0}
            style={{
              display: 'block',
              fontSize: '11px',
              marginTop: '4px',
              wordBreak: 'break-all',
              background: 'rgba(255,255,255,0.1)',
              padding: '4px',
              borderRadius: '4px'
            }}
          >
            {peerFingerprint}
          </code>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px' }} role="group" aria-label="Verification actions">
        <button
          class="btn btn-sm"
          style={{ background: 'rgba(255,255,255,0.2)', flex: 1 }}
          onClick={onDismiss}
          aria-label="Dismiss reminder and verify later"
        >
          I'll Verify Later
        </button>
        <button
          class="btn btn-sm"
          style={{ background: '#16a34a', flex: 1 }}
          onClick={onVerified}
          aria-label="Mark as verified and show security information"
        >
          <span aria-hidden="true">✓</span> Verified
        </button>
      </div>
    </div>
  );
}
