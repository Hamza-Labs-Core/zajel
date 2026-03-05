"""Diagnostics module — structured error tracking for the headless client."""

from .categorizer import ErrorCategorizer, ErrorCategory
from .models import DiagnosticError
from .scrubber import DiagnosticsScrubber
from .signature import ErrorSignature
from .tracker import ErrorTracker

__all__ = [
    "DiagnosticError",
    "ErrorCategory",
    "ErrorCategorizer",
    "ErrorSignature",
    "DiagnosticsScrubber",
    "ErrorTracker",
]
