import { useRef, useState, useCallback } from 'preact/hooks';
import type { FileTransfer as FileTransferType } from '../lib/protocol';

interface FileTransferProps {
  transfers: FileTransferType[];
  onSendFile: (file: File) => void;
}

export function FileTransfer({ transfers, onSendFile }: FileTransferProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);

      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        onSendFile(files[0]);
      }
    },
    [onSendFile]
  );

  const handleFileSelect = useCallback(
    (e: Event) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        onSendFile(files[0]);
      }
    },
    [onSendFile]
  );

  const handleClick = () => {
    inputRef.current?.click();
  };

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div class="card">
      <h2>File Transfer</h2>

      <div
        class={`file-zone ${dragOver ? 'dragover' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
      >
        <input
          ref={inputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <p>Drop a file here or click to select</p>
      </div>

      {transfers.map((transfer) => (
        <div key={transfer.id} class="file-progress">
          <div class="name">
            {transfer.fileName} ({formatSize(transfer.totalSize)})
          </div>
          <div class="bar">
            <div
              class="fill"
              style={{
                width: `${(transfer.receivedChunks / transfer.totalChunks) * 100}%`,
              }}
            />
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {transfer.status === 'complete'
              ? 'Complete'
              : `${transfer.receivedChunks}/${transfer.totalChunks} chunks`}
          </div>
        </div>
      ))}
    </div>
  );
}
