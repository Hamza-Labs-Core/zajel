"""Diagnostic error model for structured error tracking."""

import time
from dataclasses import dataclass, field


@dataclass
class DiagnosticError:
    """A deduplicated diagnostic error entry.

    Mirrors the Dart DiagnosticError model. Errors with the same signature
    are collapsed into a single entry with an incrementing count.
    """

    MAX_MESSAGE_LENGTH = 1024

    category: str
    message: str
    signature: str
    stack_trace: str | None = None
    count: int = 1
    first_occurrence: int = field(default_factory=lambda: int(time.time() * 1000))
    last_occurrence: int = 0

    def __post_init__(self) -> None:
        if len(self.message) > self.MAX_MESSAGE_LENGTH:
            self.message = self.message[: self.MAX_MESSAGE_LENGTH]
        if self.last_occurrence == 0:
            self.last_occurrence = self.first_occurrence

    def to_dict(self) -> dict:
        """Serialize to dict with camelCase keys matching Dart's toJson()."""
        return {
            "category": self.category,
            "message": self.message,
            "stackTrace": self.stack_trace,
            "signature": self.signature,
            "count": self.count,
            "firstOccurrence": self.first_occurrence,
            "lastOccurrence": self.last_occurrence,
        }

    def __str__(self) -> str:
        return f"[{self.category}] {self.message} (x{self.count})"
