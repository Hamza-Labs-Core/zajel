import { useEffect, useRef, useCallback } from 'preact/hooks';

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const disconnectButtonRef = useRef<HTMLButtonElement>(null);

  // Focus the disconnect button (safer default) when dialog opens
  useEffect(() => {
    disconnectButtonRef.current?.focus();
  }, []);

  // Handle Escape key to disconnect (safest action)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDisconnect();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onDisconnect]);

  // Focus trap - keep focus within the dialog
  const handleKeyDownFocusTrap = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;

    const focusableElements = dialogRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (e.shiftKey && document.activeElement === firstElement) {
      e.preventDefault();
      lastElement?.focus();
    } else if (!e.shiftKey && document.activeElement === lastElement) {
      e.preventDefault();
      firstElement?.focus();
    }
  }, []);

  return (
    <div
      class="approval-overlay"
      role="presentation"
      aria-hidden="true"
    >
      <div
        ref={dialogRef}
        class="approval-dialog"
        style={{ maxWidth: '400px' }}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="warning-title"
        aria-describedby="warning-desc"
        onKeyDown={handleKeyDownFocusTrap}
      >
        {/* Screen reader urgent announcement */}
        <div aria-live="assertive" class="sr-only">
          Security warning: The encryption key for {peerCode} has changed.
          This could indicate a man-in-the-middle attack.
        </div>

        <h3
          id="warning-title"
          style={{ color: 'var(--error, #ef4444)' }}
        >
          Security Warning
        </h3>

        <div id="warning-desc">
          <p style={{ marginBottom: '12px' }}>
            The key for{' '}
            <span class="code" aria-label={`peer ${peerCode.split('').join(' ')}`}>
              {peerCode}
            </span>{' '}
            has changed!
          </p>
          <p style={{ fontSize: '14px', marginBottom: '12px', opacity: 0.9 }}>
            This could indicate a man-in-the-middle attack, or the peer may have
            reinstalled the app or cleared their data.
          </p>
        </div>

        <div role="group" aria-label="Fingerprint comparison">
          <div style={{ marginBottom: '12px' }}>
            <strong
              id="old-fp-label"
              style={{ fontSize: '12px', display: 'block', marginBottom: '4px' }}
            >
              Previous Fingerprint:
            </strong>
            <code
              aria-labelledby="old-fp-label"
              tabIndex={0}
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
            <strong
              id="new-fp-label"
              style={{ fontSize: '12px', display: 'block', marginBottom: '4px' }}
            >
              New Fingerprint:
            </strong>
            <code
              aria-labelledby="new-fp-label"
              tabIndex={0}
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
        </div>

        <p style={{ fontSize: '12px', marginBottom: '16px', opacity: 0.8 }}>
          Verify with your peer through a trusted channel (voice call, in person)
          before accepting the new key.
        </p>

        <div class="btn-row" role="group" aria-label="Security decision actions">
          <button
            ref={disconnectButtonRef}
            class="btn btn-danger"
            onClick={onDisconnect}
            aria-label="Disconnect - recommended for security"
          >
            Disconnect
          </button>
          <button
            class="btn"
            onClick={onAccept}
            style={{ background: 'var(--warning, #f59e0b)' }}
            aria-label="Accept new key - proceed with caution, only if you verified with your peer"
          >
            Accept New Key
          </button>
        </div>

        <p class="sr-only">
          Press Escape to disconnect safely. Disconnecting is the recommended action
          if you have not verified this key change with your peer.
        </p>
      </div>
    </div>
  );
}
