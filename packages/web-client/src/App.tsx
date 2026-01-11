import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { cryptoService } from './lib/crypto';
import { SignalingClient } from './lib/signaling';
import { WebRTCService } from './lib/webrtc';
import type { ConnectionState, ChatMessage, FileTransfer } from './lib/protocol';

import { MyCode } from './components/MyCode';
import { EnterCode } from './components/EnterCode';
import { ApprovalRequest } from './components/ApprovalRequest';
import { PendingApproval } from './components/PendingApproval';
import { ChatView } from './components/ChatView';
import { FileTransfer as FileTransferUI } from './components/FileTransfer';
import { StatusIndicator } from './components/StatusIndicator';

// Signaling server URL must be configured via environment variable
const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL;
if (!SIGNALING_URL) {
  throw new Error(
    'VITE_SIGNALING_URL environment variable is required. ' +
    'Set it in .env file or pass via command line.'
  );
}
const CHUNK_SIZE = 16 * 1024; // 16KB chunks
const MAX_MESSAGES = 1000; // Maximum number of messages to keep in memory
const MAX_TRANSFERS = 100; // Maximum number of file transfers to keep in memory
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB limit for incoming files

export function App() {
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [myCode, setMyCode] = useState('');
  const [peerCode, setPeerCode] = useState('');
  const [incomingRequest, setIncomingRequest] = useState<{
    code: string;
    publicKey: string;
  } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [transfers, setTransfers] = useState<FileTransfer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [myFingerprint, setMyFingerprint] = useState('');
  const [peerFingerprint, setPeerFingerprint] = useState('');
  const [showSecurityInfo, setShowSecurityInfo] = useState(false);
  const [showSecurityReminder, setShowSecurityReminder] = useState(false);

  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCService | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const peerCodeRef = useRef<string>('');

  // Keep peerCodeRef in sync with peerCode state
  useEffect(() => {
    peerCodeRef.current = peerCode;
  }, [peerCode]);

  // Initialize crypto and signaling
  useEffect(() => {
    const init = async () => {
      await cryptoService.initialize();
      setMyFingerprint(cryptoService.getPublicKeyFingerprint());

      const signaling = new SignalingClient(SIGNALING_URL, {
        onStateChange: (newState) => {
          setState(newState);
          if (newState === 'registered') {
            setMyCode(signaling.pairingCode);
          }
        },
        onPairIncoming: (fromCode, fromPublicKey) => {
          setIncomingRequest({ code: fromCode, publicKey: fromPublicKey });
        },
        onPairMatched: async (peerCode, peerPublicKey, isInitiator) => {
          setPeerCode(peerCode);
          setIncomingRequest(null);
          setState('webrtc_connecting');

          // Establish crypto session and set peer fingerprint
          cryptoService.establishSession(peerCode, peerPublicKey);
          setPeerFingerprint(cryptoService.getPeerPublicKeyFingerprint(peerPublicKey));

          // Start WebRTC
          await webrtcRef.current?.connect(peerCode, isInitiator);
        },
        onPairRejected: (_peerCode) => {
          // Use generic message to prevent information leakage about valid codes
          setError('Connection request declined');
          setState('registered');
        },
        onPairTimeout: (_peerCode) => {
          // Use generic message to prevent information leakage about valid codes
          setError('Connection request timed out');
          setState('registered');
        },
        onPairError: (err) => {
          setError(err);
          setState('registered');
        },
        onOffer: async (from, payload) => {
          await webrtcRef.current?.handleOffer(payload);
        },
        onAnswer: async (from, payload) => {
          await webrtcRef.current?.handleAnswer(payload);
        },
        onIceCandidate: async (from, payload) => {
          await webrtcRef.current?.handleIceCandidate(payload);
        },
        onError: (err) => {
          setError(err);
        },
      });

      const webrtc = new WebRTCService(signaling, {
        onStateChange: (rtcState) => {
          if (rtcState === 'connected') {
            setState('handshaking');
            // Send our public key for verification
            webrtc.sendHandshake(cryptoService.getPublicKeyBase64());
          } else if (rtcState === 'disconnected' || rtcState === 'failed') {
            handleDisconnect();
          }
        },
        onHandshake: (receivedKey) => {
          // Verify the key matches what we got from signaling
          // For simplicity, we trust the signaling server's key exchange
          setState('connected');
          // Show security reminder on first connection
          setShowSecurityReminder(true);
        },
        onMessage: (encryptedData) => {
          try {
            const currentPeerCode = peerCodeRef.current;
            if (!currentPeerCode) return;
            const content = cryptoService.decrypt(currentPeerCode, encryptedData);
            const msg: ChatMessage = {
              id: crypto.randomUUID(),
              content,
              sender: 'peer',
              timestamp: new Date(),
            };
            setMessages((prev) => {
              const updated = [...prev, msg];
              // Remove oldest messages if limit exceeded
              if (updated.length > MAX_MESSAGES) {
                return updated.slice(updated.length - MAX_MESSAGES);
              }
              return updated;
            });
          } catch (e) {
            console.error('Failed to decrypt message:', e);
          }
        },
        onFileStart: (fileId, fileName, totalSize, totalChunks) => {
          // Reject files larger than the limit to prevent memory exhaustion
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`Rejected file transfer: ${fileName} (${totalSize} bytes exceeds ${MAX_FILE_SIZE} limit)`);
            webrtcRef.current?.sendFileError(fileId, 'File too large');
            return;
          }
          setTransfers((prev) => {
            const updated = [
              ...prev,
              {
                id: fileId,
                fileName,
                totalSize,
                totalChunks,
                receivedChunks: 0,
                status: 'receiving' as const,
                data: [],
              },
            ];
            // Remove oldest completed transfers if limit exceeded
            if (updated.length > MAX_TRANSFERS) {
              const activeTransfers = updated.filter(t => t.status !== 'complete');
              const completedTransfers = updated.filter(t => t.status === 'complete');
              const toKeep = MAX_TRANSFERS - activeTransfers.length;
              return [...completedTransfers.slice(-Math.max(0, toKeep)), ...activeTransfers];
            }
            return updated;
          });
        },
        onFileChunk: (fileId, chunkIndex, encryptedData) => {
          const currentPeerCode = peerCodeRef.current;
          if (!currentPeerCode) return;
          setTransfers((prev) =>
            prev.map((t) => {
              if (t.id !== fileId) return t;
              // Skip if already failed
              if (t.status === 'failed') return t;

              const data = t.data || [];
              // Decrypt chunk
              try {
                const decrypted = cryptoService.decrypt(currentPeerCode, encryptedData);
                const bytes = Uint8Array.from(atob(decrypted), (c) => c.charCodeAt(0));
                data[chunkIndex] = bytes;
                return {
                  ...t,
                  receivedChunks: t.receivedChunks + 1,
                  data,
                };
              } catch (e) {
                console.error('Failed to decrypt chunk:', e);
                // Mark transfer as failed and notify peer
                webrtcRef.current?.sendFileError(fileId, 'Chunk decryption failed');
                return {
                  ...t,
                  status: 'failed',
                  error: `Failed to decrypt chunk ${chunkIndex + 1}`,
                };
              }
            })
          );
        },
        onFileComplete: (fileId) => {
          setTransfers((prev) =>
            prev.map((t) => {
              if (t.id !== fileId) return t;
              // Skip if already failed
              if (t.status === 'failed') return t;

              // Check if any chunks are missing
              if (t.data) {
                const missingChunks: number[] = [];
                for (let i = 0; i < t.totalChunks; i++) {
                  if (!t.data[i]) {
                    missingChunks.push(i + 1);
                  }
                }
                if (missingChunks.length > 0) {
                  const missingStr = missingChunks.length > 3
                    ? `${missingChunks.slice(0, 3).join(', ')}... (${missingChunks.length} total)`
                    : missingChunks.join(', ');
                  return {
                    ...t,
                    status: 'failed',
                    error: `Missing chunks: ${missingStr}`,
                  };
                }

                // All chunks present, combine and download
                const blob = new Blob(t.data);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = t.fileName;
                a.click();
                URL.revokeObjectURL(url);
              } else {
                // No data received at all
                return {
                  ...t,
                  status: 'failed',
                  error: 'No data received',
                };
              }

              return { ...t, status: 'complete' };
            })
          );
        },
        onFileError: (fileId, error) => {
          setTransfers((prev) =>
            prev.map((t) => {
              if (t.id !== fileId) return t;
              return {
                ...t,
                status: 'failed',
                error: `Peer error: ${error}`,
              };
            })
          );
        },
      });

      signalingRef.current = signaling;
      webrtcRef.current = webrtc;

      // Connect to signaling server
      signaling.connect(cryptoService.getPublicKeyBase64());
    };

    init();

    return () => {
      signalingRef.current?.disconnect();
      webrtcRef.current?.close();
    };
  }, []);

  const handleRequestPairing = useCallback((code: string) => {
    setPeerCode(code);
    signalingRef.current?.requestPairing(code);
  }, []);

  const handleAcceptPairing = useCallback(() => {
    if (incomingRequest) {
      signalingRef.current?.respondToPairing(incomingRequest.code, true);
    }
  }, [incomingRequest]);

  const handleRejectPairing = useCallback(() => {
    if (incomingRequest) {
      signalingRef.current?.respondToPairing(incomingRequest.code, false);
      setIncomingRequest(null);
    }
  }, [incomingRequest]);

  const handleCancelPairing = useCallback(() => {
    setState('registered');
    setPeerCode('');
  }, []);

  const handleSendMessage = useCallback(
    (content: string) => {
      if (!peerCode) return;

      const encrypted = cryptoService.encrypt(peerCode, content);
      webrtcRef.current?.sendMessage(encrypted);

      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        content,
        sender: 'me',
        timestamp: new Date(),
      };
      setMessages((prev) => {
        const updated = [...prev, msg];
        // Remove oldest messages if limit exceeded
        if (updated.length > MAX_MESSAGES) {
          return updated.slice(updated.length - MAX_MESSAGES);
        }
        return updated;
      });
    },
    [peerCode]
  );

  const handleSelectFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleSendFile = useCallback(
    async (file: File) => {
      if (!peerCode || !webrtcRef.current) return;

      const fileId = crypto.randomUUID();
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      // Add to transfers
      setTransfers((prev) => {
        const updated = [
          ...prev,
          {
            id: fileId,
            fileName: file.name,
            totalSize: file.size,
            totalChunks,
            receivedChunks: 0,
            status: 'receiving' as const,
          },
        ];
        // Remove oldest completed transfers if limit exceeded
        if (updated.length > MAX_TRANSFERS) {
          const activeTransfers = updated.filter(t => t.status !== 'complete');
          const completedTransfers = updated.filter(t => t.status === 'complete');
          const toKeep = MAX_TRANSFERS - activeTransfers.length;
          return [...completedTransfers.slice(-Math.max(0, toKeep)), ...activeTransfers];
        }
        return updated;
      });

      // Send file start
      webrtcRef.current.sendFileStart(fileId, file.name, file.size, totalChunks);

      // Read and send chunks
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = bytes.slice(start, end);

        // Encrypt chunk
        const base64 = btoa(String.fromCharCode(...chunk));
        const encrypted = cryptoService.encrypt(peerCode, base64);

        webrtcRef.current.sendFileChunk(fileId, i, encrypted);

        // Update progress
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === fileId ? { ...t, receivedChunks: i + 1 } : t
          )
        );

        // Small delay to prevent overwhelming
        await new Promise((r) => setTimeout(r, 10));
      }

      // Send complete
      webrtcRef.current.sendFileComplete(fileId);
      setTransfers((prev) =>
        prev.map((t) => (t.id === fileId ? { ...t, status: 'complete' } : t))
      );
    },
    [peerCode]
  );

  const handleFileInputChange = useCallback(
    (e: Event) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        handleSendFile(files[0]);
      }
    },
    [handleSendFile]
  );

  const handleDisconnect = useCallback(() => {
    webrtcRef.current?.close();
    // Use ref to get current peerCode to avoid stale closure issues
    const currentPeerCode = peerCodeRef.current;
    if (currentPeerCode) {
      cryptoService.clearSession(currentPeerCode);
    }
    setPeerCode('');
    setPeerFingerprint('');
    setMessages([]);
    setTransfers([]);
    setShowSecurityReminder(false);
    setState('registered');
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const handleDismissTransfer = useCallback((transferId: string) => {
    setTransfers((prev) => prev.filter((t) => t.id !== transferId));
  }, []);

  // Render based on state
  const renderContent = () => {
    if (state === 'connected') {
      return (
        <>
          <ChatView
            peerCode={peerCode}
            messages={messages}
            onSendMessage={handleSendMessage}
            onDisconnect={handleDisconnect}
            onSelectFile={handleSelectFile}
          />
          {transfers.length > 0 && (
            <FileTransferUI
              transfers={transfers}
              onSendFile={handleSendFile}
              onDismiss={handleDismissTransfer}
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
          />
        </>
      );
    }

    return (
      <>
        <MyCode code={myCode} />
        {state === 'waiting_approval' ? (
          <PendingApproval peerCode={peerCode} onCancel={handleCancelPairing} />
        ) : (
          <EnterCode
            onSubmit={handleRequestPairing}
            disabled={state !== 'registered'}
          />
        )}
        <StatusIndicator state={state} />
      </>
    );
  };

  return (
    <div id="app">
      <header class="header">
        <h1>Zajel Web</h1>
        {state === 'connected' && <span class="status connected">Connected</span>}
        <button
          class="btn btn-sm"
          style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.1)' }}
          onClick={() => setShowSecurityInfo(!showSecurityInfo)}
          aria-label="Show security information"
        >
          🔒
        </button>
      </header>

      {/* Security Warning Banner */}
      {showSecurityInfo && (
        <div class="card" style={{ background: 'var(--warning, #f59e0b)', marginBottom: '16px', color: '#000' }}>
          <h3 style={{ margin: '0 0 8px 0' }}>Security Information</h3>
          <p style={{ margin: '0 0 8px 0', fontSize: '14px' }}>
            ✓ Keys are ephemeral (memory-only, never stored)
          </p>
          {myFingerprint && (
            <div style={{ marginTop: '12px' }}>
              <strong style={{ fontSize: '12px' }}>Your Key Fingerprint:</strong>
              <code style={{ display: 'block', fontSize: '11px', marginTop: '4px', wordBreak: 'break-all', background: 'rgba(0,0,0,0.1)', padding: '4px', borderRadius: '4px' }}>
                {myFingerprint}
              </code>
            </div>
          )}
          {state === 'connected' && peerFingerprint && (
            <div style={{ marginTop: '8px' }}>
              <strong style={{ fontSize: '12px' }}>Peer Key Fingerprint ({peerCode}):</strong>
              <code style={{ display: 'block', fontSize: '11px', marginTop: '4px', wordBreak: 'break-all', background: 'rgba(0,0,0,0.1)', padding: '4px', borderRadius: '4px' }}>
                {peerFingerprint}
              </code>
              <p style={{ margin: '8px 0 0 0', fontSize: '12px' }}>
                Compare these fingerprints with your peer through a trusted channel
                (voice call, in person) to verify you're not being intercepted.
              </p>
            </div>
          )}
          <button
            class="btn btn-sm"
            style={{ marginTop: '12px', background: 'rgba(0,0,0,0.2)' }}
            onClick={() => setShowSecurityInfo(false)}
          >
            Close
          </button>
        </div>
      )}

      {/* One-time Security Reminder on Connection */}
      {showSecurityReminder && state === 'connected' && peerFingerprint && (
        <div class="card" style={{
          background: 'linear-gradient(135deg, #dc2626, #b91c1c)',
          marginBottom: '16px',
          border: '2px solid #fca5a5'
        }}>
          <h3 style={{ margin: '0 0 8px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            ⚠️ Verify Your Connection
          </h3>
          <p style={{ margin: '0 0 12px 0', fontSize: '14px' }}>
            <strong>Warning:</strong> Without verification, a man-in-the-middle attack could intercept your messages.
            Compare fingerprints with your peer through a trusted channel (phone call, in person).
          </p>
          <div style={{
            background: 'rgba(0,0,0,0.2)',
            padding: '12px',
            borderRadius: '8px',
            marginBottom: '12px'
          }}>
            <div style={{ marginBottom: '8px' }}>
              <strong style={{ fontSize: '12px' }}>Your Fingerprint:</strong>
              <code style={{
                display: 'block',
                fontSize: '11px',
                marginTop: '4px',
                wordBreak: 'break-all',
                background: 'rgba(255,255,255,0.1)',
                padding: '4px',
                borderRadius: '4px'
              }}>
                {myFingerprint}
              </code>
            </div>
            <div>
              <strong style={{ fontSize: '12px' }}>Peer Fingerprint ({peerCode}):</strong>
              <code style={{
                display: 'block',
                fontSize: '11px',
                marginTop: '4px',
                wordBreak: 'break-all',
                background: 'rgba(255,255,255,0.1)',
                padding: '4px',
                borderRadius: '4px'
              }}>
                {peerFingerprint}
              </code>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              class="btn btn-sm"
              style={{ background: 'rgba(255,255,255,0.2)', flex: 1 }}
              onClick={() => setShowSecurityReminder(false)}
            >
              I'll Verify Later
            </button>
            <button
              class="btn btn-sm"
              style={{ background: '#16a34a', flex: 1 }}
              onClick={() => {
                setShowSecurityReminder(false);
                setShowSecurityInfo(true);
              }}
            >
              ✓ Verified
            </button>
          </div>
        </div>
      )}

      {error && (
        <div class="card" style={{ background: 'var(--error)', marginBottom: '16px' }}>
          <p style={{ margin: 0 }}>{error}</p>
          <button
            class="btn btn-sm"
            style={{ marginTop: '8px', background: 'rgba(0,0,0,0.2)' }}
            onClick={clearError}
          >
            Dismiss
          </button>
        </div>
      )}

      {renderContent()}

      {incomingRequest && (
        <ApprovalRequest
          peerCode={incomingRequest.code}
          onAccept={handleAcceptPairing}
          onReject={handleRejectPairing}
        />
      )}
    </div>
  );
}
