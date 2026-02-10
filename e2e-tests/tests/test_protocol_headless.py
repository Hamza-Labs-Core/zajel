"""
Headless-to-headless protocol tests.

These tests run two headless clients against the signaling server — no
emulator, no Appium, no Flutter app. They validate the protocol layer:
signaling, pairing, key exchange, encryption, message delivery, and
file transfer integrity.

These are the fastest E2E tests since they skip all UI interaction.
"""

import asyncio
import hashlib
import os
import tempfile
import pytest

from config import SIGNALING_URL

from zajel.client import ZajelHeadlessClient


@pytest.fixture
def event_loop():
    """Create a new event loop for each test."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def run(event_loop):
    """Helper to run async code in the test's event loop."""
    return lambda coro: event_loop.run_until_complete(coro)


@pytest.mark.headless
@pytest.mark.protocol
class TestProtocolHeadless:
    """Protocol-level tests using two headless clients."""

    def _skip_if_no_signaling(self):
        if not SIGNALING_URL:
            pytest.skip("SIGNALING_URL not set")

    def test_pairing_handshake(self, run):
        """Two headless clients can pair via signaling server."""
        self._skip_if_no_signaling()

        async def _test():
            async with ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Alice", auto_accept_pairs=True
            ) as alice, ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Bob"
            ) as bob:
                alice_code = await alice.connect()
                await bob.connect()

                assert len(alice_code) == 6

                # Bob pairs with Alice (Alice auto-accepts)
                peer = await bob.pair_with(alice_code)

                assert peer is not None
                assert peer.peer_id == alice_code

        run(_test())

    def test_encrypted_message_exchange(self, run):
        """Two headless clients exchange encrypted messages."""
        self._skip_if_no_signaling()

        async def _test():
            async with ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Alice", auto_accept_pairs=True
            ) as alice, ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Bob"
            ) as bob:
                alice_code = await alice.connect()
                await bob.connect()

                peer = await bob.pair_with(alice_code)

                # Wait for Alice's key exchange to complete
                await asyncio.sleep(2)

                # Bob sends a message
                await bob.send_text(peer.peer_id, "Hello from Bob!")

                # Alice receives it
                msg = await alice.receive_message(timeout=10)
                assert msg.content == "Hello from Bob!"
                assert msg.peer_id is not None

        run(_test())

    def test_bidirectional_messages(self, run):
        """Both clients send and receive messages."""
        self._skip_if_no_signaling()

        async def _test():
            async with ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Alice", auto_accept_pairs=True
            ) as alice, ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Bob"
            ) as bob:
                alice_code = await alice.connect()
                await bob.connect()

                peer = await bob.pair_with(alice_code)
                await asyncio.sleep(2)

                # Bob → Alice
                await bob.send_text(peer.peer_id, "Ping")
                msg1 = await alice.receive_message(timeout=10)
                assert msg1.content == "Ping"

                # Alice → Bob
                await alice.send_text(msg1.peer_id, "Pong")
                msg2 = await bob.receive_message(timeout=10)
                assert msg2.content == "Pong"

        run(_test())

    def test_multiple_messages(self, run):
        """Send many messages and verify order and content."""
        self._skip_if_no_signaling()

        async def _test():
            async with ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Alice", auto_accept_pairs=True
            ) as alice, ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Bob"
            ) as bob:
                alice_code = await alice.connect()
                await bob.connect()

                peer = await bob.pair_with(alice_code)
                await asyncio.sleep(2)

                # Send 10 messages
                for i in range(10):
                    await bob.send_text(peer.peer_id, f"Message {i}")

                # Receive all 10
                received = []
                for _ in range(10):
                    msg = await alice.receive_message(timeout=15)
                    received.append(msg.content)

                for i in range(10):
                    assert received[i] == f"Message {i}"

        run(_test())

    def test_unicode_messages(self, run):
        """Unicode and emoji content survives encryption roundtrip."""
        self._skip_if_no_signaling()

        async def _test():
            async with ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Alice", auto_accept_pairs=True
            ) as alice, ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Bob"
            ) as bob:
                alice_code = await alice.connect()
                await bob.connect()

                peer = await bob.pair_with(alice_code)
                await asyncio.sleep(2)

                test_strings = [
                    "Hello, World!",
                    "مرحبا بالعالم",
                    "こんにちは世界",
                    "🎉🔥💬",
                    "Mixed: Hello مرحبا 🌍",
                ]

                for text in test_strings:
                    await bob.send_text(peer.peer_id, text)
                    msg = await alice.receive_message(timeout=10)
                    assert msg.content == text, f"Failed for: {text}"

        run(_test())

    def test_file_transfer_integrity(self, run):
        """Transfer a file and verify SHA-256 hash matches."""
        self._skip_if_no_signaling()

        async def _test():
            async with ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Alice", auto_accept_pairs=True,
                receive_dir=tempfile.mkdtemp(),
            ) as alice, ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Bob"
            ) as bob:
                alice_code = await alice.connect()
                await bob.connect()

                peer = await bob.pair_with(alice_code)
                await asyncio.sleep(2)

                # Create a test file with random data
                test_data = os.urandom(10_000)
                original_hash = hashlib.sha256(test_data).hexdigest()

                with tempfile.NamedTemporaryFile(
                    suffix=".bin", delete=False
                ) as f:
                    f.write(test_data)
                    test_path = f.name

                try:
                    await bob.send_file(peer.peer_id, test_path)
                    result = await alice.receive_file(timeout=30)

                    assert result is not None
                    assert result.info.sha256 == original_hash
                    assert result.info.total_size == len(test_data)
                finally:
                    os.unlink(test_path)

        run(_test())

    def test_empty_message(self, run):
        """Empty string survives encryption roundtrip."""
        self._skip_if_no_signaling()

        async def _test():
            async with ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Alice", auto_accept_pairs=True
            ) as alice, ZajelHeadlessClient(
                signaling_url=SIGNALING_URL, name="Bob"
            ) as bob:
                alice_code = await alice.connect()
                await bob.connect()

                peer = await bob.pair_with(alice_code)
                await asyncio.sleep(2)

                await bob.send_text(peer.peer_id, "")
                msg = await alice.receive_message(timeout=10)
                assert msg.content == ""

        run(_test())
