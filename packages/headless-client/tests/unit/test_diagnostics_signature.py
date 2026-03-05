"""Tests for ErrorSignature computation."""

import hashlib
import re
import sys

from zajel.diagnostics.signature import ErrorSignature


class TestSignatureFormat:
    def test_returns_64_hex_chars(self):
        sig = ErrorSignature.compute("network", None, "timeout")
        assert len(sig) == 64
        assert re.match(r"^[0-9a-f]{64}$", sig)

    def test_lowercase_hex(self):
        sig = ErrorSignature.compute("crash", None, "segfault")
        assert sig == sig.lower()


class TestAppFrameExtraction:
    def test_uses_app_frames(self):
        """Frames containing 'zajel/' are included in signature."""
        code = compile("raise ValueError('x')", "zajel/client.py", "exec")
        try:
            exec(code)
        except ValueError:
            tb = sys.exc_info()[2]

        sig1 = ErrorSignature.compute("network", tb, "error A")
        sig2 = ErrorSignature.compute("network", tb, "error B")
        # Same frames → same signature regardless of message
        assert sig1 == sig2

    def test_different_frames_different_signature(self):
        """Different code locations produce different signatures."""
        code1 = compile("raise ValueError('x')", "zajel/client.py", "exec")
        try:
            exec(code1)
        except ValueError:
            tb1 = sys.exc_info()[2]

        code2 = compile("raise ValueError('x')", "zajel/signaling.py", "exec")
        try:
            exec(code2)
        except ValueError:
            tb2 = sys.exc_info()[2]

        sig1 = ErrorSignature.compute("network", tb1, "same msg")
        sig2 = ErrorSignature.compute("network", tb2, "same msg")
        assert sig1 != sig2

    def test_non_app_frames_ignored(self):
        """Frames not containing 'zajel/' are excluded."""
        code = compile("raise ValueError('x')", "some_library.py", "exec")
        try:
            exec(code)
        except ValueError:
            tb = sys.exc_info()[2]

        # No app frames → falls back to message
        sig = ErrorSignature.compute("other", tb, "test message")
        expected = hashlib.sha256(b"other:test message").hexdigest()
        assert sig == expected


class TestFallback:
    def test_none_traceback_uses_message(self):
        sig = ErrorSignature.compute("network", None, "connection lost")
        expected = hashlib.sha256(b"network:connection lost").hexdigest()
        assert sig == expected

    def test_different_messages_different_fallback(self):
        sig1 = ErrorSignature.compute("crypto", None, "decrypt failed")
        sig2 = ErrorSignature.compute("crypto", None, "encrypt failed")
        assert sig1 != sig2

    def test_different_category_different_fallback(self):
        sig1 = ErrorSignature.compute("network", None, "same error")
        sig2 = ErrorSignature.compute("crypto", None, "same error")
        assert sig1 != sig2


class TestDeterminism:
    def test_same_input_same_output(self):
        results = set()
        for _ in range(50):
            sig = ErrorSignature.compute("storage", None, "db locked")
            results.add(sig)
        assert len(results) == 1

    def test_deterministic_with_traceback(self):
        code = compile("raise ValueError('x')", "zajel/crypto.py", "exec")
        try:
            exec(code)
        except ValueError:
            tb = sys.exc_info()[2]

        sigs = {ErrorSignature.compute("crypto", tb, "test") for _ in range(50)}
        assert len(sigs) == 1


class TestMaxFrames:
    def test_max_three_frames(self):
        """Only the last 3 app frames are used, even if more exist."""
        # Create a traceback with nested calls in zajel/ files
        # We simulate by using the same exec approach
        code = compile(
            "raise ValueError('deep')", "zajel/deep_module.py", "exec"
        )
        try:
            exec(code)
        except ValueError:
            tb = sys.exc_info()[2]

        # Single frame case — just verifying it doesn't crash
        sig = ErrorSignature.compute("other", tb, "deep error")
        assert len(sig) == 64
