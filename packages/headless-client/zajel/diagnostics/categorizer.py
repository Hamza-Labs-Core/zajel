"""Error categorization by type, message, and traceback context."""

import traceback as tb_module
from types import TracebackType


class ErrorCategory:
    """Error category constants — no 'ui' since headless has no GUI."""

    CRASH = "crash"
    NETWORK = "network"
    CRYPTO = "crypto"
    STORAGE = "storage"
    PROTOCOL = "protocol"
    OTHER = "other"

    ALL = (CRASH, NETWORK, CRYPTO, STORAGE, PROTOCOL, OTHER)


# Exception types that map directly to categories
_TYPE_RULES: list[tuple[tuple[type, ...], str]] = [
    # Network
    (
        (ConnectionError, TimeoutError, ConnectionRefusedError,
         ConnectionResetError, ConnectionAbortedError, BrokenPipeError),
        ErrorCategory.NETWORK,
    ),
    # Storage
    (
        (FileNotFoundError, PermissionError, IsADirectoryError,
         FileExistsError),
        ErrorCategory.STORAGE,
    ),
]

# Exception type names (string match for third-party exceptions we can't import)
_TYPE_NAME_RULES: list[tuple[tuple[str, ...], str]] = [
    # Crash
    (("SystemExit", "KeyboardInterrupt", "MemoryError", "RecursionError"),
     ErrorCategory.CRASH),
    # Network
    (("WebSocketException", "WebSocketError", "InvalidHandshake",
      "ConnectionClosedError", "ConnectionClosedOK",
      "InvalidStatusCode", "InvalidURI", "gaierror"),
     ErrorCategory.NETWORK),
    # Crypto
    (("CryptoError", "InvalidTag", "InvalidSignature", "InvalidKey",
      "DeadDropDecryptionError"),
     ErrorCategory.CRYPTO),
    # Storage
    (("DatabaseError", "OperationalError", "IntegrityError",
      "sqlite3.Error"),
     ErrorCategory.STORAGE),
]

# Message keyword patterns (lowercase) → category
_MESSAGE_RULES: list[tuple[tuple[str, ...], str]] = [
    # Network
    (("connection refused", "connection timed out", "connection reset",
      "network is unreachable", "host not found", "name resolution",
      "websocket", "ssl handshake", "certificate verify"),
     ErrorCategory.NETWORK),
    # Crypto
    (("decrypt", "encrypt", "key exchange", "signature verification",
      "invalid key", "invalid tag", "invalid nonce", "chacha", "x25519"),
     ErrorCategory.CRYPTO),
    # Storage
    (("database is locked", "no such table", "disk i/o error",
      "shared_preferences", "no space left"),
     ErrorCategory.STORAGE),
    # Protocol
    (("protocol", "handshake failed", "pairing", "invalid message format",
      "malformed", "unexpected message type"),
     ErrorCategory.PROTOCOL),
]

# Traceback file path fragments → category
_PATH_RULES: list[tuple[tuple[str, ...], str]] = [
    # Network
    (("signaling.py", "webrtc.py", "relay"),
     ErrorCategory.NETWORK),
    # Crypto
    (("crypto.py", "ml_kem.py", "dead_drop.py"),
     ErrorCategory.CRYPTO),
    # Storage
    (("peer_storage.py", "storage"),
     ErrorCategory.STORAGE),
    # Protocol
    (("protocol.py",),
     ErrorCategory.PROTOCOL),
]


class ErrorCategorizer:
    """Categorize errors by type, message, and traceback context."""

    @staticmethod
    def categorize(
        error: BaseException,
        tb: TracebackType | None = None,
    ) -> str:
        """Return the error category string. First match wins."""
        # 1. Direct exception type check
        for types, category in _TYPE_RULES:
            if isinstance(error, types):
                return category

        # 2. Exception type name string match (third-party types)
        type_name = type(error).__name__
        # Also check MRO for parent class names
        mro_names = {cls.__name__ for cls in type(error).__mro__}
        for names, category in _TYPE_NAME_RULES:
            if type_name in names or mro_names & set(names):
                return category

        # 3. Message keyword matching (case-insensitive)
        msg = str(error).lower()
        for keywords, category in _MESSAGE_RULES:
            for kw in keywords:
                if kw in msg:
                    return category

        # 4. Traceback file path matching
        if tb is not None:
            frames = tb_module.extract_tb(tb)
            filenames = [f.filename for f in frames]
            for path_fragments, category in _PATH_RULES:
                for fname in filenames:
                    for fragment in path_fragments:
                        if fragment in fname:
                            return category

        return ErrorCategory.OTHER
