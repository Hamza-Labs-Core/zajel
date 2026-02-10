"""Video sources for testing video calls.

Provides:
- ColorBarSource: Generates SMPTE color bar test pattern
- FileVideoSource: Reads from a video file
"""

import fractions
import logging
import time
from typing import Optional

import av
import numpy as np
from aiortc import MediaStreamTrack
from av import VideoFrame

logger = logging.getLogger("zajel.media.video")

VIDEO_FPS = 30
VIDEO_WIDTH = 640
VIDEO_HEIGHT = 480
VIDEO_TIME_BASE = fractions.Fraction(1, VIDEO_FPS)

# SMPTE color bar colors (top row)
COLOR_BARS = [
    (192, 192, 192),  # White
    (192, 192, 0),    # Yellow
    (0, 192, 192),    # Cyan
    (0, 192, 0),      # Green
    (192, 0, 192),    # Magenta
    (192, 0, 0),      # Red
    (0, 0, 192),      # Blue
]


class ColorBarSource(MediaStreamTrack):
    """Generates SMPTE color bar test pattern as a video track."""

    kind = "video"

    def __init__(
        self,
        width: int = VIDEO_WIDTH,
        height: int = VIDEO_HEIGHT,
        fps: int = VIDEO_FPS,
        duration: Optional[float] = None,
    ):
        super().__init__()
        self._width = width
        self._height = height
        self._fps = fps
        self._duration = duration
        self._start_time: Optional[float] = None
        self._frame_count = 0
        self._frame = self._generate_pattern()

    def _generate_pattern(self) -> np.ndarray:
        """Generate a color bar test pattern."""
        img = np.zeros((self._height, self._width, 3), dtype=np.uint8)
        bar_width = self._width // len(COLOR_BARS)

        for i, (r, g, b) in enumerate(COLOR_BARS):
            x_start = i * bar_width
            x_end = (i + 1) * bar_width if i < len(COLOR_BARS) - 1 else self._width
            img[:, x_start:x_end] = [r, g, b]

        return img

    async def recv(self) -> VideoFrame:
        import asyncio

        if self._start_time is None:
            self._start_time = time.time()

        if self._duration and (time.time() - self._start_time) > self._duration:
            self.stop()

        pts = self._frame_count
        self._frame_count += 1

        frame = VideoFrame.from_ndarray(self._frame, format="rgb24")
        frame.pts = pts
        frame.time_base = VIDEO_TIME_BASE

        # Pace the output
        target_time = self._start_time + (self._frame_count / self._fps)
        wait = target_time - time.time()
        if wait > 0:
            await asyncio.sleep(wait)

        return frame


class FileVideoSource(MediaStreamTrack):
    """Reads video from a file as a media track."""

    kind = "video"

    def __init__(self, file_path: str, loop: bool = True):
        super().__init__()
        self._file_path = file_path
        self._loop = loop
        self._container: Optional[av.InputContainer] = None
        self._stream = None
        self._start_time: Optional[float] = None
        self._frame_count = 0
        self._open()

    def _open(self) -> None:
        self._container = av.open(self._file_path)
        self._stream = self._container.streams.video[0]

    async def recv(self) -> VideoFrame:
        import asyncio

        if self._start_time is None:
            self._start_time = time.time()

        while True:
            try:
                frame = next(self._container.decode(self._stream))
                self._frame_count += 1

                target_time = self._start_time + (
                    self._frame_count / VIDEO_FPS
                )
                wait = target_time - time.time()
                if wait > 0:
                    await asyncio.sleep(wait)

                return frame
            except StopIteration:
                if self._loop:
                    self._container.close()
                    self._open()
                else:
                    self.stop()
                    raise
