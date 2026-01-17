/**
 * IncomingCallOverlay Component Tests
 *
 * Tests for the incoming call overlay component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/preact';
import { IncomingCallOverlay } from '../IncomingCallOverlay';

describe('IncomingCallOverlay', () => {
  const defaultProps = {
    callerName: 'PEER123',
    callId: 'call-123',
    withVideo: false,
    onAccept: vi.fn(),
    onReject: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('rendering', () => {
    it('should render caller name', () => {
      render(<IncomingCallOverlay {...defaultProps} />);

      expect(screen.getByText('PEER123')).toBeInTheDocument();
    });

    it('should render "Incoming call" for audio call', () => {
      render(<IncomingCallOverlay {...defaultProps} withVideo={false} />);

      expect(screen.getByText('Incoming call')).toBeInTheDocument();
    });

    it('should render "Incoming video call" for video call', () => {
      render(<IncomingCallOverlay {...defaultProps} withVideo={true} />);

      expect(screen.getByText('Incoming video call')).toBeInTheDocument();
    });

    it('should render accept and reject buttons', () => {
      render(<IncomingCallOverlay {...defaultProps} />);

      expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
    });

    it('should show accept with video button only for video calls', () => {
      const { rerender } = render(<IncomingCallOverlay {...defaultProps} withVideo={false} />);

      // Audio call - no video accept button
      expect(screen.queryByRole('button', { name: /accept video call/i })).not.toBeInTheDocument();

      // Video call - has video accept button
      rerender(<IncomingCallOverlay {...defaultProps} withVideo={true} />);
      expect(screen.getByRole('button', { name: /accept video call/i })).toBeInTheDocument();
    });

    it('should render with alertdialog role', () => {
      render(<IncomingCallOverlay {...defaultProps} />);

      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('should have modal aria attributes', () => {
      render(<IncomingCallOverlay {...defaultProps} />);

      const dialog = screen.getByRole('alertdialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'incoming-call-title');
      expect(dialog).toHaveAttribute('aria-describedby', 'incoming-call-desc');
    });
  });

  describe('interactions', () => {
    it('should call onAccept with false when accept audio button is clicked', () => {
      const onAccept = vi.fn();
      render(<IncomingCallOverlay {...defaultProps} onAccept={onAccept} />);

      const acceptButton = screen.getByRole('button', { name: /accept.*call from peer123/i });
      fireEvent.click(acceptButton);

      expect(onAccept).toHaveBeenCalledWith(false);
    });

    it('should call onAccept with true when accept video button is clicked', () => {
      const onAccept = vi.fn();
      render(<IncomingCallOverlay {...defaultProps} onAccept={onAccept} withVideo={true} />);

      const acceptVideoButton = screen.getByRole('button', { name: /accept video call/i });
      fireEvent.click(acceptVideoButton);

      expect(onAccept).toHaveBeenCalledWith(true);
    });

    it('should call onReject when reject button is clicked', () => {
      const onReject = vi.fn();
      render(<IncomingCallOverlay {...defaultProps} onReject={onReject} />);

      const rejectButton = screen.getByRole('button', { name: /reject/i });
      fireEvent.click(rejectButton);

      expect(onReject).toHaveBeenCalled();
    });

    it('should call onReject when Escape key is pressed', () => {
      const onReject = vi.fn();
      render(<IncomingCallOverlay {...defaultProps} onReject={onReject} />);

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onReject).toHaveBeenCalled();
    });
  });

  describe('focus management', () => {
    it('should focus accept button on mount', () => {
      render(<IncomingCallOverlay {...defaultProps} />);

      // The accept button should be focused
      const acceptButton = screen.getByRole('button', { name: /accept.*call/i });
      expect(document.activeElement).toBe(acceptButton);
    });
  });

  describe('accessibility', () => {
    it('should have accessible button labels', () => {
      render(<IncomingCallOverlay {...defaultProps} callerName="TEST456" />);

      expect(screen.getByRole('button', { name: /reject call from test456/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /accept.*from test456/i })).toBeInTheDocument();
    });

    it('should have screen reader instructions', () => {
      render(<IncomingCallOverlay {...defaultProps} />);

      expect(screen.getByText(/press escape to reject/i)).toBeInTheDocument();
    });
  });
});
