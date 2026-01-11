import { useState, useRef, useEffect } from 'preact/hooks';
import type { ChatMessage } from '../lib/protocol';
import { FingerprintDisplay } from './FingerprintDisplay';

interface ChatViewProps {
  peerCode: string;
  messages: ChatMessage[];
  onSendMessage: (content: string) => void;
  onDisconnect: () => void;
  onSelectFile: () => void;
  myFingerprint?: string;
  peerFingerprint?: string;
}

export function ChatView({
  peerCode,
  messages,
  onSendMessage,
  onDisconnect,
  onSelectFile,
  myFingerprint,
  peerFingerprint,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const [showFingerprint, setShowFingerprint] = useState(false);
  const [lastAnnouncedMessageId, setLastAnnouncedMessageId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = 'chat-message-input';

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Track new messages for screen reader announcement
  useEffect(() => {
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.id !== lastAnnouncedMessageId && lastMessage.sender === 'peer') {
        setLastAnnouncedMessageId(lastMessage.id);
      }
    }
  }, [messages, lastAnnouncedMessageId]);

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const content = input.trim();
    if (content) {
      onSendMessage(content);
      setInput('');
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    } else if (e.key === 'Escape') {
      // Return focus to input when Escape is pressed
      inputRef.current?.focus();
    }
  };

  // Get the last message from peer for screen reader announcement
  const lastPeerMessage = messages
    .filter(m => m.sender === 'peer')
    .slice(-1)[0];

  return (
    <main class="chat-container" aria-label={`Chat with ${peerCode}`}>
      <header class="chat-header">
        <h2 id="chat-peer">{peerCode}</h2>
        {myFingerprint && peerFingerprint && (
          <button
            class="btn btn-sm"
            style={{ background: 'var(--success)', color: '#000', marginRight: '8px' }}
            onClick={() => setShowFingerprint(!showFingerprint)}
            aria-label="Verify connection security"
            aria-expanded={showFingerprint}
            title="Verify fingerprints"
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
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span class="sr-only">Verify connection security</span>
          </button>
        )}
        <button
          class="btn btn-danger btn-sm"
          onClick={onDisconnect}
          aria-label={`Disconnect from ${peerCode}`}
        >
          Disconnect
        </button>
      </header>

      {showFingerprint && myFingerprint && peerFingerprint && (
        <FingerprintDisplay
          myFingerprint={myFingerprint}
          peerFingerprint={peerFingerprint}
          peerCode={peerCode}
          onClose={() => setShowFingerprint(false)}
        />
      )}

      {/* Messages container with log role for screen readers */}
      <div
        class="messages"
        role="log"
        aria-label="Message history"
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
      >
        {messages.length === 0 ? (
          <p class="sr-only">No messages yet. Type a message below to start chatting.</p>
        ) : (
          <ul role="list" aria-label="Chat messages" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {messages.map((msg) => (
              <li
                key={msg.id}
                class={`message ${msg.sender === 'me' ? 'sent' : 'received'}`}
                role="listitem"
                tabIndex={0}
              >
                <span class="sr-only">
                  {msg.sender === 'me' ? 'You said' : `${peerCode} said`}:
                </span>
                {msg.content}
              </li>
            ))}
          </ul>
        )}
        <div ref={messagesEndRef} aria-hidden="true" />
      </div>

      {/* Screen reader announcement for new messages */}
      <div
        aria-live="polite"
        aria-atomic="true"
        class="sr-only"
        role="status"
      >
        {lastPeerMessage && lastPeerMessage.id === lastAnnouncedMessageId && (
          <>New message from {peerCode}: {lastPeerMessage.content}</>
        )}
      </div>

      <form
        class="chat-input"
        onSubmit={handleSubmit}
        aria-label="Send a message"
      >
        <label htmlFor={inputId} class="sr-only">
          Type a message to {peerCode}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          placeholder="Type a message..."
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
          aria-label="Message input"
          autoComplete="off"
        />
        <button
          type="button"
          class="btn btn-secondary"
          onClick={onSelectFile}
          aria-label="Attach and send a file"
          title="Send file"
        >
          <span aria-hidden="true">+</span>
          <span class="sr-only">Attach file</span>
        </button>
        <button
          type="submit"
          aria-label="Send message"
          disabled={!input.trim()}
          aria-disabled={!input.trim()}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
          <span class="sr-only">Send</span>
        </button>
      </form>

      {/* Keyboard shortcuts hint */}
      <div class="sr-only" role="note">
        Press Enter to send a message. Press Escape to focus the message input.
      </div>
    </main>
  );
}
