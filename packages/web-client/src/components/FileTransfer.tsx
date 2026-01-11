import { useRef, useState, useCallback } from 'preact/hooks';
import type { FileTransfer as FileTransferType } from '../lib/protocol';

interface FileTransferProps {
  transfers: FileTransferType[];
  onSendFile: (file: File) => void;
  onDismiss: (transferId: string) => void;
  onRetry?: (transferId: string) => void;
  onCancel?: (transferId: string) => void;
}

export function FileTransfer({ transfers, onSendFile, onDismiss, onRetry, onCancel }: FileTransferProps) {
  const [dragOver, setDragOver] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = 'file-transfer-input';

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (!dragOver) {
      setDragOver(true);
      setAnnouncement('File detected over drop zone. Release to upload.');
    }
  }, [dragOver]);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
    setAnnouncement('');
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        onSendFile(files[0]);
        setAnnouncement(`File ${files[0].name} selected for transfer.`);
      }
    },
    [onSendFile]
  );

  const handleFileSelect = useCallback(
    (e: Event) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        onSendFile(files[0]);
        setAnnouncement(`File ${files[0].name} selected for transfer.`);
      }
    },
    [onSendFile]
  );

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kilobytes`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} megabytes`;
  };

  const formatSizeShort = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatSpeed = (bytesPerSecond: number | undefined): string => {
    if (!bytesPerSecond || bytesPerSecond <= 0) return '';
    if (bytesPerSecond < 1024) return `${bytesPerSecond.toFixed(0)} B/s`;
    if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  };

  const formatTime = (seconds: number | undefined): string => {
    if (!seconds || seconds <= 0) return '';
    if (seconds < 60) return `${Math.ceil(seconds)}s remaining`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.ceil(seconds % 60);
    return `${mins}m ${secs}s remaining`;
  };

  const getTransferProgress = (transfer: FileTransferType): number => {
    // Use ackedChunks for sending (acknowledged by receiver) or receivedChunks for receiving
    const chunks = transfer.direction === 'sending' && transfer.ackedChunks !== undefined
      ? transfer.ackedChunks
      : transfer.receivedChunks;
    return Math.round((chunks / transfer.totalChunks) * 100);
  };

  const getTransferStatusText = (transfer: FileTransferType): string => {
    if (transfer.status === 'complete') return 'Complete';
    if (transfer.status === 'failed') return transfer.error || 'Transfer failed';

    // Show enhanced status for reliable transfers
    const state = transfer.state;
    if (state === 'awaiting_start_ack') return 'Waiting for receiver...';
    if (state === 'awaiting_complete_ack') return 'Verifying transfer...';
    if (state === 'cancelled') return 'Cancelled';

    // Show retry info if there are retries
    const retryInfo = transfer.retryCount && transfer.retryCount > 0
      ? ` (${transfer.retryCount} retries)`
      : '';

    // Show failed chunks count
    const failedInfo = transfer.failedChunks && transfer.failedChunks.length > 0
      ? ` - ${transfer.failedChunks.length} chunks pending retry`
      : '';

    if (transfer.status === 'sending' || transfer.direction === 'sending') {
      const acked = transfer.ackedChunks !== undefined ? transfer.ackedChunks : transfer.receivedChunks;
      return `Sending: ${acked} of ${transfer.totalChunks} chunks${retryInfo}${failedInfo}`;
    }
    return `Receiving: ${transfer.receivedChunks} of ${transfer.totalChunks} chunks${retryInfo}`;
  };

  // Check if transfer can be retried (only failed receiving transfers)
  const canRetry = (transfer: FileTransferType): boolean => {
    return transfer.status === 'failed' &&
      transfer.direction === 'receiving' &&
      onRetry !== undefined;
  };

  // Check if transfer can be cancelled
  const canCancel = (transfer: FileTransferType): boolean => {
    return transfer.status !== 'complete' &&
      transfer.status !== 'failed' &&
      onCancel !== undefined;
  };

  return (
    <section
      class="card"
      role="region"
      aria-labelledby="file-transfer-heading"
    >
      <h2 id="file-transfer-heading">File Transfer</h2>

      {/* Accessible file drop zone */}
      <div
        class={`file-zone ${dragOver ? 'dragover' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-label="File upload area. Click, press Enter, or drag and drop a file here to send"
        aria-describedby="drop-instructions"
      >
        <label htmlFor={inputId} class="sr-only">
          Select file to send
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
          aria-describedby="drop-instructions"
        />
        <p id="drop-instructions">
          Drop a file here or click to select
        </p>
        <span class="sr-only">
          You can also press Enter or Space to open the file selector.
        </span>
      </div>

      {/* Announce drag state and file selection */}
      <div aria-live="polite" aria-atomic="true" class="sr-only">
        {announcement}
      </div>

      {/* Transfer list */}
      {transfers.length > 0 && (
        <ul
          role="list"
          aria-label="File transfers"
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
        >
          {transfers.map((transfer) => {
            const progress = getTransferProgress(transfer);
            const statusText = getTransferStatusText(transfer);
            const speed = formatSpeed(transfer.transferSpeed);
            const timeRemaining = formatTime(transfer.estimatedTimeRemaining);

            return (
              <li
                key={transfer.id}
                class="file-progress"
                style={transfer.status === 'failed' ? { borderColor: 'var(--error, #ef4444)' } : undefined}
                aria-label={`${transfer.fileName}, ${formatSize(transfer.totalSize)}, ${
                  transfer.status === 'complete'
                    ? 'completed'
                    : transfer.status === 'failed'
                      ? 'failed'
                      : `${progress}% complete`
                }`}
              >
                <div
                  class="name"
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}
                >
                  <span>
                    {transfer.fileName} ({formatSizeShort(transfer.totalSize)})
                    {transfer.direction && (
                      <span style={{ fontSize: '11px', opacity: 0.7, marginLeft: '8px' }}>
                        {transfer.direction === 'sending' ? '[Sending]' : '[Receiving]'}
                      </span>
                    )}
                  </span>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {canCancel(transfer) && (
                      <button
                        class="btn btn-sm"
                        style={{
                          background: 'var(--warning, #f59e0b)',
                          padding: '2px 8px',
                          fontSize: '11px',
                        }}
                        onClick={() => onCancel?.(transfer.id)}
                        aria-label={`Cancel transfer of ${transfer.fileName}`}
                      >
                        Cancel
                      </button>
                    )}
                    {canRetry(transfer) && (
                      <button
                        class="btn btn-sm"
                        style={{
                          background: 'var(--primary, #3b82f6)',
                          padding: '2px 8px',
                          fontSize: '11px',
                        }}
                        onClick={() => onRetry?.(transfer.id)}
                        aria-label={`Retry transfer of ${transfer.fileName}`}
                      >
                        Retry
                      </button>
                    )}
                    {(transfer.status === 'failed' || transfer.status === 'complete') && (
                      <button
                        class="btn btn-sm"
                        style={{
                          background: transfer.status === 'failed' ? 'var(--error, #ef4444)' : 'rgba(0,0,0,0.2)',
                          padding: '2px 8px',
                          fontSize: '11px',
                        }}
                        onClick={() => onDismiss(transfer.id)}
                        aria-label={`Dismiss ${transfer.status} transfer of ${transfer.fileName}`}
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>

                {/* Accessible progress bar */}
                <div
                  class="bar"
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${transfer.fileName} transfer progress: ${progress}%`}
                >
                  <div
                    class="fill"
                    style={{
                      width: `${progress}%`,
                      background: transfer.status === 'failed' ? 'var(--error, #ef4444)' : undefined,
                    }}
                  />
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '12px',
                    color: transfer.status === 'failed' ? 'var(--error, #ef4444)' : 'var(--text-muted)',
                    marginTop: '4px',
                  }}
                  aria-live={transfer.status === 'failed' ? 'assertive' : undefined}
                  role={transfer.status === 'failed' ? 'alert' : undefined}
                >
                  <span>{statusText}</span>
                  {speed && timeRemaining && transfer.status !== 'complete' && transfer.status !== 'failed' && (
                    <span style={{ opacity: 0.8 }}>
                      {speed} - {timeRemaining}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Screen reader summary of active transfers */}
      {transfers.length > 0 && (
        <div aria-live="polite" class="sr-only">
          {transfers.filter(t => t.status !== 'complete' && t.status !== 'failed').length} active transfers.
          {transfers.filter(t => t.status === 'complete').length} completed.
          {transfers.filter(t => t.status === 'failed').length} failed.
        </div>
      )}
    </section>
  );
}
