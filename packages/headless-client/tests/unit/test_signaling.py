"""Tests for signaling client message parsing."""

import asyncio
import time

import pytest
from zajel.signaling import (
    generate_pairing_code, PAIRING_CODE_CHARS, PAIRING_CODE_LENGTH,
    SignalingClient,
)


class TestPairingCode:
    def test_length(self):
        code = generate_pairing_code()
        assert len(code) == PAIRING_CODE_LENGTH

    def test_valid_characters(self):
        for _ in range(100):
            code = generate_pairing_code()
            for char in code:
                assert char in PAIRING_CODE_CHARS

    def test_no_ambiguous_characters(self):
        for _ in range(100):
            code = generate_pairing_code()
            assert "0" not in code
            assert "O" not in code
            assert "1" not in code
            assert "I" not in code

    def test_randomness(self):
        codes = {generate_pairing_code() for _ in range(100)}
        # Should generate mostly unique codes
        assert len(codes) > 90


class TestPairErrorFastFail:
    """wait_for_pair_match should fail fast when pair_error arrives."""

    @pytest.mark.asyncio
    async def test_pair_error_unblocks_wait(self):
        """pair_error event should cause wait_for_pair_match to raise immediately."""
        client = SignalingClient("ws://localhost:9999")

        # Simulate pair_error arriving after a short delay
        async def send_error():
            await asyncio.sleep(0.1)
            client._last_pair_error = "code not found"
            client._pair_error_event.set()

        asyncio.create_task(send_error())

        start = time.monotonic()
        with pytest.raises(RuntimeError, match="Pair error"):
            await client.wait_for_pair_match(timeout=30)
        elapsed = time.monotonic() - start

        # Should complete in well under 1 second (not wait 30s)
        assert elapsed < 2.0

    @pytest.mark.asyncio
    async def test_pair_match_still_works(self):
        """Normal pair_match should still be returned correctly."""
        from zajel.signaling import PairMatch
        client = SignalingClient("ws://localhost:9999")

        match = PairMatch(peer_code="ABC123", peer_public_key="key", is_initiator=True)
        async def send_match():
            await asyncio.sleep(0.1)
            await client._pair_matches.put(match)

        asyncio.create_task(send_match())
        result = await client.wait_for_pair_match(timeout=5)
        assert result.peer_code == "ABC123"

    @pytest.mark.asyncio
    async def test_pair_with_clears_error_state(self):
        """pair_with should clear the error event before sending."""
        client = SignalingClient("ws://localhost:9999")
        client._pair_error_event.set()
        client._last_pair_error = "stale error"

        # pair_with calls _send which will fail (no connection),
        # but the error event should be cleared first
        try:
            await client.pair_with("TARGET")
        except Exception:
            pass  # Expected: no connection

        assert not client._pair_error_event.is_set()
