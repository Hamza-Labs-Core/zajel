"""
E2E tests for file transfer functionality.

Tests sending and receiving files between paired devices.

The test stages a file via adb push + media scanner, then interacts
with the Android Documents UI file picker to select it.
"""

import time
import subprocess
import pytest

from config import P2P_CONNECTION_TIMEOUT, ADB_PATH


@pytest.mark.file_transfer
@pytest.mark.slow
class TestFileTransfer:
    """Test suite for file sharing between paired devices."""

    @staticmethod
    def _stage_test_file(emulator_port: int):
        """Push a test file to the emulator's Downloads folder via adb.

        Creates a small text file, pushes it, and triggers the media scanner
        so the Documents UI file picker can find it.
        """
        import tempfile
        import os

        test_content = "Zajel E2E test file content"
        tmp_path = os.path.join(tempfile.gettempdir(), "zajel_test.txt")
        with open(tmp_path, 'w') as f:
            f.write(test_content)

        udid = f"emulator-{emulator_port}"
        try:
            subprocess.run(
                [ADB_PATH, "-s", udid, "push", tmp_path,
                 "/sdcard/Download/zajel_test.txt"],
                check=True, capture_output=True, timeout=30
            )
            # Trigger the media scanner so the file appears in the picker
            subprocess.run(
                [ADB_PATH, "-s", udid, "shell",
                 "am", "broadcast",
                 "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
                 "-d", "file:///sdcard/Download/zajel_test.txt"],
                capture_output=True, timeout=10
            )
            # Also use content provider to ensure indexing
            subprocess.run(
                [ADB_PATH, "-s", udid, "shell",
                 "content", "call", "--method", "scan_volume",
                 "--uri", "content://media",
                 "--arg", "external_primary"],
                capture_output=True, timeout=15
            )
            time.sleep(2)  # Give media scanner time to index
            return True
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            return False

    def _pair_and_open_chat(self, alice_driver, bob_driver, app_helper):
        """Pair devices and open chat on both sides."""
        alice = app_helper(alice_driver)
        bob = app_helper(bob_driver)

        alice.wait_for_app_ready()
        bob.wait_for_app_ready()

        alice.navigate_to_connect()
        alice_code = alice.get_pairing_code_from_connect_screen()

        bob.navigate_to_connect()
        bob.enter_peer_code(alice_code)

        connected = False
        for _ in range(6):
            time.sleep(P2P_CONNECTION_TIMEOUT)
            alice.go_back_to_home()
            bob.go_back_to_home()
            time.sleep(3)
            if alice.is_peer_connected() or bob.is_peer_connected():
                connected = True
                break

        assert connected, "Devices must be paired for file transfer tests"

        alice.open_chat_with_peer()
        time.sleep(2)
        bob.open_chat_with_peer()
        time.sleep(2)

        return alice, bob

    def _send_file(self, alice):
        """Have Alice select and send a file. Returns True if successful."""
        alice.tap_attach_file()
        time.sleep(3)

        if not alice.select_file_in_picker("zajel_test"):
            pytest.skip("Could not select file in picker on this emulator")

        # Wait for the app to process the file and show it in chat
        time.sleep(5)

    def test_send_file(self, device_pair, app_helper):
        """Attach file -> file message appears in sender's chat."""
        if not self._stage_test_file(5554):
            pytest.skip("Could not stage test file on emulator")

        alice, bob = self._pair_and_open_chat(
            device_pair["alice"], device_pair["bob"], app_helper
        )

        self._send_file(alice)

        # Verify a file message appears in Alice's chat.
        # The chat shows "Sending file: zajel_test.txt" as content,
        # and the file bubble displays the filename.
        try:
            alice._find("zajel_test", timeout=15)
            sent = True
        except Exception:
            sent = False
        assert sent, "File message should appear in sender's chat"

    def test_receive_file(self, device_pair, app_helper):
        """Sender's file appears in receiver's chat."""
        if not self._stage_test_file(5554):
            pytest.skip("Could not stage test file on emulator")

        alice, bob = self._pair_and_open_chat(
            device_pair["alice"], device_pair["bob"], app_helper
        )

        self._send_file(alice)

        # Wait for transfer to complete
        time.sleep(10)

        # Bob should see the file in their chat
        try:
            bob._find("zajel_test", timeout=15)
            received = True
        except Exception:
            received = False
        assert received, "File message should appear in receiver's chat"

    def test_file_visible_both_sides(self, device_pair, app_helper):
        """After file transfer, both sides see the file message."""
        if not self._stage_test_file(5554):
            pytest.skip("Could not stage test file on emulator")

        alice, bob = self._pair_and_open_chat(
            device_pair["alice"], device_pair["bob"], app_helper
        )

        self._send_file(alice)

        time.sleep(10)

        # Check both sides
        alice_sees = False
        bob_sees = False
        try:
            alice._find("zajel_test", timeout=15)
            alice_sees = True
        except Exception:
            pass
        try:
            bob._find("zajel_test", timeout=15)
            bob_sees = True
        except Exception:
            pass

        assert alice_sees and bob_sees, \
            f"Both should see file: alice={alice_sees}, bob={bob_sees}"
