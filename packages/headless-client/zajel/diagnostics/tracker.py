"""Error tracker — hooks sys.excepthook + logging.Handler, buffers errors."""

import json
import logging
import sys
import threading
import time
import traceback as tb_module
from pathlib import Path
from types import TracebackType

from .categorizer import ErrorCategorizer
from .models import DiagnosticError
from .scrubber import DiagnosticsScrubber
from .signature import ErrorSignature

logger = logging.getLogger(__name__)

MAX_BUFFER_SIZE = 100


class _DiagnosticsLogHandler(logging.Handler):
    """Logging handler that feeds ERROR+ records into the tracker."""

    def __init__(self, tracker: "ErrorTracker") -> None:
        super().__init__(level=logging.ERROR)
        self._tracker = tracker

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if record.exc_info and record.exc_info[1] is not None:
                error = record.exc_info[1]
                tb = record.exc_info[2]
            else:
                error = Exception(record.getMessage())
                tb = None
            self._tracker.record_error(error, tb)
        except Exception:
            # Never let diagnostics crash the application
            pass


class ErrorTracker:
    """Track, deduplicate, and buffer diagnostic errors.

    Hooks into sys.excepthook, threading.excepthook, and the 'zajel'
    logger to capture errors automatically.
    """

    def __init__(
        self,
        enabled: bool = True,
        output_path: str | None = None,
        scrub: bool = True,
    ) -> None:
        self._enabled = enabled
        self._output_path = output_path
        self._scrub = scrub
        self._running = False

        # Thread-safe buffer: signature → DiagnosticError
        self._lock = threading.Lock()
        self._buffer: dict[str, DiagnosticError] = {}

        # Saved hook references for restoration
        self._prev_excepthook = None
        self._prev_threading_excepthook = None
        self._log_handler: _DiagnosticsLogHandler | None = None

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def buffer_size(self) -> int:
        with self._lock:
            return len(self._buffer)

    @property
    def error_tracker(self) -> "ErrorTracker":
        return self

    def start(self) -> None:
        """Register error hooks. Idempotent."""
        if self._running or not self._enabled:
            return

        # Hook sys.excepthook
        self._prev_excepthook = sys.excepthook
        sys.excepthook = self._excepthook

        # Hook threading.excepthook
        self._prev_threading_excepthook = getattr(
            threading, "excepthook", None
        )
        threading.excepthook = self._threading_excepthook

        # Hook logging
        self._log_handler = _DiagnosticsLogHandler(self)
        zajel_logger = logging.getLogger("zajel")
        zajel_logger.addHandler(self._log_handler)

        self._running = True
        logger.debug("ErrorTracker started")

    def stop(self) -> None:
        """Unregister error hooks. Idempotent."""
        if not self._running:
            return

        # Restore sys.excepthook
        if self._prev_excepthook is not None:
            sys.excepthook = self._prev_excepthook
            self._prev_excepthook = None

        # Restore threading.excepthook
        if self._prev_threading_excepthook is not None:
            threading.excepthook = self._prev_threading_excepthook
        else:
            # Reset to default if there was no previous hook
            threading.excepthook = threading.__excepthook__
        self._prev_threading_excepthook = None

        # Remove logging handler
        if self._log_handler is not None:
            zajel_logger = logging.getLogger("zajel")
            zajel_logger.removeHandler(self._log_handler)
            self._log_handler = None

        self._running = False
        logger.debug("ErrorTracker stopped")

    def record_error(
        self,
        error: BaseException,
        tb: TracebackType | None = None,
    ) -> None:
        """Manually record an error. Only captures if running and enabled."""
        if not self._running or not self._enabled:
            return
        self._capture_error(error, tb)

    def drain(self) -> list[DiagnosticError]:
        """Return all buffered errors and clear the buffer."""
        with self._lock:
            errors = list(self._buffer.values())
            self._buffer.clear()
        return errors

    def snapshot(self) -> list[DiagnosticError]:
        """Return all buffered errors without clearing."""
        with self._lock:
            return list(self._buffer.values())

    def get_summary(self) -> dict:
        """Return summary statistics."""
        with self._lock:
            errors = list(self._buffer.values())

        by_category: dict[str, int] = {}
        total_occurrences = 0
        for err in errors:
            by_category[err.category] = (
                by_category.get(err.category, 0) + err.count
            )
            total_occurrences += err.count

        return {
            "unique_errors": len(errors),
            "total_occurrences": total_occurrences,
            "by_category": by_category,
        }

    def write_to_file(self, path: str | None = None) -> str | None:
        """Write diagnostics JSON to file. Returns the path written."""
        target = path or self._output_path
        if target is None:
            return None

        errors = self.snapshot()
        summary = self.get_summary()

        data = {
            "timestamp": int(time.time() * 1000),
            "summary": summary,
            "errors": [e.to_dict() for e in errors],
        }

        out_path = Path(target)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(data, indent=2))
        logger.debug("Diagnostics written to %s", target)
        return str(out_path)

    # -- Internal hooks --

    def _excepthook(
        self,
        exc_type: type[BaseException],
        exc_value: BaseException,
        exc_tb: TracebackType | None,
    ) -> None:
        """sys.excepthook replacement — capture then chain."""
        if self._enabled:
            self._capture_error(exc_value, exc_tb)
        # Chain to previous handler
        if self._prev_excepthook is not None:
            self._prev_excepthook(exc_type, exc_value, exc_tb)

    def _threading_excepthook(self, args: threading.ExceptHookArgs) -> None:
        """threading.excepthook replacement — capture then chain."""
        if self._enabled:
            self._capture_error(args.exc_value, args.exc_traceback)
        # Chain to previous handler
        if self._prev_threading_excepthook is not None:
            self._prev_threading_excepthook(args)

    def _capture_error(
        self,
        error: BaseException | None,
        tb: TracebackType | None = None,
    ) -> None:
        """Core capture logic — categorize, sign, dedup, buffer."""
        if error is None:
            return

        try:
            category = ErrorCategorizer.categorize(error, tb)
            message = str(error)

            # Truncate message
            if len(message) > DiagnosticError.MAX_MESSAGE_LENGTH:
                message = message[: DiagnosticError.MAX_MESSAGE_LENGTH]

            # Compute signature
            sig = ErrorSignature.compute(category, tb, message)

            # Get stack trace string
            stack_trace: str | None = None
            if tb is not None:
                stack_trace = "".join(tb_module.format_tb(tb))

            # Scrub PII
            if self._scrub:
                message = DiagnosticsScrubber.scrub_message(message)
                if stack_trace:
                    stack_trace = DiagnosticsScrubber.scrub_stack_trace(
                        stack_trace
                    )

            now = int(time.time() * 1000)

            with self._lock:
                if sig in self._buffer:
                    # Dedup: increment count and update last_occurrence
                    existing = self._buffer[sig]
                    existing.count += 1
                    existing.last_occurrence = now
                else:
                    # Evict oldest if buffer full
                    if len(self._buffer) >= MAX_BUFFER_SIZE:
                        self._evict_oldest()

                    self._buffer[sig] = DiagnosticError(
                        category=category,
                        message=message,
                        signature=sig,
                        stack_trace=stack_trace,
                        count=1,
                        first_occurrence=now,
                        last_occurrence=now,
                    )
        except Exception:
            # Never let diagnostics crash the application
            pass

    def _evict_oldest(self) -> None:
        """Remove the entry with the oldest first_occurrence (LRU)."""
        if not self._buffer:
            return
        oldest_sig = min(
            self._buffer, key=lambda s: self._buffer[s].first_occurrence
        )
        del self._buffer[oldest_sig]
