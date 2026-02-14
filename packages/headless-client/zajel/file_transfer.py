"""Chunked file transfer over WebRTC data channels.

Supports:
- Sending files with configurable chunk size
- Receiving files with progress tracking
- Hash verification for integrity
"""

import asyncio
import base64
import hashlib
import logging
import math
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .crypto import CryptoService
from .protocol import (
    FILE_CHUNK_SIZE,
    CHUNK_SEND_DELAY_MS,
    FileStartMessage,
    FileChunkMessage,
    FileCompleteMessage,
)

logger = logging.getLogger("zajel.file_transfer")

MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
MAX_CHUNKS = 10000
MAX_CONCURRENT_TRANSFERS = 10
TRANSFER_TIMEOUT = 300  # 5 minutes


@dataclass
class FileTransferProgress:
    """Progress information for a file transfer."""

    file_id: str
    file_name: str
    total_size: int
    total_chunks: int
    received_chunks: int = 0
    bytes_received: int = 0
    completed: bool = False
    file_path: Optional[str] = None
    sha256: Optional[str] = None


@dataclass
class IncomingTransfer:
    """State for an incoming file transfer."""

    info: FileTransferProgress
    chunks: dict[int, bytes] = field(default_factory=dict)
    complete_event: asyncio.Event = field(default_factory=asyncio.Event)
    _started_at: float = field(default_factory=time.time)


class FileTransferService:
    """Manages file transfers over encrypted data channels."""

    def __init__(
        self,
        crypto: CryptoService,
        send_fn: Callable[[str], None],
        receive_dir: str = "./received_files",
    ):
        self._crypto = crypto
        self._send_fn = send_fn
        self._receive_dir = Path(receive_dir)
        self._receive_dir.mkdir(parents=True, exist_ok=True)
        self._incoming: dict[str, IncomingTransfer] = {}
        self._on_file_received: Optional[Callable] = None

    def _cleanup_stale_transfers(self) -> None:
        """Remove transfers that have been inactive too long."""
        now = time.time()
        stale = [
            fid for fid, t in self._incoming.items()
            if not t.info.completed and now - t._started_at > TRANSFER_TIMEOUT
        ]
        for fid in stale:
            logger.warning("Cleaning up stale transfer: %s", fid)
            del self._incoming[fid]

    @staticmethod
    def _sanitize_filename(name: str) -> str:
        """Strip directory components and reject path traversal."""
        # Use os.path.basename to strip all directory parts
        basename = os.path.basename(name)
        # Remove null bytes
        basename = basename.replace("\0", "")
        # Reject empty or dot-only names
        if not basename or basename in (".", ".."):
            basename = f"unnamed_{uuid.uuid4().hex[:8]}"
        return basename

    async def send_file(
        self,
        peer_id: str,
        file_path: str,
        chunk_size: int = FILE_CHUNK_SIZE,
    ) -> str:
        """Send a file to a peer.

        Args:
            peer_id: The peer to send to.
            file_path: Path to the file to send.
            chunk_size: Size of each chunk in bytes.

        Returns:
            The file ID.
        """
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        file_data = path.read_bytes()
        file_id = str(uuid.uuid4())
        total_chunks = math.ceil(len(file_data) / chunk_size)

        logger.info(
            "Sending file %s (%d bytes, %d chunks)",
            path.name, len(file_data), total_chunks,
        )

        # Send file_start
        start_msg = FileStartMessage(
            file_id=file_id,
            file_name=path.name,
            total_size=len(file_data),
            total_chunks=total_chunks,
        )
        encrypted = self._crypto.encrypt(peer_id, start_msg.to_json())
        self._send_fn(encrypted)

        # Send chunks
        for i in range(total_chunks):
            offset = i * chunk_size
            chunk = file_data[offset : offset + chunk_size]
            chunk_b64 = base64.b64encode(chunk).decode()

            chunk_msg = FileChunkMessage(
                file_id=file_id,
                chunk_index=i,
                data=chunk_b64,
            )
            encrypted = self._crypto.encrypt(peer_id, chunk_msg.to_json())
            self._send_fn(encrypted)

            # Delay between chunks to avoid overwhelming the channel
            await asyncio.sleep(CHUNK_SEND_DELAY_MS / 1000)

        # Send file_complete with hash
        file_hash = hashlib.sha256(file_data).hexdigest()
        complete_msg = FileCompleteMessage(file_id=file_id, sha256=file_hash)
        encrypted = self._crypto.encrypt(peer_id, complete_msg.to_json())
        self._send_fn(encrypted)

        logger.info("File sent: %s (%s)", path.name, file_id)
        return file_id

    def handle_file_message(self, peer_id: str, msg: dict) -> None:
        """Handle a decrypted file transfer message.

        Args:
            peer_id: The sender's peer ID.
            msg: The parsed JSON message.
        """
        msg_type = msg.get("type")

        if msg_type == "file_start":
            file_id = msg["fileId"]
            total_size = msg.get("totalSize", 0)
            total_chunks = msg.get("totalChunks", 0)

            # Validate file size
            if total_size <= 0 or total_size > MAX_FILE_SIZE:
                logger.warning(
                    "Rejected file transfer %s: size %d exceeds limit %d",
                    file_id, total_size, MAX_FILE_SIZE,
                )
                return

            # Validate chunk count
            if total_chunks <= 0 or total_chunks > MAX_CHUNKS:
                logger.warning(
                    "Rejected file transfer %s: %d chunks exceeds limit %d",
                    file_id, total_chunks, MAX_CHUNKS,
                )
                return

            # Validate consistency
            if total_size > total_chunks * FILE_CHUNK_SIZE:
                logger.warning(
                    "Rejected file transfer %s: size/chunks mismatch",
                    file_id,
                )
                return

            # Limit concurrent transfers
            self._cleanup_stale_transfers()
            active = sum(1 for t in self._incoming.values() if not t.info.completed)
            if active >= MAX_CONCURRENT_TRANSFERS:
                logger.warning("Rejected file transfer %s: too many concurrent transfers", file_id)
                return

            safe_name = self._sanitize_filename(msg["fileName"])
            info = FileTransferProgress(
                file_id=file_id,
                file_name=safe_name,
                total_size=total_size,
                total_chunks=total_chunks,
            )
            self._incoming[file_id] = IncomingTransfer(info=info)
            logger.info(
                "Receiving file: %s (%d bytes, %d chunks)",
                info.file_name, info.total_size, info.total_chunks,
            )

        elif msg_type == "file_chunk":
            file_id = msg["fileId"]
            transfer = self._incoming.get(file_id)
            if transfer is None:
                logger.warning("Chunk for unknown file: %s", file_id)
                return

            chunk_data = base64.b64decode(msg["data"])
            transfer.info.bytes_received += len(chunk_data)

            if transfer.info.bytes_received > transfer.info.total_size * 1.1:  # 10% tolerance
                logger.warning(
                    "File transfer %s: received bytes (%d) exceed declared size (%d)",
                    file_id, transfer.info.bytes_received, transfer.info.total_size,
                )
                del self._incoming[file_id]
                return

            transfer.chunks[msg["chunkIndex"]] = chunk_data
            transfer.info.received_chunks += 1

        elif msg_type == "file_complete":
            file_id = msg["fileId"]
            transfer = self._incoming.get(file_id)
            if transfer is None:
                logger.warning("Complete for unknown file: %s", file_id)
                return

            # Reassemble file
            file_data = b""
            for i in range(transfer.info.total_chunks):
                chunk = transfer.chunks.get(i)
                if chunk is None:
                    logger.error("Missing chunk %d for file %s", i, file_id)
                    return
                file_data += chunk

            # Compute hash and verify against sender's hash
            sha256 = hashlib.sha256(file_data).hexdigest()
            expected_sha256 = msg.get("sha256", "")
            if expected_sha256 and sha256 != expected_sha256:
                logger.error(
                    "File hash mismatch for %s: expected %s, got %s",
                    file_id, expected_sha256, sha256,
                )
                del self._incoming[file_id]
                return

            # Save to disk (with path traversal protection)
            save_path = (self._receive_dir / transfer.info.file_name).resolve()
            if not str(save_path).startswith(str(self._receive_dir.resolve())):
                logger.error(
                    "Path traversal detected in file name: %s",
                    transfer.info.file_name,
                )
                return
            save_path.write_bytes(file_data)

            transfer.info.completed = True
            transfer.info.file_path = str(save_path)
            transfer.info.sha256 = sha256
            transfer.complete_event.set()

            logger.info(
                "File received: %s (%d bytes, sha256=%s)",
                transfer.info.file_name, len(file_data), sha256[:16],
            )

            if self._on_file_received:
                self._on_file_received(peer_id, transfer.info)

    async def wait_for_file(self, timeout: float = 60) -> FileTransferProgress:
        """Wait for a file transfer to complete.

        Returns:
            The completed file transfer progress info.
        """
        # Wait for any incoming transfer to complete
        while True:
            for transfer in self._incoming.values():
                if not transfer.info.completed:
                    try:
                        await asyncio.wait_for(
                            transfer.complete_event.wait(), timeout=timeout
                        )
                        return transfer.info
                    except asyncio.TimeoutError:
                        raise TimeoutError("File transfer timed out")

            # No pending transfers, wait briefly
            await asyncio.sleep(0.1)

    def get_transfer(self, file_id: str) -> Optional[FileTransferProgress]:
        """Get the progress of a file transfer."""
        transfer = self._incoming.get(file_id)
        return transfer.info if transfer else None
