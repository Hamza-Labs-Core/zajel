"""Tests for ErrorCategorizer."""

import sys
import traceback

from zajel.diagnostics.categorizer import ErrorCategorizer, ErrorCategory


class TestCategoryConstants:
    def test_all_categories_present(self):
        assert "crash" in ErrorCategory.ALL
        assert "network" in ErrorCategory.ALL
        assert "crypto" in ErrorCategory.ALL
        assert "storage" in ErrorCategory.ALL
        assert "protocol" in ErrorCategory.ALL
        assert "other" in ErrorCategory.ALL

    def test_no_ui_category(self):
        assert "ui" not in ErrorCategory.ALL


class TestTypeBasedCategorization:
    def test_connection_error_is_network(self):
        assert ErrorCategorizer.categorize(ConnectionError("fail")) == "network"

    def test_timeout_error_is_network(self):
        assert ErrorCategorizer.categorize(TimeoutError("timed out")) == "network"

    def test_connection_refused_is_network(self):
        assert ErrorCategorizer.categorize(ConnectionRefusedError()) == "network"

    def test_connection_reset_is_network(self):
        assert ErrorCategorizer.categorize(ConnectionResetError()) == "network"

    def test_broken_pipe_is_network(self):
        assert ErrorCategorizer.categorize(BrokenPipeError()) == "network"

    def test_file_not_found_is_storage(self):
        assert ErrorCategorizer.categorize(FileNotFoundError("db.sqlite")) == "storage"

    def test_permission_error_is_storage(self):
        assert ErrorCategorizer.categorize(PermissionError("read-only")) == "storage"


class TestTypeNameCategorization:
    def _make_typed_error(self, name: str, msg: str = "test"):
        """Create an exception with a custom type name."""
        cls = type(name, (Exception,), {})
        return cls(msg)

    def test_system_exit_is_crash(self):
        assert ErrorCategorizer.categorize(SystemExit(1)) == "crash"

    def test_keyboard_interrupt_is_crash(self):
        assert ErrorCategorizer.categorize(KeyboardInterrupt()) == "crash"

    def test_memory_error_is_crash(self):
        assert ErrorCategorizer.categorize(MemoryError()) == "crash"

    def test_websocket_exception_is_network(self):
        err = self._make_typed_error("WebSocketException")
        assert ErrorCategorizer.categorize(err) == "network"

    def test_invalid_handshake_is_network(self):
        err = self._make_typed_error("InvalidHandshake")
        assert ErrorCategorizer.categorize(err) == "network"

    def test_connection_closed_error_is_network(self):
        err = self._make_typed_error("ConnectionClosedError")
        assert ErrorCategorizer.categorize(err) == "network"

    def test_crypto_error_is_crypto(self):
        err = self._make_typed_error("CryptoError")
        assert ErrorCategorizer.categorize(err) == "crypto"

    def test_invalid_tag_is_crypto(self):
        err = self._make_typed_error("InvalidTag")
        assert ErrorCategorizer.categorize(err) == "crypto"

    def test_dead_drop_decryption_error_is_crypto(self):
        err = self._make_typed_error("DeadDropDecryptionError")
        assert ErrorCategorizer.categorize(err) == "crypto"

    def test_database_error_is_storage(self):
        err = self._make_typed_error("DatabaseError")
        assert ErrorCategorizer.categorize(err) == "storage"

    def test_operational_error_is_storage(self):
        err = self._make_typed_error("OperationalError")
        assert ErrorCategorizer.categorize(err) == "storage"


class TestMessageCategorization:
    def test_connection_refused_message_is_network(self):
        assert ErrorCategorizer.categorize(Exception("connection refused")) == "network"

    def test_websocket_message_is_network(self):
        assert ErrorCategorizer.categorize(Exception("WebSocket closed")) == "network"

    def test_decrypt_message_is_crypto(self):
        assert ErrorCategorizer.categorize(Exception("failed to decrypt payload")) == "crypto"

    def test_key_exchange_message_is_crypto(self):
        assert ErrorCategorizer.categorize(Exception("key exchange failed")) == "crypto"

    def test_database_locked_is_storage(self):
        assert ErrorCategorizer.categorize(Exception("database is locked")) == "storage"

    def test_protocol_message_is_protocol(self):
        assert ErrorCategorizer.categorize(Exception("protocol error")) == "protocol"

    def test_handshake_failed_is_protocol(self):
        assert ErrorCategorizer.categorize(Exception("handshake failed")) == "protocol"

    def test_pairing_message_is_protocol(self):
        assert ErrorCategorizer.categorize(Exception("pairing timeout")) == "protocol"

    def test_case_insensitive_matching(self):
        assert ErrorCategorizer.categorize(Exception("CONNECTION REFUSED")) == "network"
        assert ErrorCategorizer.categorize(Exception("Decrypt Error")) == "crypto"

    def test_unknown_message_is_other(self):
        assert ErrorCategorizer.categorize(Exception("something weird")) == "other"


class TestTracebackCategorization:
    def _get_tb_from_file(self, filename: str):
        """Create a fake traceback pointing to the given filename."""
        # We create a real traceback by raising and catching
        try:
            raise ValueError("test")
        except ValueError:
            tb = sys.exc_info()[2]
        # We can't easily fake filenames in real tracebacks, so we use
        # the message fallback path for traceback testing by verifying
        # the extract_tb path works on real tracebacks
        return tb

    def test_signaling_path_is_network(self):
        """Verify path-based categorization with a real-ish traceback."""
        # Use exec to get a traceback with a controllable code object
        code = compile("raise ValueError('x')", "zajel/signaling.py", "exec")
        try:
            exec(code)
        except ValueError:
            tb = sys.exc_info()[2]
        assert ErrorCategorizer.categorize(ValueError("x"), tb) == "network"

    def test_crypto_path_is_crypto(self):
        code = compile("raise ValueError('x')", "zajel/crypto.py", "exec")
        try:
            exec(code)
        except ValueError:
            tb = sys.exc_info()[2]
        assert ErrorCategorizer.categorize(ValueError("x"), tb) == "crypto"

    def test_peer_storage_path_is_storage(self):
        code = compile("raise ValueError('x')", "zajel/peer_storage.py", "exec")
        try:
            exec(code)
        except ValueError:
            tb = sys.exc_info()[2]
        assert ErrorCategorizer.categorize(ValueError("x"), tb) == "storage"

    def test_protocol_path_is_protocol(self):
        code = compile("raise ValueError('x')", "zajel/protocol.py", "exec")
        try:
            exec(code)
        except ValueError:
            tb = sys.exc_info()[2]
        assert ErrorCategorizer.categorize(ValueError("x"), tb) == "protocol"


class TestDeterminism:
    def test_same_error_same_category(self):
        """Categorization is deterministic — same input, same output."""
        err = ConnectionError("connection refused")
        results = [ErrorCategorizer.categorize(err) for _ in range(100)]
        assert all(r == "network" for r in results)

    def test_type_takes_priority_over_message(self):
        """Type-based rules have higher priority than message-based."""
        # FileNotFoundError message mentions "protocol" but type wins
        err = FileNotFoundError("protocol file not found")
        assert ErrorCategorizer.categorize(err) == "storage"
