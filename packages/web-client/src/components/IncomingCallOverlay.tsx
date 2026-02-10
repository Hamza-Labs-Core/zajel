import { useEffect, useRef, useCallback } from 'preact/hooks';
import { notifyIncomingCall } from '../lib/notifications';

interface IncomingCallOverlayProps {
  callerName: string;
  callId: string;
  withVideo: boolean;
  onAccept: (withVideo: boolean) => void;
  onReject: () => void;
}

/**
 * Overlay shown when receiving an incoming call.
 * Displays caller information and accept/reject buttons.
 */
export function IncomingCallOverlay({
  callerName,
  callId: _callId, // Reserved for future use (e.g., logging, analytics)
  withVideo,
  onAccept,
  onReject,
}: IncomingCallOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const acceptButtonRef = useRef<HTMLButtonElement>(null);

  // Focus the accept button when the dialog opens and notify
  useEffect(() => {
    acceptButtonRef.current?.focus();
    notifyIncomingCall(callerName, withVideo);
  }, [callerName, withVideo]);

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

  const handleAcceptAudio = () => {
    onAccept(false);
  };

  const handleAcceptVideo = () => {
    onAccept(true);
  };

  return (
    <div
      class="call-overlay"
      role="presentation"
    >
      <div
        ref={dialogRef}
        class="incoming-call-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="incoming-call-title"
        aria-describedby="incoming-call-desc"
        onKeyDown={handleKeyDownFocusTrap}
      >
        {/* Caller avatar */}
        <div class="caller-avatar" aria-hidden="true">
          <svg
            width="64"
            height="64"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
          </svg>
        </div>

        {/* Caller name */}
        <h3 id="incoming-call-title" class="caller-name">
          {callerName}
        </h3>

        {/* Call type indicator */}
        <p id="incoming-call-desc" class="call-type">
          {withVideo ? (
            <>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
              </svg>
              <span>Incoming video call</span>
            </>
          ) : (
            <>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" />
              </svg>
              <span>Incoming call</span>
            </>
          )}
        </p>

        {/* Ringing animation */}
        <div class="ringing-indicator" aria-hidden="true">
          <span class="ring-pulse ring-1"></span>
          <span class="ring-pulse ring-2"></span>
          <span class="ring-pulse ring-3"></span>
        </div>

        {/* Action buttons */}
        <div class="call-actions" role="group" aria-label="Call actions">
          {/* Reject button */}
          <button
            class="call-btn call-btn-reject"
            onClick={onReject}
            aria-label={`Reject call from ${callerName}`}
            title="Reject"
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
            </svg>
          </button>

          {/* Accept audio button */}
          <button
            ref={acceptButtonRef}
            class="call-btn call-btn-accept"
            onClick={handleAcceptAudio}
            aria-label={`Accept ${withVideo ? 'audio only' : 'call'} from ${callerName}`}
            title={withVideo ? 'Accept (audio only)' : 'Accept'}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" />
            </svg>
          </button>

          {/* Accept video button (only show if caller is making video call) */}
          {withVideo && (
            <button
              class="call-btn call-btn-accept-video"
              onClick={handleAcceptVideo}
              aria-label={`Accept video call from ${callerName}`}
              title="Accept with video"
            >
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
              </svg>
            </button>
          )}
        </div>

        {/* Screen reader instruction */}
        <p class="sr-only">
          Press Escape to reject this call. Tab to navigate between accept and reject buttons.
        </p>
      </div>
    </div>
  );
}
