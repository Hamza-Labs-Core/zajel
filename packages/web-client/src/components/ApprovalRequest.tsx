interface ApprovalRequestProps {
  peerCode: string;
  onAccept: () => void;
  onReject: () => void;
}

export function ApprovalRequest({ peerCode, onAccept, onReject }: ApprovalRequestProps) {
  return (
    <div class="approval-overlay">
      <div class="approval-dialog">
        <h3>Connection Request</h3>
        <p>
          <span class="code">{peerCode}</span> wants to connect
        </p>
        <div class="btn-row">
          <button class="btn btn-success" onClick={onAccept}>
            Accept
          </button>
          <button class="btn btn-danger" onClick={onReject}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
