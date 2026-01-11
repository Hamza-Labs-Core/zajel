import { useState } from 'preact/hooks';

interface FingerprintDisplayProps {
  myFingerprint: string;
  peerFingerprint: string;
  peerCode: string;
  onClose?: () => void;
  compact?: boolean;
}

/**
 * Component to display key fingerprints for MITM verification.
 *
 * Fingerprints allow users to verify they're communicating with the intended
 * peer and not a man-in-the-middle attacker. Users should compare these
 * fingerprints through a trusted channel (phone call, in person).
 *
 * Format: 64 uppercase hex characters in 4-character groups
 * Example: ABCD 1234 EF56 7890 ...
 */
export function FingerprintDisplay({
  myFingerprint,
  peerFingerprint,
  peerCode,
  onClose,
  compact = false,
}: FingerprintDisplayProps) {
  const [copied, setCopied] = useState<'my' | 'peer' | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const copyToClipboard = async (text: string, which: 'my' | 'peer') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setAnnouncement(
        which === 'my'
          ? 'Your fingerprint copied to clipboard'
          : 'Peer fingerprint copied to clipboard'
      );
      setTimeout(() => {
        setCopied(null);
        setAnnouncement('');
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      setAnnouncement('Failed to copy to clipboard');
    }
  };

  if (compact) {
    return (
      <div class="fingerprint-compact">
        <button
          class="fingerprint-toggle"
          onClick={() => onClose?.()}
          aria-label="Show fingerprint verification panel"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>Verify Security</span>
        </button>
      </div>
    );
  }

  return (
    <section
      class="fingerprint-panel"
      role="region"
      aria-labelledby="fingerprint-panel-heading"
    >
      <div class="fingerprint-header">
        <h3 id="fingerprint-panel-heading">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          Verify Connection Security
        </h3>
        {onClose && (
          <button
            class="close-btn"
            onClick={onClose}
            aria-label="Close fingerprint verification panel"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <p class="fingerprint-info" id="fingerprint-instructions">
        Compare these fingerprints with your peer through a trusted channel
        (phone call, video chat, or in person) to verify your connection is secure.
      </p>

      {/* Screen reader announcement for copy actions */}
      <div aria-live="polite" aria-atomic="true" class="sr-only">
        {announcement}
      </div>

      <div class="fingerprint-section" role="group" aria-label="Your fingerprint">
        <div class="fingerprint-label">
          <span id="my-fp-display-label">Your Fingerprint</span>
          <button
            class="copy-btn-inline"
            onClick={() => copyToClipboard(myFingerprint, 'my')}
            aria-label="Copy your fingerprint to clipboard"
            aria-describedby="my-fp-display-label"
          >
            {copied === 'my' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <code
          class="fingerprint-code"
          aria-labelledby="my-fp-display-label"
          tabIndex={0}
        >
          {myFingerprint}
        </code>
      </div>

      <div class="fingerprint-section" role="group" aria-label={`Peer fingerprint for ${peerCode}`}>
        <div class="fingerprint-label">
          <span id="peer-fp-display-label">Peer Fingerprint ({peerCode})</span>
          <button
            class="copy-btn-inline"
            onClick={() => copyToClipboard(peerFingerprint, 'peer')}
            aria-label={`Copy ${peerCode}'s fingerprint to clipboard`}
            aria-describedby="peer-fp-display-label"
          >
            {copied === 'peer' ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <code
          class="fingerprint-code"
          aria-labelledby="peer-fp-display-label"
          tabIndex={0}
        >
          {peerFingerprint}
        </code>
      </div>

      <div class="fingerprint-warning" role="note">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
        </svg>
        <span>If fingerprints match, your connection is secure from interception.</span>
      </div>

      {/* Instructions for screen reader users */}
      <div class="sr-only" role="note">
        Read the fingerprints aloud to your peer or compare them visually.
        If both fingerprints match what your peer sees, your connection is secure.
      </div>
    </section>
  );
}
