"""Audio sources for testing VoIP calls.

Provides:
- SineWaveSource: Generates a test tone
- FileAudioSource: Reads from an audio file
"""

import fractions
import logging
import math
import time
from typing import Optional

import av
import numpy as np
from aiortc import MediaStreamTrack
from av import AudioFrame

logger = logging.getLogger("zajel.media.audio")

AUDIO_PTIME = 0.020  # 20ms per frame
AUDIO_SAMPLE_RATE = 48000
AUDIO_SAMPLES_PER_FRAME = int(AUDIO_SAMPLE_RATE * AUDIO_PTIME)


class SineWaveSource(MediaStreamTrack):
    """Generates a sine wave test tone as an audio track."""

    kind = "audio"

    def __init__(
        self,
        frequency: float = 440.0,
        amplitude: float = 0.5,
        sample_rate: int = AUDIO_SAMPLE_RATE,
        duration: Optional[float] = None,
    ):
        super().__init__()
        self._frequency = frequency
        self._amplitude = amplitude
        self._sample_rate = sample_rate
        self._duration = duration
        self._start_time: Optional[float] = None
        self._sample_offset = 0
        self._time_base = fractions.Fraction(1, sample_rate)

    async def recv(self) -> AudioFrame:
        if self._start_time is None:
            self._start_time = time.time()

        # Check duration limit
        if self._duration and (time.time() - self._start_time) > self._duration:
            self.stop()

        # Generate sine wave samples
        samples = np.zeros(AUDIO_SAMPLES_PER_FRAME, dtype=np.int16)
        for i in range(AUDIO_SAMPLES_PER_FRAME):
            t = (self._sample_offset + i) / self._sample_rate
            samples[i] = int(
                self._amplitude * 32767 * math.sin(2 * math.pi * self._frequency * t)
            )

        self._sample_offset += AUDIO_SAMPLES_PER_FRAME

        frame = AudioFrame(format="s16", layout="mono", samples=AUDIO_SAMPLES_PER_FRAME)
        frame.planes[0].update(samples.tobytes())
        frame.sample_rate = self._sample_rate
        frame.time_base = self._time_base
        frame.pts = self._sample_offset - AUDIO_SAMPLES_PER_FRAME

        # Pace the output
        target_time = self._start_time + (self._sample_offset / self._sample_rate)
        wait = target_time - time.time()
        if wait > 0:
            import asyncio
            await asyncio.sleep(wait)

        return frame


class FileAudioSource(MediaStreamTrack):
    """Reads audio from a file as a media track."""

    kind = "audio"

    def __init__(self, file_path: str, loop: bool = True):
        super().__init__()
        self._file_path = file_path
        self._loop = loop
        self._container: Optional[av.InputContainer] = None
        self._stream = None
        self._resampler = None
        self._start_time: Optional[float] = None
        self._frame_count = 0
        self._open()

    def _open(self) -> None:
        self._container = av.open(self._file_path)
        self._stream = self._container.streams.audio[0]

    async def recv(self) -> AudioFrame:
        if self._start_time is None:
            self._start_time = time.time()

        while True:
            try:
                frame = next(self._container.decode(self._stream))
                self._frame_count += 1

                # Pace the output
                target_time = self._start_time + (
                    self._frame_count * AUDIO_PTIME
                )
                wait = target_time - time.time()
                if wait > 0:
                    import asyncio
                    await asyncio.sleep(wait)

                return frame
            except StopIteration:
                if self._loop:
                    self._container.close()
                    self._open()
                else:
                    self.stop()
                    raise
