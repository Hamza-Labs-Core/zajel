import { useEffect, useRef, useCallback } from 'preact/hooks';

interface ApprovalRequestProps {
  peerCode: string;
  onAccept: () => void;
  onReject: () => void;
}

export function ApprovalRequest({ peerCode, onAccept, onReject }: ApprovalRequestProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const acceptButtonRef = useRef<HTMLButtonElement>(null);

  // Focus the accept button when the dialog opens
  useEffect(() => {
    acceptButtonRef.current?.focus();
  }, []);

  // Handle Escape key to reject
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onReject();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onReject]);

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
      onClick={(e) => {
        // Close when clicking the backdrop (optional accessibility feature)
        if (e.target === e.currentTarget) {
          onReject();
        }
      }}
    >
      <div
        ref={dialogRef}
        class="approval-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-desc"
        onKeyDown={handleKeyDownFocusTrap}
      >
        <h3 id="approval-title">Connection Request</h3>
        <p id="approval-desc">
          <span class="code" aria-label={`Peer code ${peerCode.split('').join(' ')}`}>
            {peerCode}
          </span>{' '}
          wants to connect
        </p>

        <div class="btn-row" role="group" aria-label="Connection decision">
          <button
            ref={acceptButtonRef}
            class="btn btn-success"
            onClick={onAccept}
            aria-label={`Accept connection from ${peerCode}`}
          >
            Accept
          </button>
          <button
            class="btn btn-danger"
            onClick={onReject}
            aria-label={`Reject connection from ${peerCode}`}
          >
            Reject
          </button>
        </div>

        <p class="sr-only">
          Press Escape to reject this connection request.
        </p>
      </div>
    </div>
  );
}
