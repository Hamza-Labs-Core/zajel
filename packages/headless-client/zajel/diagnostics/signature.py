"""SHA-256 error signature for deduplication."""

import hashlib
import traceback as tb_module
from types import TracebackType

# Max number of app frames to include in signature
_MAX_FRAMES = 3

# Marker for "app-owned" frames
_APP_MARKER = "zajel/"


class ErrorSignature:
    """Compute a stable SHA-256 signature for error deduplication."""

    @staticmethod
    def compute(
        category: str,
        tb: TracebackType | None,
        message: str,
    ) -> str:
        """Return a 64-char lowercase hex SHA-256 signature.

        Uses the top 3 app frames (files containing 'zajel/') from the
        traceback. Falls back to the message if no app frames are found.
        """
        frame_str = _extract_frame_string(tb)
        if frame_str is None:
            payload = f"{category}:{message}"
        else:
            payload = f"{category}:{frame_str}"

        return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _extract_frame_string(tb: TracebackType | None) -> str | None:
    """Extract normalized app frame string from traceback.

    Returns None if no app frames found or tb is None.
    """
    if tb is None:
        return None

    frames = tb_module.extract_tb(tb)
    app_frames: list[str] = []

    for frame in frames:
        if _APP_MARKER in frame.filename:
            # Normalize to path/file.py:line (strip function name and column)
            normalized = f"{frame.filename}:{frame.lineno}"
            app_frames.append(normalized)

    if not app_frames:
        return None

    # Take the top N (most recent) meaningful frames
    return "|".join(app_frames[-_MAX_FRAMES:])
