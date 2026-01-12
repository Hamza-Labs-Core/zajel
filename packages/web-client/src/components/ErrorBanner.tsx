interface ErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div
      class="card"
      role="alert"
      aria-live="assertive"
      style={{ background: 'var(--error)', marginBottom: '16px' }}
    >
      <p style={{ margin: 0 }}>{message}</p>
      <button
        class="btn btn-sm"
        style={{ marginTop: '8px', background: 'rgba(0,0,0,0.2)' }}
        onClick={onDismiss}
        aria-label="Dismiss error message"
      >
        Dismiss
      </button>
    </div>
  );
}
