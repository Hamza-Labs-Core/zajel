"""Tests for DiagnosticsScrubber."""

from zajel.diagnostics.scrubber import DiagnosticsScrubber


scrub = DiagnosticsScrubber.scrub_message
scrub_trace = DiagnosticsScrubber.scrub_stack_trace


class TestEmailScrubbing:
    def test_simple_email(self):
        assert scrub("contact admin@example.com now") == "contact [EMAIL] now"

    def test_email_with_dots(self):
        assert "[EMAIL]" in scrub("john.doe@company.co.uk")

    def test_email_with_plus(self):
        assert "[EMAIL]" in scrub("user+tag@gmail.com")


class TestIPv4Scrubbing:
    def test_simple_ipv4(self):
        assert scrub("connect to 192.168.1.1:8080") == "connect to [IP]:8080"

    def test_loopback(self):
        assert scrub("listening on 127.0.0.1") == "listening on [IP]"

    def test_multiple_ips(self):
        result = scrub("from 10.0.0.1 to 10.0.0.2")
        assert result == "from [IP] to [IP]"


class TestIPv6Scrubbing:
    def test_loopback(self):
        assert scrub("bind to ::1") == "bind to [IP]"

    def test_full_ipv6(self):
        result = scrub("addr 2001:0db8:85a3:0000:0000:8a2e:0370:7334")
        assert "[IP]" in result

    def test_compressed_ipv6(self):
        result = scrub("host fe80::1")
        assert "[IP]" in result


class TestUUIDScrubbing:
    def test_standard_uuid(self):
        result = scrub("session 550e8400-e29b-41d4-a716-446655440000")
        assert result == "session [UUID]"

    def test_uppercase_uuid(self):
        result = scrub("id=ABCDEF01-2345-6789-ABCD-EF0123456789")
        assert "[UUID]" in result


class TestPairingCodeScrubbing:
    def test_code_colon(self):
        assert scrub("code:12345678") == "code:[REDACTED]"

    def test_code_equals(self):
        assert scrub("code=1234") == "code:[REDACTED]"

    def test_code_space(self):
        assert scrub("code 5678") == "code:[REDACTED]"

    def test_case_insensitive(self):
        assert scrub("Code:9999") == "code:[REDACTED]"


class TestPeerIDScrubbing:
    def test_peer_id_hex(self):
        result = scrub("peer_id:abcdef0123456789")
        assert result == "peer:[REDACTED]"

    def test_peer_code_hex(self):
        result = scrub("peer_code=deadbeef01234567")
        assert result == "peer:[REDACTED]"


class TestBase64KeyScrubbing:
    def test_long_base64(self):
        key = "A" * 44 + "=="
        result = scrub(f"key={key}")
        assert "[KEY]" in result

    def test_base64_with_slashes(self):
        key = "abc+def/ghi+jkl/mno+pqr/stu+vwx/yz01+234="
        result = scrub(f"pub: {key}")
        assert "[KEY]" in result


class TestHexKeyScrubbing:
    def test_64_char_hex(self):
        hex_key = "a" * 64
        result = scrub(f"key={hex_key}")
        assert "[KEY]" in result

    def test_128_char_hex(self):
        hex_key = "deadbeef" * 16
        result = scrub(f"secret: {hex_key}")
        assert "[KEY]" in result


class TestPathScrubbing:
    def test_home_path(self):
        result = scrub("file at /home/user/.config/zajel/db.sqlite")
        assert result == "file at [PATH]"

    def test_tmp_path(self):
        result = scrub("wrote to /tmp/zajel-test/output.json")
        assert result == "wrote to [PATH]"

    def test_data_path(self):
        result = scrub("stored in /data/app/com.zajel/files")
        assert result == "stored in [PATH]"

    def test_preserves_package_paths(self):
        # package:zajel/ style paths should NOT be scrubbed
        msg = "error in zajel/client.py:142"
        result = scrub(msg)
        assert "zajel/client.py:142" in result


class TestURLParamScrubbing:
    def test_https_params(self):
        result = scrub("GET https://api.example.com/v1?token=secret&user=1")
        assert result == "GET https://api.example.com/v1?[PARAMS_REDACTED]"

    def test_wss_params(self):
        result = scrub("ws wss://signal.zajel.dev/ws?code=1234")
        assert "[PARAMS_REDACTED]" in result
        assert "1234" not in result

    def test_url_without_params_unchanged(self):
        msg = "connecting to https://api.example.com/v1"
        assert scrub(msg) == msg


class TestMemoryAddressScrubbing:
    def test_python_object_address(self):
        result = scrub_trace("<CryptoService at 0x7f1234567890>")
        assert "0x" not in result
        assert "[ADDR]" in result

    def test_multiple_addresses(self):
        trace = "<Foo at 0xDEAD>\n<Bar at 0xBEEF>"
        result = scrub_trace(trace)
        assert "0x" not in result


class TestEmptyInput:
    def test_empty_string(self):
        assert scrub("") == ""

    def test_empty_trace(self):
        assert scrub_trace("") == ""


class TestMixedPII:
    def test_multiple_patterns(self):
        msg = "user admin@example.com from 192.168.1.1 session 550e8400-e29b-41d4-a716-446655440000"
        result = scrub(msg)
        assert "[EMAIL]" in result
        assert "[IP]" in result
        assert "[UUID]" in result
        assert "admin@" not in result
        assert "192.168" not in result
        assert "550e8400" not in result

    def test_realistic_error(self):
        msg = (
            "WebSocket connection to wss://signal.zajel.dev/ws?token=abc123 "
            "from peer_code=deadbeef01234567abcdef failed: "
            "certificate verify error for 10.0.2.2:8443"
        )
        result = scrub(msg)
        assert "abc123" not in result
        assert "deadbeef" not in result
        assert "10.0.2.2" not in result


class TestStackTraceScrubbing:
    def test_preserves_frame_numbers(self):
        trace = (
            'Traceback (most recent call last):\n'
            '  File "/home/user/zajel/client.py", line 142, in connect\n'
            '    raise ConnectionError("192.168.1.1 refused")\n'
            'ConnectionError: 192.168.1.1 refused'
        )
        result = scrub_trace(trace)
        assert "Traceback" in result
        assert "line 142" in result
        assert "192.168" not in result

    def test_scrubs_paths_in_trace(self):
        trace = 'File "/home/meywd/zajel/crypto.py", line 50'
        result = scrub_trace(trace)
        assert "/home/meywd" not in result


class TestIdempotency:
    def test_double_scrub_same_result(self):
        msg = "error from admin@test.com at 192.168.1.1 code:1234"
        once = scrub(msg)
        twice = scrub(once)
        assert once == twice

    def test_trace_double_scrub(self):
        trace = '<Foo at 0xDEAD> connected to 10.0.0.1'
        once = scrub_trace(trace)
        twice = scrub_trace(once)
        assert once == twice
