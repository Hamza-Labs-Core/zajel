"""
HTTP client for appium_flutter_server's embedded Shelf HTTP server.

The appium_flutter_server Dart package embeds a Shelf HTTP server inside the
Flutter app. It exposes W3C WebDriver-like REST endpoints that operate on
Flutter's widget tree via WidgetTester — completely bypassing platform
accessibility APIs (AT-SPI on Linux, UIA on Windows).

This client talks directly to that Shelf server over HTTP, making it
suitable for headless CI environments where accessibility services
don't work (e.g., Flutter on Xvfb).

Shelf server port range: 9000-9020 (tries first available).
Server binds on 0.0.0.0 by default.
"""

import base64
import json
import time
import urllib.request
import urllib.error


# W3C element key used in responses
W3C_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf"
JWP_ELEMENT_KEY = "ELEMENT"


class ShelfElement:
    """Represents a Flutter widget found via the Shelf server."""

    def __init__(self, element_id: str, client: "ShelfClient"):
        self.id = element_id
        self._client = client

    def click(self):
        self._client.click_element(self.id)

    def get_text(self) -> str:
        return self._client.get_element_text(self.id)

    def set_text(self, text: str):
        self._client.set_element_text(self.id, text)

    def clear(self):
        self._client.clear_element(self.id)

    @property
    def name(self) -> str:
        return self._client.get_element_name(self.id)


class ShelfClient:
    """HTTP client for the appium_flutter_server Shelf API.

    Usage:
        client = ShelfClient(port=9000)
        client.wait_for_server(timeout=30)
        client.create_session()

        el = client.find_element("text", "Channels")
        el.click()

        client.delete_session()
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 9000, timeout: float = 10):
        self.base_url = f"http://{host}:{port}"
        self.session_id = None
        self._timeout = timeout

    # ── Low-level HTTP ──────────────────────────────────────────

    def _request(self, method: str, path: str, body: dict = None) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"} if data else {},
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            response_body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Shelf server returned {e.code} for {method} {path}: {response_body}"
            ) from e

    def _post(self, path: str, body: dict = None) -> dict:
        return self._request("POST", path, body)

    def _get(self, path: str) -> dict:
        return self._request("GET", path)

    def _delete(self, path: str) -> dict:
        return self._request("DELETE", path)

    # ── Server lifecycle ────────────────────────────────────────

    def wait_for_server(self, timeout: int = 60):
        """Wait for the Shelf HTTP server to become reachable."""
        deadline = time.time() + timeout
        last_error = None
        while time.time() < deadline:
            try:
                resp = self._get("/status")
                if resp:
                    return
            except Exception as e:
                last_error = e
            time.sleep(0.5)
        raise TimeoutError(
            f"Shelf server not reachable at {self.base_url} within {timeout}s. "
            f"Last error: {last_error}"
        )

    # ── Session management ──────────────────────────────────────

    def create_session(self, capabilities: dict = None) -> str:
        caps = capabilities or {}
        resp = self._post("/session", {"capabilities": caps})
        self.session_id = resp.get("sessionId", "default")
        return self.session_id

    def delete_session(self):
        if self.session_id:
            try:
                self._delete(f"/session/{self.session_id}")
            except Exception:
                pass
            self.session_id = None

    # ── Element finding ─────────────────────────────────────────

    def find_element(self, strategy: str, selector, timeout: int = None) -> ShelfElement:
        """Find a single element.

        Args:
            strategy: One of "text", "text containing", "semantics label",
                      "tooltip", "key", "type", "ancestor", "descendant".
            selector: The value to match (string or dict for complex finders).
            timeout: Override default timeout for this find.
        """
        body = {"strategy": strategy, "selector": selector}
        old_timeout = self._timeout
        if timeout is not None:
            self._timeout = timeout
        try:
            resp = self._post(f"/session/{self.session_id}/element", body)
        finally:
            self._timeout = old_timeout

        value = resp.get("value", {})
        element_id = value.get(JWP_ELEMENT_KEY) or value.get(W3C_ELEMENT_KEY)
        if not element_id:
            raise RuntimeError(f"No element found for strategy={strategy}, selector={selector}")
        return ShelfElement(element_id, self)

    def find_elements(self, strategy: str, selector) -> list:
        """Find multiple elements."""
        body = {"strategy": strategy, "selector": selector}
        resp = self._post(f"/session/{self.session_id}/elements", body)
        value = resp.get("value", [])
        elements = []
        for item in value:
            eid = item.get(JWP_ELEMENT_KEY) or item.get(W3C_ELEMENT_KEY)
            if eid:
                elements.append(ShelfElement(eid, self))
        return elements

    def find_by_text(self, text: str, timeout: int = None) -> ShelfElement:
        return self.find_element("text", text, timeout=timeout)

    def find_by_text_containing(self, text: str, timeout: int = None) -> ShelfElement:
        return self.find_element("text containing", text, timeout=timeout)

    def find_by_tooltip(self, tooltip: str, timeout: int = None) -> ShelfElement:
        return self.find_element("tooltip", tooltip, timeout=timeout)

    def find_by_semantics_label(self, label: str, timeout: int = None) -> ShelfElement:
        return self.find_element("semantics label", label, timeout=timeout)

    def find_by_key(self, key: str, timeout: int = None) -> ShelfElement:
        return self.find_element("key", key, timeout=timeout)

    def find_by_type(self, widget_type: str, timeout: int = None) -> ShelfElement:
        return self.find_element("type", widget_type, timeout=timeout)

    # ── Element interaction ─────────────────────────────────────

    def click_element(self, element_id: str):
        self._post(f"/session/{self.session_id}/element/{element_id}/click")

    def get_element_text(self, element_id: str) -> str:
        resp = self._get(f"/session/{self.session_id}/element/{element_id}/text")
        return resp.get("value", "")

    def get_element_name(self, element_id: str) -> str:
        resp = self._get(f"/session/{self.session_id}/element/{element_id}/name")
        return resp.get("value", "")

    def set_element_text(self, element_id: str, text: str):
        chars = list(text)
        self._post(
            f"/session/{self.session_id}/element/{element_id}/value",
            {"text": text, "value": chars},
        )

    def clear_element(self, element_id: str):
        self._post(f"/session/{self.session_id}/element/{element_id}/clear")

    def get_element_attribute(self, element_id: str, attribute: str):
        resp = self._get(
            f"/session/{self.session_id}/element/{element_id}/attribute/{attribute}"
        )
        return resp.get("value")

    # ── Navigation ──────────────────────────────────────────────

    def press_back(self):
        self._post(f"/session/{self.session_id}/back")

    # ── Screenshot ──────────────────────────────────────────────

    def take_screenshot_base64(self) -> str:
        """Take a screenshot and return base64-encoded PNG data."""
        resp = self._get(f"/session/{self.session_id}/screenshot")
        return resp.get("value", "")

    def take_screenshot(self, file_path: str):
        """Take a screenshot and save to file."""
        b64_data = self.take_screenshot_base64()
        if b64_data:
            with open(file_path, "wb") as f:
                f.write(base64.b64decode(b64_data))

    # ── Wait helpers ────────────────────────────────────────────

    def wait_for_element_visible(self, strategy: str, selector: str, timeout: int = 20):
        """Wait for an element to become visible."""
        body = {"strategy": strategy, "selector": selector}
        old_timeout = self._timeout
        self._timeout = timeout + 5
        try:
            self._post(
                f"/session/{self.session_id}/element/wait/visible",
                body,
            )
        finally:
            self._timeout = old_timeout

    def wait_for_element_absent(self, strategy: str, selector: str, timeout: int = 20):
        """Wait for an element to disappear."""
        body = {"strategy": strategy, "selector": selector}
        old_timeout = self._timeout
        self._timeout = timeout + 5
        try:
            self._post(
                f"/session/{self.session_id}/element/wait/absent",
                body,
            )
        finally:
            self._timeout = old_timeout
