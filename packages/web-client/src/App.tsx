import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import type { ConnectionState } from './lib/protocol';
import { logger } from './lib/logger';

import { useCrypto, useSignaling, useWebRTC, useFileTransfer, useMessages } from './hooks';

import {
  MyCode,
  EnterCode,
  ApprovalRequest,
  PendingApproval,
  ChatView,
  FileTransfer as FileTransferUI,
  StatusIndicator,
  SecurityInfoPanel,
  SecurityReminder,
  ErrorBanner,
} from './components';

export function App() {
  // App-level state
  const [appState, setAppState] = useState<ConnectionState>('disconnected');
  const [peerCode, setPeerCode] = useState('');
  const [peerFingerprint, setPeerFingerprint] = useState('');
  const [showSecurityInfo, setShowSecurityInfo] = useState(false);
  const [showSecurityReminder, setShowSecurityReminder] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const peerCodeRef = useRef<string>('');

  // Keep peerCodeRef in sync with peerCode state
  useEffect(() => {
    peerCodeRef.current = peerCode;
  }, [peerCode]);

  // Initialize crypto hook
  const crypto = useCrypto();

  // File transfer callbacks ref (will be populated later)
  const fileTransferCallbacksRef = useRef({
    getPeerCode: () => peerCodeRef.current,
    decrypt: (peerId: string, ciphertext: string) => crypto.decrypt(peerId, ciphertext),
    encrypt: (peerId: string, plaintext: string) => crypto.encrypt(peerId, plaintext),
    sendFileError: (_fileId: string, _error: string) => {},
    sendFileStart: (_fileId: string, _fileName: string, _totalSize: number, _totalChunks: number): boolean => false,
    sendFileChunk: async (_fileId: string, _chunkIndex: number, _data: string): Promise<boolean> => false,
    sendFileComplete: (_fileId: string) => {},
    sendTransferCancel: (_fileId: string, _reason: 'timeout') => {},
  });

  // File transfer hook
  const fileTransfer = useFileTransfer(fileTransferCallbacksRef.current);

  // Message callbacks ref (will be populated later)
  const messageCallbacksRef = useRef({
    getPeerCode: () => peerCodeRef.current,
    decrypt: (peerId: string, ciphertext: string) => crypto.decrypt(peerId, ciphertext),
    encrypt: (peerId: string, plaintext: string) => crypto.encrypt(peerId, plaintext),
    sendMessage: (_encryptedData: string) => {},
    setError: (_error: string) => {},
  });

  // Messages hook
  const messagesHook = useMessages(messageCallbacksRef.current);

  // Signaling callbacks ref (forward declaration for handleDisconnect)
  const signalingRef = useRef<ReturnType<typeof useSignaling> | null>(null);

  // Disconnect handler
  const handleDisconnect = useCallback(() => {
    webrtc.close();
    const currentPeerCode = peerCodeRef.current;
    if (currentPeerCode) {
      crypto.clearSession(currentPeerCode);
    }
    setPeerCode('');
    setPeerFingerprint('');
    messagesHook.clearMessages();
    fileTransfer.clearTransfers();
    setShowSecurityReminder(false);
    setAppState('registered');
  }, [crypto, fileTransfer, messagesHook]);

  // WebRTC callbacks
  const webrtcCallbacks = useMemo(() => ({
    onStateChange: (rtcState: RTCPeerConnectionState) => {
      if (rtcState === 'connected') {
        setAppState('handshaking');
        webrtc.sendHandshake(crypto.getPublicKeyBase64());
      } else if (rtcState === 'disconnected' || rtcState === 'failed') {
        handleDisconnect();
      }
    },
    onHandshake: (receivedKey: string) => {
      const currentPeerCode = peerCodeRef.current;
      if (!currentPeerCode) {
        logger.error('App', 'Handshake verification failed: no peer code');
        signalingRef.current?.setError('Security error: Connection verification failed');
        handleDisconnect();
        return;
      }

      if (!crypto.verifyPeerKey(currentPeerCode, receivedKey)) {
        logger.error('App', 'Handshake verification failed: key mismatch - possible MITM attack!');
        signalingRef.current?.setError('Security error: Key verification failed. The connection may have been intercepted.');
        handleDisconnect();
        return;
      }

      setAppState('connected');
      setShowSecurityReminder(true);
    },
    onMessage: messagesHook.handleIncomingMessage,
    onFileStart: fileTransfer.handleFileStart,
    onFileChunk: fileTransfer.handleFileChunk,
    onFileComplete: fileTransfer.handleFileComplete,
    onFileError: fileTransfer.handleFileError,
  }), [crypto, fileTransfer, handleDisconnect, messagesHook]);

  // WebRTC hook
  const webrtc = useWebRTC(webrtcCallbacks);

  // Update callbacks with webrtc methods
  useEffect(() => {
    fileTransferCallbacksRef.current.sendFileError = webrtc.sendFileError;
    fileTransferCallbacksRef.current.sendFileStart = webrtc.sendFileStart;
    fileTransferCallbacksRef.current.sendFileChunk = webrtc.sendFileChunk;
    fileTransferCallbacksRef.current.sendFileComplete = webrtc.sendFileComplete;
    fileTransferCallbacksRef.current.sendTransferCancel = webrtc.sendTransferCancel;
    messageCallbacksRef.current.sendMessage = webrtc.sendMessage;
  }, [webrtc]);

  // Signaling callbacks
  const signalingCallbacks = useMemo(() => ({
    onPairMatched: async (matchedPeerCode: string, peerPublicKey: string, isInitiator: boolean) => {
      try {
        setPeerCode(matchedPeerCode);
        setAppState('webrtc_connecting');
        crypto.establishSession(matchedPeerCode, peerPublicKey);
        setPeerFingerprint(crypto.getPeerFingerprint(peerPublicKey));
        await webrtc.connect(matchedPeerCode, isInitiator);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to establish secure connection';
        signalingRef.current?.setError(message);
        signalingRef.current?.setState('registered');
        setPeerCode('');
      }
    },
    onOffer: async (_from: string, payload: RTCSessionDescriptionInit) => {
      await webrtc.handleOffer(payload);
    },
    onAnswer: async (_from: string, payload: RTCSessionDescriptionInit) => {
      await webrtc.handleAnswer(payload);
    },
    onIceCandidate: async (_from: string, payload: RTCIceCandidateInit) => {
      await webrtc.handleIceCandidate(payload);
    },
  }), [crypto, webrtc]);

  // Signaling hook
  const signaling = useSignaling(signalingCallbacks);

  // Store signaling ref and update message callbacks
  useEffect(() => {
    signalingRef.current = signaling;
    messageCallbacksRef.current.setError = signaling.setError;
  }, [signaling]);

  // Initialize WebRTC with signaling client
  useEffect(() => {
    if (signaling.signalingRef.current) {
      webrtc.initialize(signaling.signalingRef.current);
    }
  }, [signaling.signalingRef.current, webrtc]);

  // Connect to signaling when crypto is ready
  useEffect(() => {
    if (crypto.isInitialized && !crypto.initError) {
      signaling.connect(crypto.getPublicKeyBase64());
    }
  }, [crypto.isInitialized, crypto.initError, signaling, crypto]);

  // Sync signaling state with app state
  useEffect(() => {
    if (signaling.connectionState !== 'connected' && signaling.connectionState !== 'handshaking') {
      setAppState(signaling.connectionState);
    }
  }, [signaling.connectionState]);

  // Handlers
  const handleRequestPairing = useCallback((code: string) => {
    setPeerCode(code);
    signaling.requestPairing(code);
  }, [signaling]);

  const handleAcceptPairing = useCallback(() => {
    if (signaling.incomingRequest) {
      signaling.respondToPairing(signaling.incomingRequest.code, true);
    }
  }, [signaling]);

  const handleRejectPairing = useCallback(() => {
    if (signaling.incomingRequest) {
      signaling.respondToPairing(signaling.incomingRequest.code, false);
    }
  }, [signaling]);

  const handleCancelPairing = useCallback(() => {
    setAppState('registered');
    setPeerCode('');
  }, []);

  const handleSelectFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (files && files.length > 0) {
      fileTransfer.sendFile(files[0]);
    }
    input.value = ''; // Reset to allow re-selecting same file
  }, [fileTransfer]);

  const handleVerified = useCallback(() => {
    setShowSecurityReminder(false);
    setShowSecurityInfo(true);
  }, []);

  // Error handling
  const currentError = crypto.initError || signaling.error;

  // Render content based on state
  const renderContent = () => {
    if (appState === 'connected') {
      return (
        <>
          <ChatView
            peerCode={peerCode}
            messages={messagesHook.messages}
            onSendMessage={messagesHook.sendMessage}
            onDisconnect={handleDisconnect}
            onSelectFile={handleSelectFile}
            myFingerprint={crypto.myFingerprint}
            peerFingerprint={peerFingerprint}
          />
          {fileTransfer.transfers.size > 0 && (
            <FileTransferUI
              transfers={Array.from(fileTransfer.transfers.values())}
              onSendFile={fileTransfer.sendFile}
              onDismiss={fileTransfer.dismissTransfer}
            />
          )}
          <label htmlFor="hidden-file-input" class="sr-only">Select file to send</label>
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
        <MyCode code={signaling.myCode} />
        {appState === 'waiting_approval' ? (
          <PendingApproval peerCode={peerCode} onCancel={handleCancelPairing} />
        ) : (
          <EnterCode onSubmit={handleRequestPairing} disabled={appState !== 'registered'} />
        )}
        <StatusIndicator state={appState} />
      </>
    );
  };

  return (
    <div id="app">
      <a href="#main-content" class="skip-link sr-only-focusable">Skip to main content</a>

      <header class="header" role="banner">
        <h1>Zajel Web</h1>
        {appState === 'connected' && (
          <span class="status connected" role="status" aria-live="polite">Connected</span>
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

      {showSecurityInfo && (
        <SecurityInfoPanel
          myFingerprint={crypto.myFingerprint}
          peerFingerprint={peerFingerprint}
          peerCode={peerCode}
          isConnected={appState === 'connected'}
          onClose={() => setShowSecurityInfo(false)}
        />
      )}

      {showSecurityReminder && appState === 'connected' && peerFingerprint && (
        <SecurityReminder
          myFingerprint={crypto.myFingerprint}
          peerFingerprint={peerFingerprint}
          peerCode={peerCode}
          onDismiss={() => setShowSecurityReminder(false)}
          onVerified={handleVerified}
        />
      )}

      {currentError && (
        <ErrorBanner message={currentError} onDismiss={signaling.clearError} />
      )}

      <div id="main-content">{renderContent()}</div>

      {signaling.incomingRequest && (
        <ApprovalRequest
          peerCode={signaling.incomingRequest.code}
          onAccept={handleAcceptPairing}
          onReject={handleRejectPairing}
        />
      )}
    </div>
  );
}
