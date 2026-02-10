"""
Signaling-only headless tests.

These tests validate the signaling protocol (register, pair, match) using
the SignalingClient directly — no WebRTC, no aiortc. This makes them fast
and reliable on CI runners where ICE/STUN may be restricted.
"""

import asyncio
import pytest

from config import SIGNALING_URL

from zajel.signaling import SignalingClient
from zajel.crypto import CryptoService


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
class TestSignalingHeadless:
    """Signaling-level tests using two headless clients (no WebRTC)."""

    def _skip_if_no_signaling(self):
        if not SIGNALING_URL:
            pytest.skip("SIGNALING_URL not set")

    def test_registration(self, run):
        """Client registers with signaling server and gets ack."""
        self._skip_if_no_signaling()

        async def _test():
            crypto = CryptoService()
            crypto.initialize()
            client = SignalingClient(SIGNALING_URL)
            try:
                code = await client.connect(crypto.public_key_base64)
                assert len(code) == 6
                assert client.is_connected

                # Wait for registered ack
                await asyncio.wait_for(client._registered.wait(), timeout=10)
            finally:
                await client.disconnect()

        run(_test())

    def test_two_clients_register(self, run):
        """Two clients can register simultaneously."""
        self._skip_if_no_signaling()

        async def _test():
            crypto_a = CryptoService()
            crypto_a.initialize()
            crypto_b = CryptoService()
            crypto_b.initialize()

            alice = SignalingClient(SIGNALING_URL)
            bob = SignalingClient(SIGNALING_URL)
            try:
                alice_code = await alice.connect(crypto_a.public_key_base64)
                bob_code = await bob.connect(crypto_b.public_key_base64)

                assert alice_code != bob_code
                assert len(alice_code) == 6
                assert len(bob_code) == 6
                assert alice.is_connected
                assert bob.is_connected

                # Both should be registered
                await asyncio.wait_for(alice._registered.wait(), timeout=10)
                await asyncio.wait_for(bob._registered.wait(), timeout=10)
            finally:
                await alice.disconnect()
                await bob.disconnect()

        run(_test())

    def test_pairing_handshake(self, run):
        """Full pairing handshake: request, accept, match."""
        self._skip_if_no_signaling()

        async def _test():
            crypto_a = CryptoService()
            crypto_a.initialize()
            crypto_b = CryptoService()
            crypto_b.initialize()

            alice = SignalingClient(SIGNALING_URL)
            bob = SignalingClient(SIGNALING_URL)
            try:
                alice_code = await alice.connect(crypto_a.public_key_base64)
                bob_code = await bob.connect(crypto_b.public_key_base64)

                # Wait for both to be registered
                await asyncio.wait_for(alice._registered.wait(), timeout=10)
                await asyncio.wait_for(bob._registered.wait(), timeout=10)

                # Bob requests to pair with Alice
                await bob.pair_with(alice_code, proposed_name="Bob")

                # Alice receives the pair request
                req = await alice.wait_for_pair_request(timeout=15)
                assert req.from_code == bob_code

                # Alice accepts
                await alice.respond_to_pair(req.from_code, accept=True)

                # Both should receive pair_matched
                alice_match, bob_match = await asyncio.gather(
                    alice.wait_for_pair_match(timeout=15),
                    bob.wait_for_pair_match(timeout=15),
                )

                assert alice_match.peer_code == bob_code
                assert bob_match.peer_code == alice_code
                assert alice_match.peer_public_key is not None
                assert bob_match.peer_public_key is not None
            finally:
                await alice.disconnect()
                await bob.disconnect()

        run(_test())

    def test_pair_rejection(self, run):
        """Rejected pair request sends rejection to requester."""
        self._skip_if_no_signaling()

        async def _test():
            crypto_a = CryptoService()
            crypto_a.initialize()
            crypto_b = CryptoService()
            crypto_b.initialize()

            alice = SignalingClient(SIGNALING_URL)
            bob = SignalingClient(SIGNALING_URL)
            try:
                alice_code = await alice.connect(crypto_a.public_key_base64)
                await bob.connect(crypto_b.public_key_base64)

                await asyncio.wait_for(alice._registered.wait(), timeout=10)
                await asyncio.wait_for(bob._registered.wait(), timeout=10)

                # Bob requests to pair with Alice
                await bob.pair_with(alice_code, proposed_name="Bob")

                # Alice receives and rejects
                req = await alice.wait_for_pair_request(timeout=15)
                await alice.respond_to_pair(req.from_code, accept=False)

                # Bob should get a rejection
                rejection = await asyncio.wait_for(
                    bob._pair_rejections.get(), timeout=15
                )
                assert rejection is not None
            finally:
                await alice.disconnect()
                await bob.disconnect()

        run(_test())

    def test_pair_nonexistent_code(self, run):
        """Pair request to nonexistent code returns error."""
        self._skip_if_no_signaling()

        async def _test():
            crypto = CryptoService()
            crypto.initialize()

            bob = SignalingClient(SIGNALING_URL)
            try:
                await bob.connect(crypto.public_key_base64)
                await asyncio.wait_for(bob._registered.wait(), timeout=10)

                # Pair with a code that doesn't exist
                await bob.pair_with("ZZZZZZ", proposed_name="Bob")

                # Should get an error
                error = await asyncio.wait_for(
                    bob._errors.get(), timeout=15
                )
                assert error is not None
            finally:
                await bob.disconnect()

        run(_test())

    def test_webrtc_signal_relay(self, run):
        """After pairing, WebRTC signals are relayed between peers."""
        self._skip_if_no_signaling()

        async def _test():
            crypto_a = CryptoService()
            crypto_a.initialize()
            crypto_b = CryptoService()
            crypto_b.initialize()

            alice = SignalingClient(SIGNALING_URL)
            bob = SignalingClient(SIGNALING_URL)
            try:
                alice_code = await alice.connect(crypto_a.public_key_base64)
                bob_code = await bob.connect(crypto_b.public_key_base64)

                await asyncio.wait_for(alice._registered.wait(), timeout=10)
                await asyncio.wait_for(bob._registered.wait(), timeout=10)

                # Complete pairing
                await bob.pair_with(alice_code, proposed_name="Bob")
                req = await alice.wait_for_pair_request(timeout=15)
                await alice.respond_to_pair(req.from_code, accept=True)
                await asyncio.gather(
                    alice.wait_for_pair_match(timeout=15),
                    bob.wait_for_pair_match(timeout=15),
                )

                # Bob sends an SDP offer to Alice via the signaling server
                test_sdp = "v=0\r\no=- 1234 1234 IN IP4 127.0.0.1\r\n"
                await bob.send_offer(alice_code, test_sdp)

                # Alice should receive the offer
                signal = await alice.wait_for_webrtc_signal(timeout=15)
                assert signal.signal_type == "offer"
                assert signal.payload["sdp"] == test_sdp

                # Alice sends an answer back
                answer_sdp = "v=0\r\no=- 5678 5678 IN IP4 127.0.0.1\r\n"
                await alice.send_answer(bob_code, answer_sdp)

                # Bob should receive the answer
                signal = await bob.wait_for_webrtc_signal(timeout=15)
                assert signal.signal_type == "answer"
                assert signal.payload["sdp"] == answer_sdp
            finally:
                await alice.disconnect()
                await bob.disconnect()

        run(_test())
