"""
Pytest fixtures for Windows desktop E2E tests.

Uses pywinauto (UIA backend) for Flutter app automation.
HeadlessBob fixture provides a headless peer for cross-platform pairing tests.
"""

import asyncio
import threading

import pytest

from windows_helper import WindowsAppHelper
from config import APP_PATH, SIGNALING_URL


@pytest.fixture(scope="function")
def alice():
    """Flutter Windows app instance (Alice)."""
    helper = WindowsAppHelper(APP_PATH)
    helper.launch()
    helper.wait_for_app_ready()

    yield helper

    helper.stop()


# ── Headless Client Fixtures ─────────────────────────────────────


class HeadlessBob:
    """Synchronous wrapper around ZajelHeadlessClient for pytest.

    Runs the async event loop in a background thread so that synchronous
    test code can call connect(), send_text(), etc. directly.
    """

    def __init__(self, signaling_url: str, **kwargs):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

        from zajel.client import ZajelHeadlessClient
        self._client = ZajelHeadlessClient(signaling_url=signaling_url, **kwargs)
        self.pairing_code = None
        self.connected_peer = None

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _run(self, coro, timeout=120):
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)

    def connect(self) -> str:
        self.pairing_code = self._run(self._client.connect())
        return self.pairing_code

    def pair_with(self, code: str):
        self.connected_peer = self._run(self._client.pair_with(code))
        return self.connected_peer

    def wait_for_pair(self, timeout=60):
        self.connected_peer = self._run(
            self._client.wait_for_pair(timeout=timeout), timeout=timeout + 10
        )
        return self.connected_peer

    def send_text(self, peer_id: str, text: str):
        self._run(self._client.send_text(peer_id, text))

    def receive_message(self, timeout=30):
        return self._run(
            self._client.receive_message(timeout=timeout), timeout=timeout + 10
        )

    def send_file(self, peer_id: str, file_path: str):
        return self._run(self._client.send_file(peer_id, file_path))

    def receive_file(self, timeout=60):
        return self._run(
            self._client.receive_file(timeout=timeout), timeout=timeout + 10
        )

    def disconnect(self):
        try:
            self._run(self._client.disconnect(), timeout=10)
        except Exception:
            pass
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)


@pytest.fixture(scope="function")
def headless_bob():
    """Headless client acting as Bob for cross-platform tests.

    Connects to the signaling server, auto-accepts pair requests.
    Tests use headless_bob.pairing_code to pair Alice (Windows app) with Bob.
    """
    if not SIGNALING_URL:
        pytest.skip("SIGNALING_URL not set — headless tests require a signaling server")

    bob = HeadlessBob(
        signaling_url=SIGNALING_URL,
        name="HeadlessBob",
        auto_accept_pairs=True,
        log_level="DEBUG",
    )
    bob.connect()
    yield bob
    bob.disconnect()
