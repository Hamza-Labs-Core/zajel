"""
Cross-platform channel E2E tests with headless client.

Tests the channel feature where Alice (Flutter app on any platform)
creates channels and interacts with HeadlessBob (Python headless client).

Channels use a broadcast model: the creator publishes content, and
subscribers receive it via VPS relay. The primary E2E value here is
testing the invite link crypto interop between Dart and Python
(Ed25519 signatures + ChaCha20 encryption key exchange).

Requires:
- One device/emulator running the Flutter app (alice fixture)
- HeadlessBob connected to the same signaling server
- TURN relay for WebRTC P2P connectivity
"""

import time

import pytest



@pytest.mark.headless
@pytest.mark.channels
@pytest.mark.single_device
class TestChannelsHeadlessE2E:
    """Channel E2E tests using the Flutter app + headless client."""

    def _pair_and_setup(self, alice, app_helper, headless_bob):
        """Pair Alice (app) with HeadlessBob and return to home."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Alice navigates to Connect screen to get her code
        helper.navigate_to_connect()
        alice_code = helper.get_pairing_code_from_connect_screen()

        # Bob pairs with Alice's code (tries all servers via MultiServerBob)
        headless_bob.pair_with(alice_code)

        # Poll until connected or timeout
        assert helper.wait_for_peer_connected(timeout=60), (
            "Pairing with headless client must succeed"
        )
        return helper

    @pytest.mark.slow
    def test_create_channel_and_verify_in_list(
        self, alice, app_helper, headless_bob
    ):
        """App creates a channel and it appears in the channels list."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_channels()
        helper.take_screenshot("channels_list_empty")

        helper.create_channel("Test Broadcast", "E2E test channel")
        helper.take_screenshot("channel_created")

        # Channel should be visible in the list
        helper._find("Test Broadcast")

    @pytest.mark.slow
    def test_create_channel_and_extract_invite_link(
        self, alice, app_helper, headless_bob
    ):
        """App creates channel, opens share dialog, extracts invite link."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_channels()

        helper.create_channel("Link Test", "Testing invite links")
        helper.open_channel("Link Test")
        helper.take_screenshot("channel_detail")

        link = helper.get_channel_invite_link()
        helper.take_screenshot("channel_share_dialog")

        assert link.startswith("zajel://channel/"), (
            f"Invite link should start with zajel://channel/, got: {link[:50]}"
        )
        # Link should contain a base64url-encoded payload
        assert len(link) > 50, (
            f"Invite link too short — missing payload? len={len(link)}"
        )

    @pytest.mark.slow
    def test_headless_subscribes_via_invite_link(
        self, alice, app_helper, headless_bob
    ):
        """App creates channel, HeadlessBob subscribes via extracted link.

        This tests the Dart <-> Python crypto interop: the invite link
        contains an Ed25519-signed manifest and a ChaCha20 encryption key,
        both encoded by Dart and decoded by Python.
        """
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_channels()

        helper.create_channel("Crypto Interop", "Testing link decode")
        helper.open_channel("Crypto Interop")

        link = helper.get_channel_invite_link()
        assert link.startswith("zajel://channel/"), (
            f"Expected zajel:// link, got: {link[:50]}"
        )

        # HeadlessBob decodes the link and subscribes
        channel = headless_bob.subscribe_channel(link)

        assert channel is not None, "subscribe_channel() returned None"
        assert channel.manifest.name == "Crypto Interop"
        assert channel.manifest.description == "Testing link decode"
        assert channel.encryption_key, "Encryption key should be non-empty"

        helper.take_screenshot("channel_subscribed_by_headless")

    @pytest.mark.slow
    def test_channel_publish_message_shows_in_app(
        self, alice, app_helper, headless_bob
    ):
        """App creates channel, publishes a message, verifies it in the UI."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_channels()

        helper.create_channel("Publish Test")
        helper.open_channel("Publish Test")

        helper.publish_channel_message("Hello from E2E!")
        time.sleep(3)

        assert helper.has_channel_message("Hello from E2E!"), (
            "Published message should be visible in the channel"
        )
        helper.take_screenshot("channel_message_published")

    @pytest.mark.slow
    def test_channel_publish_multiple_messages(
        self, alice, app_helper, headless_bob
    ):
        """App publishes multiple messages, all visible in channel."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_channels()

        helper.create_channel("Multi Message Test")
        helper.open_channel("Multi Message Test")

        messages = [
            "First broadcast message",
            "Second broadcast message",
            "Third broadcast message",
        ]

        for msg_text in messages:
            helper.publish_channel_message(msg_text)
            time.sleep(2)

        # All messages should be visible
        for msg_text in messages:
            assert helper.has_channel_message(msg_text), (
                f"Message '{msg_text}' should be visible"
            )

        helper.take_screenshot("channel_multiple_messages")

    @pytest.mark.slow
    def test_channel_info_sheet_shows_details(
        self, alice, app_helper, headless_bob
    ):
        """Channel info sheet shows name and description."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_channels()

        helper.create_channel("Info Test", "A test description")
        helper.open_channel("Info Test")

        helper._find("Channel info").click()
        time.sleep(2)

        helper._find("A test description")
        helper.take_screenshot("channel_info_sheet")

    @pytest.mark.slow
    def test_navigate_channels_and_back(
        self, alice, app_helper, headless_bob
    ):
        """Navigate to channels list, create a channel, go back to home."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)

        # Navigate to channels
        helper.navigate_to_channels()
        helper.take_screenshot("channels_list_view")

        # Create a channel
        helper.create_channel("Nav Test")
        helper.take_screenshot("channels_after_create")

        # Go back to home
        helper.go_back_to_home()
        time.sleep(1)
        helper.take_screenshot("home_after_channels")
