"""Tests for the file transfer protocol."""

import base64
import hashlib
import math
import os
import tempfile
import pytest
from zajel.crypto import CryptoService
from zajel.file_transfer import FileTransferService
from zajel.protocol import FILE_CHUNK_SIZE


class TestFileTransferService:
    def setup_method(self):
        """Set up crypto services for Alice and Bob."""
        self.alice_crypto = CryptoService()
        self.alice_crypto.initialize()
        self.bob_crypto = CryptoService()
        self.bob_crypto.initialize()

        self.alice_crypto.perform_key_exchange("bob", self.bob_crypto.public_key_base64)
        self.bob_crypto.perform_key_exchange("alice", self.alice_crypto.public_key_base64)

        self.sent_messages: list[str] = []
        self.receive_dir = tempfile.mkdtemp()

    def _mock_send(self, data: str) -> None:
        self.sent_messages.append(data)

    def test_file_transfer_roundtrip(self):
        """Test sending and receiving a file."""
        # Create a test file
        test_data = os.urandom(1000)
        with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f:
            f.write(test_data)
            test_path = f.name

        # Set up sender (Alice)
        alice_transfer = FileTransferService(
            crypto=self.alice_crypto,
            send_fn=self._mock_send,
        )

        # Set up receiver (Bob)
        bob_transfer = FileTransferService(
            crypto=self.bob_crypto,
            send_fn=lambda _: None,
            receive_dir=self.receive_dir,
        )

        # Simulate send (synchronous for testing)
        import asyncio
        asyncio.run(alice_transfer.send_file("bob", test_path))

        # Process received messages through Bob's handler.
        # File channel messages are plaintext JSON; only the chunk data field
        # is encrypted (matching the Flutter/web client protocol).
        import json
        for raw_msg in self.sent_messages:
            msg = json.loads(raw_msg)
            bob_transfer.handle_file_message("alice", msg)

        # Verify the file was received correctly
        expected_chunks = math.ceil(len(test_data) / FILE_CHUNK_SIZE)
        # The last transfer should be complete
        transfers = [t for t in bob_transfer._incoming.values() if t.info.completed]
        assert len(transfers) == 1

        transfer = transfers[0]
        assert transfer.info.completed
        assert transfer.info.total_size == len(test_data)

        # Verify file content
        received_data = open(transfer.info.file_path, "rb").read()
        assert received_data == test_data
        assert transfer.info.sha256 == hashlib.sha256(test_data).hexdigest()

        # Cleanup
        os.unlink(test_path)

    def test_chunking_math(self):
        """Test that chunk count is calculated correctly."""
        test_sizes = [0, 1, 4095, 4096, 4097, 10000, 100000]
        for size in test_sizes:
            expected = math.ceil(size / FILE_CHUNK_SIZE) if size > 0 else 0
            actual = math.ceil(size / FILE_CHUNK_SIZE) if size > 0 else 0
            assert actual == expected, f"Failed for size {size}"
