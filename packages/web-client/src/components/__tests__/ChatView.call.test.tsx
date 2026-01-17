/**
 * ChatView Call Integration Tests
 *
 * Tests for call button functionality in ChatView component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { ChatView } from '../ChatView';
import type { ChatMessage } from '../../lib/protocol';

describe('ChatView Call Integration', () => {
  const defaultProps = {
    peerCode: 'PEER123',
    messages: [] as ChatMessage[],
    onSendMessage: vi.fn(),
    onDisconnect: vi.fn(),
    onSelectFile: vi.fn(),
    myFingerprint: 'abc123',
    peerFingerprint: 'def456',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('call buttons visibility', () => {
    it('should show call buttons when callsEnabled and onStartCall are provided', () => {
      const onStartCall = vi.fn();
      render(
        <ChatView
          {...defaultProps}
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      expect(screen.getByRole('button', { name: /voice call/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /video call/i })).toBeInTheDocument();
    });

    it('should hide call buttons when callsEnabled is false', () => {
      const onStartCall = vi.fn();
      render(
        <ChatView
          {...defaultProps}
          onStartCall={onStartCall}
          callsEnabled={false}
        />
      );

      expect(screen.queryByRole('button', { name: /voice call/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /video call/i })).not.toBeInTheDocument();
    });

    it('should hide call buttons when onStartCall is not provided', () => {
      render(
        <ChatView
          {...defaultProps}
          callsEnabled={true}
        />
      );

      expect(screen.queryByRole('button', { name: /voice call/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /video call/i })).not.toBeInTheDocument();
    });

    it('should show call buttons by default when onStartCall is provided', () => {
      const onStartCall = vi.fn();
      render(
        <ChatView
          {...defaultProps}
          onStartCall={onStartCall}
        />
      );

      expect(screen.getByRole('button', { name: /voice call/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /video call/i })).toBeInTheDocument();
    });
  });

  describe('call button interactions', () => {
    it('should call onStartCall with false when voice call button is clicked', () => {
      const onStartCall = vi.fn();
      render(
        <ChatView
          {...defaultProps}
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      const voiceCallButton = screen.getByRole('button', { name: /voice call/i });
      fireEvent.click(voiceCallButton);

      expect(onStartCall).toHaveBeenCalledWith(false);
    });

    it('should call onStartCall with true when video call button is clicked', () => {
      const onStartCall = vi.fn();
      render(
        <ChatView
          {...defaultProps}
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      const videoCallButton = screen.getByRole('button', { name: /video call/i });
      fireEvent.click(videoCallButton);

      expect(onStartCall).toHaveBeenCalledWith(true);
    });
  });

  describe('call buttons accessibility', () => {
    it('should have accessible labels with peer code', () => {
      const onStartCall = vi.fn();
      render(
        <ChatView
          {...defaultProps}
          peerCode="TEST456"
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      expect(screen.getByRole('button', { name: /start voice call with test456/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /start video call with test456/i })).toBeInTheDocument();
    });

    it('should have call buttons in a group with label', () => {
      const onStartCall = vi.fn();
      render(
        <ChatView
          {...defaultProps}
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      expect(screen.getByRole('group', { name: /call options/i })).toBeInTheDocument();
    });

    it('should have title attributes for tooltips', () => {
      const onStartCall = vi.fn();
      render(
        <ChatView
          {...defaultProps}
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      const voiceCallButton = screen.getByRole('button', { name: /voice call/i });
      const videoCallButton = screen.getByRole('button', { name: /video call/i });

      expect(voiceCallButton).toHaveAttribute('title', 'Voice call');
      expect(videoCallButton).toHaveAttribute('title', 'Video call');
    });
  });

  describe('call buttons layout', () => {
    it('should render call buttons in the header', () => {
      const onStartCall = vi.fn();
      render(
        <ChatView
          {...defaultProps}
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      const header = document.querySelector('.chat-header');
      const callButtons = screen.getByRole('group', { name: /call options/i });

      expect(header).toContainElement(callButtons);
    });
  });

  describe('integration with existing ChatView functionality', () => {
    it('should not interfere with message sending', () => {
      const onSendMessage = vi.fn();
      const onStartCall = vi.fn();

      render(
        <ChatView
          {...defaultProps}
          onSendMessage={onSendMessage}
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      const input = screen.getByRole('textbox');
      const sendButton = screen.getByRole('button', { name: /send message/i });

      fireEvent.input(input, { target: { value: 'Hello' } });
      fireEvent.click(sendButton);

      expect(onSendMessage).toHaveBeenCalledWith('Hello');
      expect(onStartCall).not.toHaveBeenCalled();
    });

    it('should not interfere with disconnect button', () => {
      const onDisconnect = vi.fn();
      const onStartCall = vi.fn();

      render(
        <ChatView
          {...defaultProps}
          onDisconnect={onDisconnect}
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      const disconnectButton = screen.getByRole('button', { name: /disconnect/i });
      fireEvent.click(disconnectButton);

      expect(onDisconnect).toHaveBeenCalled();
      expect(onStartCall).not.toHaveBeenCalled();
    });

    it('should not interfere with file attachment', () => {
      const onSelectFile = vi.fn();
      const onStartCall = vi.fn();

      render(
        <ChatView
          {...defaultProps}
          onSelectFile={onSelectFile}
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      const attachButton = screen.getByRole('button', { name: /attach/i });
      fireEvent.click(attachButton);

      expect(onSelectFile).toHaveBeenCalled();
      expect(onStartCall).not.toHaveBeenCalled();
    });

    it('should not interfere with fingerprint display toggle', () => {
      const onStartCall = vi.fn();

      render(
        <ChatView
          {...defaultProps}
          myFingerprint="abc123"
          peerFingerprint="def456"
          onStartCall={onStartCall}
          callsEnabled={true}
        />
      );

      const securityButton = screen.getByRole('button', { name: /verify connection security/i });
      fireEvent.click(securityButton);

      // Fingerprint display should appear (heading inside the panel)
      expect(screen.getByRole('heading', { name: /verify connection security/i })).toBeInTheDocument();
      expect(onStartCall).not.toHaveBeenCalled();
    });
  });
});
