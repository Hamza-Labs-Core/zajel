"""Tests for DiagnosticError dataclass."""

import time

from zajel.diagnostics.models import DiagnosticError


class TestDiagnosticErrorDefaults:
    def test_default_count_is_one(self):
        err = DiagnosticError(
            category="network", message="timeout", signature="abc123"
        )
        assert err.count == 1

    def test_default_stack_trace_is_none(self):
        err = DiagnosticError(
            category="network", message="timeout", signature="abc123"
        )
        assert err.stack_trace is None

    def test_first_occurrence_set_automatically(self):
        before = int(time.time() * 1000)
        err = DiagnosticError(
            category="network", message="timeout", signature="abc123"
        )
        after = int(time.time() * 1000)
        assert before <= err.first_occurrence <= after

    def test_last_occurrence_defaults_to_first(self):
        err = DiagnosticError(
            category="network", message="timeout", signature="abc123"
        )
        assert err.last_occurrence == err.first_occurrence


class TestMessageTruncation:
    def test_short_message_unchanged(self):
        err = DiagnosticError(
            category="other", message="short", signature="sig"
        )
        assert err.message == "short"

    def test_message_truncated_at_1024(self):
        long_msg = "x" * 2000
        err = DiagnosticError(
            category="other", message=long_msg, signature="sig"
        )
        assert len(err.message) == 1024

    def test_exact_1024_not_truncated(self):
        msg = "a" * 1024
        err = DiagnosticError(category="other", message=msg, signature="sig")
        assert len(err.message) == 1024
        assert err.message == msg


class TestToDict:
    def test_keys_match_dart_format(self):
        err = DiagnosticError(
            category="crypto",
            message="decrypt failed",
            signature="deadbeef" * 8,
            stack_trace="File foo.py, line 1",
            count=3,
            first_occurrence=1000,
            last_occurrence=2000,
        )
        d = err.to_dict()
        assert set(d.keys()) == {
            "category",
            "message",
            "stackTrace",
            "signature",
            "count",
            "firstOccurrence",
            "lastOccurrence",
        }

    def test_values_serialized_correctly(self):
        err = DiagnosticError(
            category="network",
            message="connection refused",
            signature="aabb",
            stack_trace="traceback here",
            count=5,
            first_occurrence=100,
            last_occurrence=200,
        )
        d = err.to_dict()
        assert d["category"] == "network"
        assert d["message"] == "connection refused"
        assert d["stackTrace"] == "traceback here"
        assert d["signature"] == "aabb"
        assert d["count"] == 5
        assert d["firstOccurrence"] == 100
        assert d["lastOccurrence"] == 200

    def test_null_stack_trace_included(self):
        err = DiagnosticError(
            category="other", message="test", signature="sig"
        )
        d = err.to_dict()
        assert "stackTrace" in d
        assert d["stackTrace"] is None


class TestStrRepr:
    def test_str_includes_category_and_count(self):
        err = DiagnosticError(
            category="storage", message="db locked", signature="sig", count=7
        )
        s = str(err)
        assert "[storage]" in s
        assert "db locked" in s
        assert "x7" in s

    def test_str_default_count(self):
        err = DiagnosticError(
            category="crash", message="segfault", signature="sig"
        )
        assert "(x1)" in str(err)
