import { useState, useCallback } from 'preact/hooks';
import type { LinkData, DeviceLinkState } from '../lib/deviceLink';
import { parseLinkQrData } from '../lib/deviceLink';
import { sanitizeErrorMessage } from '../lib/validation';

interface LinkWithMobileProps {
  onLink: (linkData: LinkData) => void;
  state: DeviceLinkState;
  error: string | null;
  onClearError: () => void;
}

/**
 * Component for linking web client to a mobile app.
 *
 * Displays a form for entering the link code from the mobile app's QR code.
 * Once linked, all messages are proxied through the mobile app's secure connection.
 */
export function LinkWithMobile({
  onLink,
  state,
  error,
  onClearError,
}: LinkWithMobileProps) {
  const [linkCode, setLinkCode] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);
  const [qrInput, setQrInput] = useState('');

  const handleQrPaste = useCallback(
    (e: Event) => {
      const value = (e.target as HTMLInputElement).value;
      setQrInput(value);

      // Try to parse as QR data
      const linkData = parseLinkQrData(value);
      if (linkData) {
        onLink(linkData);
      }
    },
    [onLink]
  );

  const handleManualSubmit = useCallback(
    (e: Event) => {
      e.preventDefault();

      if (!linkCode || linkCode.length !== 6) {
        return;
      }

      if (!serverUrl) {
        return;
      }

      // For manual entry, we need the mobile's public key
      // This would typically come from scanning the QR code
      // For now, we'll try to connect and get it from the server
      // TODO: Implement proper manual entry flow
      onLink({
        linkCode: linkCode.toUpperCase(),
        publicKey: '', // Will be received from signaling
        serverUrl,
      });
    },
    [linkCode, serverUrl, onLink]
  );

  const isConnecting = state === 'connecting' || state === 'handshaking';

  return (
    <section class="card" aria-labelledby="link-heading">
      <div
        style={{
          background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
          padding: '24px',
          borderRadius: '12px',
          marginBottom: '16px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: '48px',
            marginBottom: '12px',
          }}
          aria-hidden="true"
        >
          📱
        </div>
        <h2
          id="link-heading"
          style={{
            margin: '0 0 8px 0',
            fontSize: '20px',
            fontWeight: '600',
          }}
        >
          Link with Mobile App
        </h2>
        <p
          style={{
            margin: '0',
            opacity: 0.9,
            fontSize: '14px',
            lineHeight: '1.4',
          }}
        >
          Web browsers cannot verify server certificates. Link your browser to
          the Zajel mobile app for secure, verified messaging.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            background: 'var(--error)',
            padding: '12px',
            borderRadius: '8px',
            marginBottom: '16px',
          }}
        >
          <p style={{ margin: '0 0 8px 0' }}>{sanitizeErrorMessage(error)}</p>
          <button
            class="btn btn-sm"
            style={{ background: 'rgba(0,0,0,0.2)' }}
            onClick={onClearError}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* How it works section */}
      <div
        style={{
          background: 'rgba(255,255,255,0.05)',
          padding: '16px',
          borderRadius: '8px',
          marginBottom: '16px',
        }}
      >
        <h3
          style={{
            margin: '0 0 12px 0',
            fontSize: '14px',
            fontWeight: '600',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span aria-hidden="true">🔒</span> How it works
        </h3>
        <ol
          style={{
            margin: '0',
            paddingLeft: '20px',
            fontSize: '13px',
            lineHeight: '1.6',
          }}
        >
          <li>Open Zajel on your mobile device</li>
          <li>Go to Connect → Link Web tab</li>
          <li>Tap "Generate Link Code" to display a QR code</li>
          <li>Paste the QR data below or enter the code manually</li>
        </ol>
      </div>

      {!manualEntry ? (
        <>
          {/* QR Data Paste Input */}
          <div style={{ marginBottom: '16px' }}>
            <label
              htmlFor="qr-input"
              style={{
                display: 'block',
                marginBottom: '8px',
                fontSize: '14px',
                fontWeight: '500',
              }}
            >
              Paste QR Code Data
            </label>
            <input
              id="qr-input"
              type="text"
              class="input"
              placeholder="zajel-link://..."
              value={qrInput}
              onInput={handleQrPaste}
              disabled={isConnecting}
              aria-describedby="qr-hint"
              style={{
                width: '100%',
                padding: '12px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(255,255,255,0.1)',
              }}
            />
            <p
              id="qr-hint"
              style={{
                margin: '8px 0 0 0',
                fontSize: '12px',
                opacity: 0.7,
              }}
            >
              Copy the QR code data from your mobile app and paste it here
            </p>
          </div>

          <div
            style={{
              textAlign: 'center',
              marginBottom: '16px',
            }}
          >
            <button
              class="btn btn-sm"
              onClick={() => setManualEntry(true)}
              disabled={isConnecting}
              aria-label="Switch to manual code entry"
              style={{
                background: 'transparent',
                textDecoration: 'underline',
              }}
            >
              Or enter code manually
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Manual Entry Form */}
          <form onSubmit={handleManualSubmit} aria-labelledby="link-heading">
            <div style={{ marginBottom: '16px' }}>
              <label
                htmlFor="link-code"
                style={{
                  display: 'block',
                  marginBottom: '8px',
                  fontSize: '14px',
                  fontWeight: '500',
                }}
              >
                Link Code
              </label>
              <input
                id="link-code"
                type="text"
                class="input"
                placeholder="Enter 6-character code"
                maxLength={6}
                value={linkCode}
                onInput={(e) =>
                  setLinkCode((e.target as HTMLInputElement).value.toUpperCase())
                }
                disabled={isConnecting}
                aria-required="true"
                aria-describedby="link-code-hint"
                autoComplete="off"
                autoCapitalize="characters"
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: 'rgba(255,255,255,0.1)',
                  fontSize: '24px',
                  fontFamily: 'monospace',
                  letterSpacing: '4px',
                  textAlign: 'center',
                }}
              />
              <span id="link-code-hint" class="sr-only">
                Enter the 6-character code shown on your mobile device
              </span>
            </div>

            <button
              type="button"
              class="btn btn-sm"
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                marginBottom: '16px',
                background: 'transparent',
                border: 'none',
                textDecoration: 'underline',
                cursor: 'pointer',
              }}
              aria-expanded={showAdvanced}
              aria-controls="advanced-settings"
              aria-label={showAdvanced ? 'Hide advanced server settings' : 'Show advanced server settings'}
            >
              {showAdvanced ? 'Hide' : 'Show'} server settings
            </button>

            {showAdvanced && (
              <div id="advanced-settings" style={{ marginBottom: '16px' }}>
                <label
                  htmlFor="server-url"
                  style={{
                    display: 'block',
                    marginBottom: '8px',
                    fontSize: '14px',
                    fontWeight: '500',
                  }}
                >
                  Signaling Server URL
                </label>
                <input
                  id="server-url"
                  type="url"
                  class="input"
                  placeholder="wss://..."
                  value={serverUrl}
                  onInput={(e) =>
                    setServerUrl((e.target as HTMLInputElement).value)
                  }
                  disabled={isConnecting}
                  aria-describedby="server-url-hint"
                  style={{
                    width: '100%',
                    padding: '12px',
                    borderRadius: '8px',
                    border: '1px solid rgba(255,255,255,0.2)',
                    background: 'rgba(255,255,255,0.1)',
                  }}
                />
                <span id="server-url-hint" class="sr-only">
                  WebSocket URL of the signaling server, typically starts with wss://
                </span>
              </div>
            )}

            <button
              type="submit"
              class="btn btn-primary"
              disabled={
                isConnecting || linkCode.length !== 6 || !serverUrl
              }
              aria-disabled={isConnecting || linkCode.length !== 6 || !serverUrl}
              aria-busy={isConnecting}
              aria-label={isConnecting ? 'Connecting to mobile device' : 'Link this browser to your mobile device'}
              style={{
                width: '100%',
                padding: '14px',
                fontSize: '16px',
                fontWeight: '600',
              }}
            >
              {isConnecting ? (
                <span>
                  <span
                    class="spinner"
                    role="status"
                    style={{
                      display: 'inline-block',
                      marginRight: '8px',
                    }}
                    aria-hidden="true"
                  >
                    ◌
                  </span>
                  <span aria-live="polite">Connecting...</span>
                </span>
              ) : (
                'Link Device'
              )}
            </button>
          </form>

          <div
            style={{
              textAlign: 'center',
              marginTop: '16px',
            }}
          >
            <button
              class="btn btn-sm"
              onClick={() => setManualEntry(false)}
              disabled={isConnecting}
              aria-label="Go back to QR code paste method"
              style={{
                background: 'transparent',
                textDecoration: 'underline',
              }}
            >
              Back to QR paste
            </button>
          </div>
        </>
      )}

      {/* Connection status */}
      {isConnecting && (
        <div
          role="status"
          aria-live="polite"
          style={{
            marginTop: '16px',
            padding: '12px',
            background: 'rgba(255,255,255,0.05)',
            borderRadius: '8px',
            textAlign: 'center',
          }}
        >
          <p style={{ margin: '0', fontSize: '14px' }}>
            {state === 'connecting' && 'Connecting to mobile app...'}
            {state === 'handshaking' && 'Verifying connection security...'}
          </p>
        </div>
      )}

      {/* Security note */}
      <aside
        role="note"
        aria-label="Security warning"
        style={{
          marginTop: '24px',
          padding: '12px',
          background: 'rgba(245, 158, 11, 0.1)',
          borderRadius: '8px',
          border: '1px solid rgba(245, 158, 11, 0.3)',
        }}
      >
        <p
          style={{
            margin: '0',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'start',
            gap: '8px',
          }}
        >
          <span aria-hidden="true" style={{ fontSize: '16px' }}>
            ⚠️
          </span>
          <span>
            <strong>Security note:</strong> Only scan QR codes from your own
            mobile device. Never enter link codes shared by others.
          </span>
        </p>
      </aside>
    </section>
  );
}
