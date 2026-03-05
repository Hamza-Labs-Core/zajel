"""Tests for ErrorTracker."""

import json
import logging
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

from zajel.diagnostics.tracker import ErrorTracker, MAX_BUFFER_SIZE


class TestEnableDisable:
    def test_starts_not_running(self):
        tracker = ErrorTracker()
        assert not tracker.is_running

    def test_start_sets_running(self):
        tracker = ErrorTracker()
        tracker.start()
        assert tracker.is_running
        tracker.stop()

    def test_stop_clears_running(self):
        tracker = ErrorTracker()
        tracker.start()
        tracker.stop()
        assert not tracker.is_running

    def test_start_idempotent(self):
        tracker = ErrorTracker()
        tracker.start()
        tracker.start()  # no-op
        assert tracker.is_running
        tracker.stop()

    def test_stop_idempotent(self):
        tracker = ErrorTracker()
        tracker.start()
        tracker.stop()
        tracker.stop()  # no-op
        assert not tracker.is_running

    def test_disabled_tracker_does_not_start(self):
        tracker = ErrorTracker(enabled=False)
        tracker.start()
        assert not tracker.is_running

    def test_record_error_when_not_running(self):
        tracker = ErrorTracker()
        tracker.record_error(ValueError("test"))
        assert tracker.buffer_size == 0


class TestDeduplication:
    def test_same_error_increments_count(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            err = ConnectionError("refused")
            tracker.record_error(err)
            tracker.record_error(err)
            tracker.record_error(err)

            errors = tracker.snapshot()
            assert len(errors) == 1
            assert errors[0].count == 3
        finally:
            tracker.stop()

    def test_different_errors_separate_entries(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            tracker.record_error(ConnectionError("refused"))
            tracker.record_error(FileNotFoundError("db.sqlite"))

            errors = tracker.snapshot()
            assert len(errors) == 2
        finally:
            tracker.stop()

    def test_last_occurrence_updated_on_dedup(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            err = ConnectionError("refused")
            tracker.record_error(err)
            first_errors = tracker.snapshot()
            first_last = first_errors[0].last_occurrence

            time.sleep(0.01)
            tracker.record_error(err)
            second_errors = tracker.snapshot()
            assert second_errors[0].last_occurrence >= first_last
        finally:
            tracker.stop()


class TestDrainAndSnapshot:
    def test_drain_returns_and_clears(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            tracker.record_error(ValueError("test"))
            errors = tracker.drain()
            assert len(errors) == 1
            assert tracker.buffer_size == 0
        finally:
            tracker.stop()

    def test_snapshot_returns_without_clearing(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            tracker.record_error(ValueError("test"))
            errors = tracker.snapshot()
            assert len(errors) == 1
            assert tracker.buffer_size == 1
        finally:
            tracker.stop()

    def test_drain_empty_buffer(self):
        tracker = ErrorTracker()
        tracker.start()
        try:
            assert tracker.drain() == []
        finally:
            tracker.stop()


class TestBufferLimit:
    def test_max_buffer_size(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            for i in range(MAX_BUFFER_SIZE + 20):
                tracker.record_error(ValueError(f"error_{i}"))

            assert tracker.buffer_size == MAX_BUFFER_SIZE
        finally:
            tracker.stop()

    def test_eviction_removes_oldest(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            # Fill buffer
            for i in range(MAX_BUFFER_SIZE):
                tracker.record_error(ValueError(f"error_{i}"))
                time.sleep(0.001)  # Ensure distinct timestamps

            # Record one more — should evict oldest
            tracker.record_error(ValueError("newest_error"))

            errors = tracker.snapshot()
            messages = {e.message for e in errors}
            # First error should be evicted
            assert "error_0" not in messages
            assert "newest_error" in messages
        finally:
            tracker.stop()


class TestMessageTruncation:
    def test_long_message_truncated(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            long_msg = "x" * 2000
            tracker.record_error(ValueError(long_msg))
            errors = tracker.snapshot()
            assert len(errors[0].message) == 1024
        finally:
            tracker.stop()


class TestScrubbing:
    def test_pii_scrubbed_by_default(self):
        tracker = ErrorTracker()
        tracker.start()
        try:
            tracker.record_error(
                ConnectionError("connection to 192.168.1.1 failed")
            )
            errors = tracker.snapshot()
            assert "192.168.1.1" not in errors[0].message
            assert "[IP]" in errors[0].message
        finally:
            tracker.stop()

    def test_scrubbing_disabled(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            tracker.record_error(
                ConnectionError("connection to 192.168.1.1 failed")
            )
            errors = tracker.snapshot()
            assert "192.168.1.1" in errors[0].message
        finally:
            tracker.stop()


class TestLoggingHandler:
    def test_error_log_captured(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            zajel_logger = logging.getLogger("zajel")
            zajel_logger.error("something broke")

            errors = tracker.snapshot()
            assert len(errors) >= 1
            assert any("something broke" in e.message for e in errors)
        finally:
            tracker.stop()

    def test_warning_log_not_captured(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            zajel_logger = logging.getLogger("zajel")
            zajel_logger.warning("just a warning")

            errors = tracker.snapshot()
            # Warning should not be captured (handler level is ERROR)
            assert not any("just a warning" in e.message for e in errors)
        finally:
            tracker.stop()

    def test_handler_removed_on_stop(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        zajel_logger = logging.getLogger("zajel")
        handler_count_started = len(zajel_logger.handlers)
        tracker.stop()
        handler_count_stopped = len(zajel_logger.handlers)
        assert handler_count_stopped < handler_count_started


class TestFileOutput:
    def test_write_to_file(self, tmp_path):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            tracker.record_error(ValueError("test error"))
            out_file = str(tmp_path / "diag.json")
            result = tracker.write_to_file(out_file)

            assert result == out_file
            data = json.loads(Path(out_file).read_text())
            assert "timestamp" in data
            assert "summary" in data
            assert "errors" in data
            assert len(data["errors"]) == 1
            assert data["errors"][0]["message"] == "test error"
        finally:
            tracker.stop()

    def test_write_to_default_path(self, tmp_path):
        out_file = str(tmp_path / "default.json")
        tracker = ErrorTracker(scrub=False, output_path=out_file)
        tracker.start()
        try:
            tracker.record_error(ValueError("test"))
            result = tracker.write_to_file()
            assert result == out_file
            assert Path(out_file).exists()
        finally:
            tracker.stop()

    def test_write_no_path_returns_none(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            assert tracker.write_to_file() is None
        finally:
            tracker.stop()

    def test_creates_parent_dirs(self, tmp_path):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            tracker.record_error(ValueError("test"))
            out = str(tmp_path / "nested" / "dir" / "diag.json")
            tracker.write_to_file(out)
            assert Path(out).exists()
        finally:
            tracker.stop()


class TestSummary:
    def test_summary_structure(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            tracker.record_error(ConnectionError("refused"))
            tracker.record_error(ConnectionError("refused"))
            tracker.record_error(FileNotFoundError("db"))

            summary = tracker.get_summary()
            assert summary["unique_errors"] == 2
            assert summary["total_occurrences"] == 3
            assert "network" in summary["by_category"]
            assert "storage" in summary["by_category"]
        finally:
            tracker.stop()

    def test_empty_summary(self):
        tracker = ErrorTracker()
        tracker.start()
        try:
            summary = tracker.get_summary()
            assert summary["unique_errors"] == 0
            assert summary["total_occurrences"] == 0
            assert summary["by_category"] == {}
        finally:
            tracker.stop()


class TestThreadSafety:
    def test_concurrent_record_errors(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            errors_per_thread = 50
            num_threads = 4

            def record_many(thread_id):
                for i in range(errors_per_thread):
                    tracker.record_error(
                        ValueError(f"thread_{thread_id}_error_{i}")
                    )

            threads = [
                threading.Thread(target=record_many, args=(t,))
                for t in range(num_threads)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            # All unique errors should be captured (up to buffer limit)
            total_unique = num_threads * errors_per_thread
            expected = min(total_unique, MAX_BUFFER_SIZE)
            assert tracker.buffer_size == expected
        finally:
            tracker.stop()

    def test_concurrent_drain(self):
        tracker = ErrorTracker(scrub=False)
        tracker.start()
        try:
            for i in range(10):
                tracker.record_error(ValueError(f"error_{i}"))

            results = []

            def drain_once():
                results.append(tracker.drain())

            threads = [
                threading.Thread(target=drain_once) for _ in range(3)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            # Only one thread should get the errors
            non_empty = [r for r in results if len(r) > 0]
            total_errors = sum(len(r) for r in results)
            assert total_errors == 10
        finally:
            tracker.stop()


class TestHookChaining:
    def test_excepthook_chains_to_previous(self):
        tracker = ErrorTracker(scrub=False)
        original_hook = sys.excepthook
        called = []

        def custom_hook(exc_type, exc_value, exc_tb):
            called.append(exc_type)

        sys.excepthook = custom_hook
        try:
            tracker.start()
            # Simulate unhandled exception
            sys.excepthook(ValueError, ValueError("test"), None)
            assert ValueError in called
        finally:
            tracker.stop()
            sys.excepthook = original_hook

    def test_hooks_restored_on_stop(self):
        original = sys.excepthook
        tracker = ErrorTracker()
        tracker.start()
        assert sys.excepthook is not original
        tracker.stop()
        assert sys.excepthook is original
