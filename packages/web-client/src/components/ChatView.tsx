import { useState, useRef, useEffect } from 'preact/hooks';
import type { ChatMessage } from '../lib/protocol';

interface ChatViewProps {
  peerCode: string;
  messages: ChatMessage[];
  onSendMessage: (content: string) => void;
  onDisconnect: () => void;
  onSelectFile: () => void;
}

export function ChatView({
  peerCode,
  messages,
  onSendMessage,
  onDisconnect,
  onSelectFile,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
    }
  };

  return (
    <div class="chat-container">
      <div class="chat-header">
        <h2>{peerCode}</h2>
        <button class="btn btn-danger btn-sm" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>

      <div class="messages">
        {messages.map((msg) => (
          <div key={msg.id} class={`message ${msg.sender === 'me' ? 'sent' : 'received'}`}>
            {msg.content}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form class="chat-input" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Type a message..."
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
        />
        <button type="button" class="btn btn-secondary" onClick={onSelectFile} title="Send file">
          +
        </button>
        <button type="submit">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </form>
    </div>
  );
}
