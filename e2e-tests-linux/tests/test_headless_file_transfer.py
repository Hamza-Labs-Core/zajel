"""
E2E tests for file transfer between the Flutter Linux app and headless client.

Tests sending files from headless Bob to Alice (Flutter Linux app).
The headless client programmatically sends files over the encrypted data
channel; Alice's app should display the received file in chat.
"""

import os
import tempfile
import time
import pytest

from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.headless
@pytest.mark.file_transfer
@pytest.mark.slow
class TestHeadlessFileTransfer:
    """File transfer tests using headless client as the peer."""

    def _pair_alice_with_headless_bob(self, alice, headless_bob):
        """Helper: pair Alice (Linux app) with Bob (headless) and open chat."""
        alice.navigate_to_connect()
        alice.get_pairing_code_from_connect_screen()
        alice.enter_peer_code(headless_bob.pairing_code)

        time.sleep(P2P_CONNECTION_TIMEOUT)

        alice.go_back_to_home()
        time.sleep(3)

        assert alice.is_peer_connected(), "Pairing must succeed"

        alice.open_chat_with_peer()
        time.sleep(2)

    @pytest.mark.single_device
    def test_headless_sends_file_to_app(self, alice, headless_bob):
        """Headless Bob sends a file → Alice sees file message in chat."""
        self._pair_alice_with_headless_bob(alice, headless_bob)

        # Create a test file
        test_data = b"Zajel E2E test file content from headless client"
        with tempfile.NamedTemporaryFile(
            suffix=".txt", prefix="zajel_headless_", delete=False
        ) as f:
            f.write(test_data)
            test_path = f.name

        try:
            peer_id = headless_bob.connected_peer.peer_id
            headless_bob.send_file(peer_id, test_path)

            # Wait for transfer to complete and render in Alice's chat
            time.sleep(15)

            # Alice should see a file message (filename visible in chat)
            file_name = os.path.basename(test_path)
            assert alice.has_message("zajel_headless_"), \
                "Alice should see the file message in chat"
        finally:
            os.unlink(test_path)
