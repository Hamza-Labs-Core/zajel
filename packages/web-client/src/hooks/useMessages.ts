import { useState, useCallback } from 'preact/hooks';
import type { ChatMessage } from '../lib/protocol';
import { MESSAGE_LIMITS } from '../lib/constants';
import { sanitizeMessage } from '../lib/validation';
import { handleError, isCryptoError, ErrorCodes } from '../lib/errors';

export interface UseMessagesCallbacks {
  /** Get current peer code */
  getPeerCode: () => string;
  /** Decrypt data from peer */
  decrypt: (peerId: string, ciphertext: string) => string;
  /** Encrypt data for peer */
  encrypt: (peerId: string, plaintext: string) => string;
  /** Send encrypted message via WebRTC */
  sendMessage: (encryptedData: string) => void;
  /** Set error message */
  setError: (error: string) => void;
}

export interface UseMessagesReturn {
  /** Current messages */
  messages: ChatMessage[];
  /** Handle incoming encrypted message */
  handleIncomingMessage: (encryptedData: string) => void;
  /** Send a message */
  sendMessage: (content: string) => void;
  /** Clear all messages */
  clearMessages: () => void;
}

/**
 * Hook for managing chat messages.
 *
 * Handles:
 * - Message encryption/decryption
 * - Message history with limits
 * - Error handling for decryption failures
 */
export function useMessages(callbacks: UseMessagesCallbacks): UseMessagesReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => {
      const updated = [...prev, msg];
      if (updated.length > MESSAGE_LIMITS.MAX_MESSAGES) {
        return updated.slice(updated.length - MESSAGE_LIMITS.MAX_MESSAGES);
      }
      return updated;
    });
  }, []);

  const handleIncomingMessage = useCallback((encryptedData: string) => {
    try {
      const peerCode = callbacks.getPeerCode();
      if (!peerCode) return;

      const decryptedContent = callbacks.decrypt(peerCode, encryptedData);
      const content = sanitizeMessage(decryptedContent);

      addMessage({
        id: globalThis.crypto.randomUUID(),
        content,
        sender: 'peer',
        timestamp: new Date(),
      });
    } catch (e) {
      const err = handleError(e, 'message.decrypt', ErrorCodes.CRYPTO_DECRYPTION_FAILED);
      if (isCryptoError(e)) {
        callbacks.setError(err.userMessage);
      } else {
        addMessage({
          id: globalThis.crypto.randomUUID(),
          content: '[Message could not be decrypted]',
          sender: 'peer',
          timestamp: new Date(),
        });
      }
    }
  }, [callbacks, addMessage]);

  const sendMessage = useCallback((content: string) => {
    const peerCode = callbacks.getPeerCode();
    if (!peerCode) return;

    const encrypted = callbacks.encrypt(peerCode, content);
    callbacks.sendMessage(encrypted);

    addMessage({
      id: globalThis.crypto.randomUUID(),
      content,
      sender: 'me',
      timestamp: new Date(),
    });
  }, [callbacks, addMessage]);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    handleIncomingMessage,
    sendMessage,
    clearMessages,
  };
}
