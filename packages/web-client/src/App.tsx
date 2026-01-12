import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { cryptoService } from './lib/crypto';
import { SignalingClient } from './lib/signaling';
import { WebRTCService } from './lib/webrtc';
import type { ConnectionState, ChatMessage, FileTransfer } from './lib/protocol';
import { FileTransferManager } from './lib/fileTransferManager';
import { FILE_TRANSFER, MESSAGE_LIMITS } from './lib/constants';
import { sanitizeFilename, sanitizeMessage, sanitizeErrorMessage } from './lib/validation';
import { handleError, isCryptoError, ErrorCodes } from './lib/errors';

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

export function App() {
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [myCode, setMyCode] = useState('');
  const [peerCode, setPeerCode] = useState('');
  const [incomingRequest, setIncomingRequest] = useState<{
    code: string;
    publicKey: string;
  } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [transfers, setTransfers] = useState<Map<string, FileTransfer>>(new Map());
  // Ref for immediate transfer state storage to avoid race conditions with async state updates
  const transfersMapRef = useRef<Map<string, FileTransfer>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [myFingerprint, setMyFingerprint] = useState('');
  const [peerFingerprint, setPeerFingerprint] = useState('');
  const [showSecurityInfo, setShowSecurityInfo] = useState(false);
  const [showSecurityReminder, setShowSecurityReminder] = useState(false);

  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCService | null>(null);
  // TODO: Integrate FileTransferManager for reliable file transfers
  // @ts-expect-error - Will be used in future reliable file transfer implementation
  const _fileTransferManagerRef = useRef<FileTransferManager | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const peerCodeRef = useRef<string>('');

  // Keep peerCodeRef in sync with peerCode state
  useEffect(() => {
    peerCodeRef.current = peerCode;
  }, [peerCode]);

  // Initialize crypto and signaling
  useEffect(() => {
    const init = async () => {
      try {
        await cryptoService.initialize();
        setMyFingerprint(cryptoService.getPublicKeyFingerprint());
      } catch (e) {
        const err = handleError(e, 'crypto.initialize', ErrorCodes.INITIALIZATION_FAILED);
        setError(err.userMessage);
        return; // Don't continue if crypto initialization fails
      }

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
        onPairExpiring: (_peerCode, _remainingSeconds) => {
          // Could show warning to user that pairing is about to expire
          // For now, we just ignore this - the timeout will handle it
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
          // Sanitize error message from server to prevent XSS
          setError(sanitizeErrorMessage(err));
          setState('registered');
        },
        onOffer: async (_from, payload) => {
          await webrtcRef.current?.handleOffer(payload);
        },
        onAnswer: async (_from, payload) => {
          await webrtcRef.current?.handleAnswer(payload);
        },
        onIceCandidate: async (_from, payload) => {
          await webrtcRef.current?.handleIceCandidate(payload);
        },
        onError: (err) => {
          // Sanitize error message from server to prevent XSS
          setError(sanitizeErrorMessage(err));
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
          // This prevents MITM attacks where an attacker substitutes their own key
          const currentPeerCode = peerCodeRef.current;
          if (!currentPeerCode) {
            console.error('Handshake verification failed: no peer code');
            setError('Security error: Connection verification failed');
            handleDisconnect();
            return;
          }

          if (!cryptoService.verifyPeerKey(currentPeerCode, receivedKey)) {
            console.error('Handshake verification failed: key mismatch - possible MITM attack!');
            setError('Security error: Key verification failed. The connection may have been intercepted.');
            handleDisconnect();
            return;
          }

          setState('connected');
          // Show security reminder on first connection
          setShowSecurityReminder(true);
        },
        onMessage: (encryptedData) => {
          try {
            const currentPeerCode = peerCodeRef.current;
            if (!currentPeerCode) return;
            const decryptedContent = cryptoService.decrypt(currentPeerCode, encryptedData);
            // Sanitize message content to remove control characters (defense in depth)
            const content = sanitizeMessage(decryptedContent);
            const msg: ChatMessage = {
              id: crypto.randomUUID(),
              content,
              sender: 'peer',
              timestamp: new Date(),
            };
            setMessages((prev) => {
              const updated = [...prev, msg];
              // Remove oldest messages if limit exceeded
              if (updated.length > MESSAGE_LIMITS.MAX_MESSAGES) {
                return updated.slice(updated.length - MESSAGE_LIMITS.MAX_MESSAGES);
              }
              return updated;
            });
          } catch (e) {
            // Use centralized error handling
            const err = handleError(e, 'message.decrypt', ErrorCodes.CRYPTO_DECRYPTION_FAILED);

            // Show user-friendly message for crypto errors
            if (isCryptoError(e)) {
              setError(err.userMessage);
            } else {
              // Add a system message to indicate decryption failure
              setMessages((prev) => {
                const systemMsg: ChatMessage = {
                  id: crypto.randomUUID(),
                  content: '[Message could not be decrypted]',
                  sender: 'peer',
                  timestamp: new Date(),
                };
                const updated = [...prev, systemMsg];
                if (updated.length > MESSAGE_LIMITS.MAX_MESSAGES) {
                  return updated.slice(updated.length - MESSAGE_LIMITS.MAX_MESSAGES);
                }
                return updated;
              });
            }
          }
        },
        onFileStart: (fileId, fileName, totalSize, totalChunks) => {
          // Reject files larger than the limit to prevent memory exhaustion
          if (totalSize > FILE_TRANSFER.MAX_FILE_SIZE) {
            console.warn(`Rejected file transfer: ${fileName} (${totalSize} bytes exceeds ${FILE_TRANSFER.MAX_FILE_SIZE} limit)`);
            webrtcRef.current?.sendFileError(fileId, 'File too large');
            return;
          }
          // Sanitize filename to remove path separators and control characters
          const sanitizedFileName = sanitizeFilename(fileName);

          // Create new transfer and store in ref immediately (synchronous)
          const newTransfer: FileTransfer = {
            id: fileId,
            fileName: sanitizedFileName,
            totalSize,
            totalChunks,
            receivedChunks: 0,
            status: 'receiving' as const,
            data: [],
            lastActivityTime: Date.now(),
          };
          transfersMapRef.current.set(fileId, newTransfer);

          // Remove oldest completed transfers if limit exceeded
          if (transfersMapRef.current.size > FILE_TRANSFER.MAX_TRANSFERS) {
            const entries = Array.from(transfersMapRef.current.entries());
            const completedIds = entries
              .filter(([, t]) => t.status === 'complete')
              .map(([id]) => id);
            // Remove oldest completed transfers first
            for (const id of completedIds) {
              if (transfersMapRef.current.size <= FILE_TRANSFER.MAX_TRANSFERS) break;
              transfersMapRef.current.delete(id);
            }
          }

          // Sync to React state
          setTransfers(new Map(transfersMapRef.current));
        },
        onFileChunk: (fileId, chunkIndex, encryptedData) => {
          const currentPeerCode = peerCodeRef.current;
          if (!currentPeerCode) return;

          // Read from ref immediately (synchronous) to avoid race conditions
          const transfer = transfersMapRef.current.get(fileId);
          if (!transfer) {
            console.warn(`Received chunk for unknown transfer: ${fileId}`);
            return;
          }

          // Skip if already failed
          if (transfer.status === 'failed') return;

          const data = transfer.data || [];
          // Decrypt chunk
          try {
            const decrypted = cryptoService.decrypt(currentPeerCode, encryptedData);
            const bytes = Uint8Array.from(atob(decrypted), (c) => c.charCodeAt(0));
            data[chunkIndex] = bytes;

            // Update ref immediately (synchronous)
            const updatedTransfer: FileTransfer = {
              ...transfer,
              receivedChunks: transfer.receivedChunks + 1,
              data,
              lastActivityTime: Date.now(),
            };
            transfersMapRef.current.set(fileId, updatedTransfer);

            // Sync to React state
            setTransfers(new Map(transfersMapRef.current));
          } catch (e) {
            // Use centralized error handling
            const err = handleError(e, 'file.chunk.decrypt', ErrorCodes.CRYPTO_DECRYPTION_FAILED);
            const userMessage = isCryptoError(e)
              ? err.userMessage
              : `Failed to decrypt chunk ${chunkIndex + 1}`;

            // Mark transfer as failed in ref immediately
            const failedTransfer: FileTransfer = {
              ...transfer,
              status: 'failed',
              error: userMessage,
            };
            transfersMapRef.current.set(fileId, failedTransfer);

            // Notify peer
            webrtcRef.current?.sendFileError(fileId, userMessage);

            // Sync to React state
            setTransfers(new Map(transfersMapRef.current));
          }
        },
        onFileComplete: (fileId) => {
          const transfer = transfersMapRef.current.get(fileId);
          if (!transfer) return;
          // Skip if already failed
          if (transfer.status === 'failed') return;

          // Check if any chunks are missing
          if (transfer.data) {
            const missingChunks: number[] = [];
            for (let i = 0; i < transfer.totalChunks; i++) {
              if (!transfer.data[i]) {
                missingChunks.push(i + 1);
              }
            }
            if (missingChunks.length > 0) {
              const missingStr = missingChunks.length > 3
                ? `${missingChunks.slice(0, 3).join(', ')}... (${missingChunks.length} total)`
                : missingChunks.join(', ');
              transfersMapRef.current.set(fileId, {
                ...transfer,
                status: 'failed',
                error: `Missing chunks: ${missingStr}`,
              });
              setTransfers(new Map(transfersMapRef.current));
              return;
            }

            // All chunks present, combine and download
            const blob = new Blob(transfer.data as BlobPart[]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = transfer.fileName;
            a.click();
            URL.revokeObjectURL(url);
          } else {
            // No data received at all
            transfersMapRef.current.set(fileId, {
              ...transfer,
              status: 'failed',
              error: 'No data received',
            });
            setTransfers(new Map(transfersMapRef.current));
            return;
          }

          transfersMapRef.current.set(fileId, { ...transfer, status: 'complete' });
          setTransfers(new Map(transfersMapRef.current));
        },
        onFileError: (fileId, error) => {
          // Sanitize error message from peer to prevent XSS
          const sanitizedError = sanitizeErrorMessage(error);
          const transfer = transfersMapRef.current.get(fileId);
          if (transfer) {
            transfersMapRef.current.set(fileId, {
              ...transfer,
              status: 'failed',
              error: `Peer error: ${sanitizedError}`,
            });
            setTransfers(new Map(transfersMapRef.current));
          }
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
        if (updated.length > MESSAGE_LIMITS.MAX_MESSAGES) {
          return updated.slice(updated.length - MESSAGE_LIMITS.MAX_MESSAGES);
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
      const totalChunks = Math.ceil(file.size / FILE_TRANSFER.CHUNK_SIZE);

      // Add to transfers using Map ref for consistency
      const newTransfer: FileTransfer = {
        id: fileId,
        fileName: file.name,
        totalSize: file.size,
        totalChunks,
        receivedChunks: 0,
        status: 'sending' as const,
        lastActivityTime: Date.now(),
      };
      transfersMapRef.current.set(fileId, newTransfer);

      // Remove oldest completed transfers if limit exceeded
      if (transfersMapRef.current.size > FILE_TRANSFER.MAX_TRANSFERS) {
        const entries = Array.from(transfersMapRef.current.entries());
        const completedIds = entries
          .filter(([, t]) => t.status === 'complete')
          .map(([id]) => id);
        for (const id of completedIds) {
          if (transfersMapRef.current.size <= FILE_TRANSFER.MAX_TRANSFERS) break;
          transfersMapRef.current.delete(id);
        }
      }

      // Sync to React state
      setTransfers(new Map(transfersMapRef.current));

      // Send file start
      webrtcRef.current.sendFileStart(fileId, file.name, file.size, totalChunks);

      // Read and send chunks with backpressure handling
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * FILE_TRANSFER.CHUNK_SIZE;
        const end = Math.min(start + FILE_TRANSFER.CHUNK_SIZE, file.size);
        const chunk = bytes.slice(start, end);

        // Encrypt chunk
        const base64 = btoa(String.fromCharCode(...chunk));
        const encrypted = cryptoService.encrypt(peerCode, base64);

        // Send with backpressure handling - awaits buffer drain if needed
        const sent = await webrtcRef.current.sendFileChunk(fileId, i, encrypted);

        if (!sent) {
          // Channel closed or error occurred
          const failedTransfer = transfersMapRef.current.get(fileId);
          if (failedTransfer) {
            transfersMapRef.current.set(fileId, {
              ...failedTransfer,
              status: 'failed' as const,
              error: 'Connection lost during transfer',
            });
            setTransfers(new Map(transfersMapRef.current));
          }
          return;
        }

        // Update progress and lastActivityTime
        const currentTransfer = transfersMapRef.current.get(fileId);
        if (currentTransfer) {
          transfersMapRef.current.set(fileId, {
            ...currentTransfer,
            receivedChunks: i + 1,
            lastActivityTime: Date.now(),
          });
          setTransfers(new Map(transfersMapRef.current));
        }
      }

      // Send complete
      webrtcRef.current.sendFileComplete(fileId);
      const completedTransfer = transfersMapRef.current.get(fileId);
      if (completedTransfer) {
        transfersMapRef.current.set(fileId, {
          ...completedTransfer,
          status: 'complete' as const,
        });
        setTransfers(new Map(transfersMapRef.current));
      }
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
    // Clear transfers using Map
    transfersMapRef.current.clear();
    setTransfers(new Map());
    setShowSecurityReminder(false);
    setState('registered');
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const handleDismissTransfer = useCallback((transferId: string) => {
    transfersMapRef.current.delete(transferId);
    setTransfers(new Map(transfersMapRef.current));
  }, []);

  // Handle transfer timeout - cancel the transfer and notify peer
  const handleTransferTimeout = useCallback((fileId: string) => {
    const transfer = transfersMapRef.current.get(fileId);
    if (!transfer) return;

    // Mark as failed due to timeout
    transfersMapRef.current.set(fileId, {
      ...transfer,
      status: 'failed',
      error: 'Transfer stalled - no activity for 30 seconds',
    });
    setTransfers(new Map(transfersMapRef.current));

    // Notify peer about the timeout/cancellation
    webrtcRef.current?.sendTransferCancel(fileId, 'timeout');
  }, []);

  // Stall detection interval - check for transfers with no activity for >30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      transfersMapRef.current.forEach((transfer, fileId) => {
        // Only check active transfers (receiving or sending)
        if (transfer.status === 'receiving' || transfer.status === 'sending') {
          const lastActivity = transfer.lastActivityTime || 0;
          if (lastActivity > 0 && now - lastActivity > FILE_TRANSFER.STALL_TIMEOUT_MS) {
            handleTransferTimeout(fileId);
          }
        }
      });
    }, FILE_TRANSFER.STALL_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [handleTransferTimeout]);

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
            myFingerprint={myFingerprint}
            peerFingerprint={peerFingerprint}
          />
          {transfers.size > 0 && (
            <FileTransferUI
              transfers={Array.from(transfers.values())}
              onSendFile={handleSendFile}
              onDismiss={handleDismissTransfer}
            />
          )}
          <label htmlFor="hidden-file-input" class="sr-only">
            Select file to send
          </label>
          <input
            ref={fileInputRef}
            id="hidden-file-input"
            type="file"
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
            aria-hidden="true"
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
      {/* Skip link for keyboard users */}
      <a href="#main-content" class="skip-link sr-only-focusable">
        Skip to main content
      </a>

      <header class="header" role="banner">
        <h1>Zajel Web</h1>
        {state === 'connected' && (
          <span class="status connected" role="status" aria-live="polite">
            Connected
          </span>
        )}
        <button
          class="btn btn-sm"
          style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.1)' }}
          onClick={() => setShowSecurityInfo(!showSecurityInfo)}
          aria-label={showSecurityInfo ? 'Hide security information' : 'Show security information'}
          aria-expanded={showSecurityInfo}
        >
          <span aria-hidden="true">🔒</span>
          <span class="sr-only">Security</span>
        </button>
      </header>

      {/* Security Warning Banner */}
      {showSecurityInfo && (
        <aside
          class="card"
          style={{ background: 'var(--warning, #f59e0b)', marginBottom: '16px', color: '#000' }}
          role="complementary"
          aria-labelledby="security-info-heading"
        >
          <h3 id="security-info-heading" style={{ margin: '0 0 8px 0' }}>Security Information</h3>
          <p style={{ margin: '0 0 8px 0', fontSize: '14px' }}>
            <span aria-hidden="true">✓</span> Keys are ephemeral (memory-only, never stored)
          </p>
          {myFingerprint && (
            <div style={{ marginTop: '12px' }}>
              <strong id="my-fingerprint-label" style={{ fontSize: '12px' }}>Your Key Fingerprint:</strong>
              <code
                aria-labelledby="my-fingerprint-label"
                tabIndex={0}
                style={{ display: 'block', fontSize: '11px', marginTop: '4px', wordBreak: 'break-all', background: 'rgba(0,0,0,0.1)', padding: '4px', borderRadius: '4px' }}
              >
                {myFingerprint}
              </code>
            </div>
          )}
          {state === 'connected' && peerFingerprint && (
            <div style={{ marginTop: '8px' }}>
              <strong id="peer-fingerprint-label" style={{ fontSize: '12px' }}>Peer Key Fingerprint ({peerCode}):</strong>
              <code
                aria-labelledby="peer-fingerprint-label"
                tabIndex={0}
                style={{ display: 'block', fontSize: '11px', marginTop: '4px', wordBreak: 'break-all', background: 'rgba(0,0,0,0.1)', padding: '4px', borderRadius: '4px' }}
              >
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
            aria-label="Close security information panel"
          >
            Close
          </button>
        </aside>
      )}

      {/* One-time Security Reminder on Connection */}
      {showSecurityReminder && state === 'connected' && peerFingerprint && (
        <div
          class="card"
          role="alertdialog"
          aria-labelledby="security-reminder-title"
          aria-describedby="security-reminder-desc"
          style={{
            background: 'linear-gradient(135deg, #dc2626, #b91c1c)',
            marginBottom: '16px',
            border: '2px solid #fca5a5'
          }}
        >
          <h3 id="security-reminder-title" style={{ margin: '0 0 8px 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span aria-hidden="true">⚠️</span> Verify Your Connection
          </h3>
          <div id="security-reminder-desc">
            <p style={{ margin: '0 0 12px 0', fontSize: '14px' }}>
              <strong>Warning:</strong> Without verification, a man-in-the-middle attack could intercept your messages.
              Compare fingerprints with your peer through a trusted channel (phone call, in person).
            </p>
          </div>
          <div
            role="group"
            aria-label="Fingerprint comparison for verification"
            style={{
              background: 'rgba(0,0,0,0.2)',
              padding: '12px',
              borderRadius: '8px',
              marginBottom: '12px'
            }}
          >
            <div style={{ marginBottom: '8px' }}>
              <strong id="reminder-my-fp-label" style={{ fontSize: '12px' }}>Your Fingerprint:</strong>
              <code
                aria-labelledby="reminder-my-fp-label"
                tabIndex={0}
                style={{
                  display: 'block',
                  fontSize: '11px',
                  marginTop: '4px',
                  wordBreak: 'break-all',
                  background: 'rgba(255,255,255,0.1)',
                  padding: '4px',
                  borderRadius: '4px'
                }}
              >
                {myFingerprint}
              </code>
            </div>
            <div>
              <strong id="reminder-peer-fp-label" style={{ fontSize: '12px' }}>Peer Fingerprint ({peerCode}):</strong>
              <code
                aria-labelledby="reminder-peer-fp-label"
                tabIndex={0}
                style={{
                  display: 'block',
                  fontSize: '11px',
                  marginTop: '4px',
                  wordBreak: 'break-all',
                  background: 'rgba(255,255,255,0.1)',
                  padding: '4px',
                  borderRadius: '4px'
                }}
              >
                {peerFingerprint}
              </code>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }} role="group" aria-label="Verification actions">
            <button
              class="btn btn-sm"
              style={{ background: 'rgba(255,255,255,0.2)', flex: 1 }}
              onClick={() => setShowSecurityReminder(false)}
              aria-label="Dismiss reminder and verify later"
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
              aria-label="Mark as verified and show security information"
            >
              <span aria-hidden="true">✓</span> Verified
            </button>
          </div>
        </div>
      )}

      {error && (
        <div
          class="card"
          role="alert"
          aria-live="assertive"
          style={{ background: 'var(--error)', marginBottom: '16px' }}
        >
          <p style={{ margin: 0 }}>{error}</p>
          <button
            class="btn btn-sm"
            style={{ marginTop: '8px', background: 'rgba(0,0,0,0.2)' }}
            onClick={clearError}
            aria-label="Dismiss error message"
          >
            Dismiss
          </button>
        </div>
      )}

      <div id="main-content">
        {renderContent()}
      </div>

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
