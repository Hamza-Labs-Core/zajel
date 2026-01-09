interface PendingApprovalProps {
  peerCode: string;
  onCancel: () => void;
}

export function PendingApproval({ peerCode, onCancel }: PendingApprovalProps) {
  return (
    <div class="card">
      <div class="loading-state">
        <div class="spinner" />
        <p>Waiting for {peerCode} to accept...</p>
        <button class="btn btn-secondary btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
