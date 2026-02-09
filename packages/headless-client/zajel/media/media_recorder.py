"""Records incoming audio/video to files for verification."""

import asyncio
import logging
from pathlib import Path
from typing import Optional

import av
from aiortc import MediaStreamTrack

logger = logging.getLogger("zajel.media.recorder")


class MediaRecorder:
    """Records audio and/or video tracks to a file."""

    def __init__(self, output_path: str):
        self._output_path = output_path
        self._container: Optional[av.OutputContainer] = None
        self._audio_stream = None
        self._video_stream = None
        self._tasks: list[asyncio.Task] = []
        self._recording = False

    async def add_track(self, track: MediaStreamTrack) -> None:
        """Add a track to record."""
        if self._container is None:
            self._container = av.open(self._output_path, mode="w")

        if track.kind == "audio":
            self._audio_stream = self._container.add_stream("pcm_s16le", rate=48000)
            task = asyncio.create_task(self._record_track(track, self._audio_stream))
        elif track.kind == "video":
            self._video_stream = self._container.add_stream("libx264", rate=30)
            self._video_stream.width = 640
            self._video_stream.height = 480
            task = asyncio.create_task(self._record_track(track, self._video_stream))
        else:
            return

        self._tasks.append(task)

    async def start(self) -> None:
        """Start recording."""
        self._recording = True

    async def stop(self) -> None:
        """Stop recording and close the output file."""
        self._recording = False
        for task in self._tasks:
            task.cancel()
        self._tasks.clear()

        if self._container:
            self._container.close()
            self._container = None

        logger.info("Recording saved to %s", self._output_path)

    async def record_duration(self, duration: float) -> str:
        """Record for a specific duration, then stop.

        Returns the output file path.
        """
        await self.start()
        await asyncio.sleep(duration)
        await self.stop()
        return self._output_path

    async def _record_track(self, track: MediaStreamTrack, stream) -> None:
        """Record frames from a track."""
        try:
            while self._recording:
                frame = await track.recv()
                for packet in stream.encode(frame):
                    self._container.mux(packet)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error("Recording error: %s", e)
