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

        # Send file_complete
        complete_msg = FileCompleteMessage(file_id=file_id)
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
            safe_name = self._sanitize_filename(msg["fileName"])
            info = FileTransferProgress(
                file_id=file_id,
                file_name=safe_name,
                total_size=msg["totalSize"],
                total_chunks=msg["totalChunks"],
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
            transfer.chunks[msg["chunkIndex"]] = chunk_data
            transfer.info.received_chunks += 1
            transfer.info.bytes_received += len(chunk_data)

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

            # Save to disk (with path traversal protection)
            save_path = (self._receive_dir / transfer.info.file_name).resolve()
            if not str(save_path).startswith(str(self._receive_dir.resolve())):
                logger.error(
                    "Path traversal detected in file name: %s",
                    transfer.info.file_name,
                )
                return
            save_path.write_bytes(file_data)

            # Compute hash
            sha256 = hashlib.sha256(file_data).hexdigest()

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
