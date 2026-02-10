"""
E2E tests for file transfer between the Flutter app and headless client.

Tests sending files from headless Bob to Alice (Flutter app on emulator).
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

    def _pair_alice_with_headless_bob(self, alice, app_helper, headless_bob):
        """Helper: pair Alice (emulator) with Bob (headless) and open chat."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_connect()
        helper.get_pairing_code_from_connect_screen()
        helper.enter_peer_code(headless_bob.pairing_code)

        time.sleep(P2P_CONNECTION_TIMEOUT)

        helper.go_back_to_home()
        time.sleep(3)

        assert helper.is_peer_connected(), "Pairing must succeed"

        helper.open_chat_with_peer()
        time.sleep(2)

        return helper

    @pytest.mark.single_device
    def test_headless_sends_file_to_app(self, alice, app_helper, headless_bob):
        """Headless Bob sends a file → Alice sees file message in chat."""
        helper = self._pair_alice_with_headless_bob(alice, app_helper, headless_bob)

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
            try:
                helper._find("zajel_headless_", timeout=15)
                received = True
            except Exception:
                received = False
            assert received, "Alice should see the file message in chat"
        finally:
            os.unlink(test_path)
