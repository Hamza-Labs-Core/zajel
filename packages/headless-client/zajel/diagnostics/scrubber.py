"""PII scrubber for diagnostic messages and stack traces."""

import re

# Compiled regex patterns in scrubbing order (most specific first)

# URLs with query params/fragments → redact params only
_URL_PARAMS = re.compile(
    r"((?:https?:|wss?:)//[^\s?#]+)[?#][^\s]*"
)

# Email addresses
_EMAIL = re.compile(
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
)

# IPv4
_IPV4 = re.compile(
    r"\b(?:\d{1,3}\.){3}\d{1,3}\b"
)

# IPv6 (three forms: :: prefix, mid/end ::, full)
_IPV6 = re.compile(
    r"(?:::(?:ffff:)?(?:\d{1,3}\.){3}\d{1,3}\b"  # ::ffff:192.0.2.1
    r"|::(?:[0-9a-fA-F]{1,4}:)*[0-9a-fA-F]{1,4}\b"  # ::1, ::dead:beef
    r"|\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?"  # fe80::1
    r"|\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b"  # full form
    r")"
)

# UUIDs (must be before hex keys)
_UUID = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
    r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)

# Pairing codes (code:1234, code = 12345678)
_PAIRING_CODE = re.compile(
    r"\bcode[:\s=]+\d{4,8}\b", re.IGNORECASE
)

# Peer IDs (peer_id:abc123..., peer_code = deadbeef...)
_PEER_ID = re.compile(
    r"\bpeer(?:[_a-zA-Z]*)[_\s:=]+[0-9a-fA-F]{16,63}\b", re.IGNORECASE
)

# Base64 keys (40+ chars of base64 alphabet)
_BASE64_KEY = re.compile(
    r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])"
)

# Hex keys (64+ hex chars — after UUID scrubbing)
_HEX_KEY = re.compile(
    r"\b[0-9a-fA-F]{64,}\b"
)

# Absolute file paths
_FILE_PATH = re.compile(
    r"(?<![A-Za-z0-9_.])"
    r"/(?:data|Users|home|tmp|var|private|storage)"
    r"/[^\s:,)]*"
)

# Python memory addresses: <object at 0x7f12345678>
_MEMORY_ADDR = re.compile(
    r"\bat\s+0x[0-9a-fA-F]+\b"
)

# Message scrubbing pipeline (order matters)
_MESSAGE_RULES: list[tuple[re.Pattern, str]] = [
    (_URL_PARAMS, r"\1?[PARAMS_REDACTED]"),
    (_EMAIL, "[EMAIL]"),
    (_IPV4, "[IP]"),
    (_IPV6, "[IP]"),
    (_UUID, "[UUID]"),
    (_PAIRING_CODE, "code:[REDACTED]"),
    (_PEER_ID, "peer:[REDACTED]"),
    (_BASE64_KEY, "[KEY]"),
    (_HEX_KEY, "[KEY]"),
    (_FILE_PATH, "[PATH]"),
]


class DiagnosticsScrubber:
    """Scrub PII from diagnostic messages and stack traces."""

    @staticmethod
    def scrub_message(msg: str) -> str:
        """Apply all PII scrubbing rules to a message string."""
        if not msg:
            return msg
        for pattern, replacement in _MESSAGE_RULES:
            msg = pattern.sub(replacement, msg)
        return msg

    @staticmethod
    def scrub_stack_trace(trace: str) -> str:
        """Scrub PII from a stack trace string.

        Additionally removes Python memory addresses (0x...) that appear
        in object repr strings.
        """
        if not trace:
            return trace

        lines = trace.split("\n")
        scrubbed: list[str] = []
        for line in lines:
            # Remove memory addresses first
            line = _MEMORY_ADDR.sub("at [ADDR]", line)
            # Then apply standard message scrubbing
            line = DiagnosticsScrubber.scrub_message(line)
            scrubbed.append(line)
        return "\n".join(scrubbed)
