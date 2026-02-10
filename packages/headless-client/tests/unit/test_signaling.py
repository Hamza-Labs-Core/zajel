"""Tests for signaling client message parsing."""

import pytest
from zajel.signaling import generate_pairing_code, PAIRING_CODE_CHARS, PAIRING_CODE_LENGTH


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
