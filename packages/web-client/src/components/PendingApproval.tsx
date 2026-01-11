interface PendingApprovalProps {
  peerCode: string;
  onCancel: () => void;
}

export function PendingApproval({ peerCode, onCancel }: PendingApprovalProps) {
  return (
    <section
      class="card"
      role="region"
      aria-labelledby="pending-heading"
      aria-live="polite"
    >
      <div class="loading-state">
        {/* Spinner with accessible status */}
        <div
          class="spinner"
          role="status"
          aria-label="Loading"
        >
          <span class="sr-only">Waiting for connection approval</span>
        </div>

        <p id="pending-heading">
          Waiting for{' '}
          <span aria-label={`peer ${peerCode.split('').join(' ')}`}>
            {peerCode}
          </span>{' '}
          to accept...
        </p>

        <button
          class="btn btn-secondary btn-sm"
          onClick={onCancel}
          aria-label={`Cancel connection request to ${peerCode}`}
        >
          Cancel
        </button>
      </div>

      {/* Live region for screen readers */}
      <div aria-live="assertive" aria-atomic="true" class="sr-only">
        Connection request sent to {peerCode}. Waiting for approval.
      </div>
    </section>
  );
}
