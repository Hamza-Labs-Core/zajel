"""Call tests for Linux desktop."""

import time
import pytest
from config import P2P_CONNECTION_TIMEOUT, CALL_CONNECT_TIMEOUT


@pytest.mark.calls
class TestCalls:
    """Tests for voice and video calls on Linux."""

    def _pair_and_open_chat(self, alice, bob):
        """Pair instances and open chat on Alice's side."""
        alice.navigate_to_connect()
        code = alice.get_pairing_code_from_connect_screen()
        bob.navigate_to_connect()
        bob.enter_peer_code(code)

        connected = False
        for _ in range(6):
            time.sleep(P2P_CONNECTION_TIMEOUT)
            alice.go_back_to_home()
            bob.go_back_to_home()
            time.sleep(3)
            if alice.is_peer_connected() or bob.is_peer_connected():
                connected = True
                break
        assert connected
        alice.open_chat_with_peer()

    def test_voice_call(self, alice, bob):
        """Start and end a voice call."""
        self._pair_and_open_chat(alice, bob)

        alice.start_voice_call()
        time.sleep(2)

        assert bob.has_incoming_call_dialog(timeout=CALL_CONNECT_TIMEOUT), \
            "Bob should see incoming call"

        bob.accept_incoming_call()
        assert alice.wait_for_call_connected(CALL_CONNECT_TIMEOUT), \
            "Call should connect"

        alice.end_call()
        time.sleep(2)

    def test_reject_call(self, alice, bob):
        """Reject an incoming call."""
        self._pair_and_open_chat(alice, bob)

        alice.start_voice_call()
        time.sleep(2)

        assert bob.has_incoming_call_dialog(timeout=CALL_CONNECT_TIMEOUT)
        bob.reject_incoming_call()
        time.sleep(2)
