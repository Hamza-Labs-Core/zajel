"""
Cross-platform group E2E tests with headless client.

Tests the group feature where Alice (Flutter app on any platform)
creates groups, invites HeadlessBob (Python headless client), and
exchanges messages bidirectionally.

Groups use full-mesh P2P with sender-key encryption (ChaCha20-Poly1305).
Each member has a unique sender key; messages are encrypted once and
broadcast to all peers. Group invitations travel over the existing 1:1
P2P data channel using the `ginv:` prefix protocol.

Requires:
- One device/emulator running the Flutter app (alice fixture)
- HeadlessBob connected to the same signaling server
- TURN relay for WebRTC P2P connectivity
"""

import time

import pytest



@pytest.mark.headless
@pytest.mark.groups
@pytest.mark.single_device
class TestGroupsHeadlessE2E:
    """Group E2E tests using the Flutter app + headless client."""

    def _pair_and_setup(self, alice, app_helper, headless_bob):
        """Pair Alice (app) with HeadlessBob and return to home."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Alice navigates to Connect screen and pairs with HeadlessBob
        helper.navigate_to_connect()
        helper.get_pairing_code_from_connect_screen()
        helper.enter_peer_code(headless_bob.pairing_code)

        # Poll until connected or timeout
        assert helper.wait_for_peer_connected(timeout=60), (
            "Pairing with headless client must succeed"
        )
        return helper

    @pytest.mark.slow
    def test_create_group_shows_in_list(
        self, alice, app_helper, headless_bob
    ):
        """App creates a group and it appears in the groups list."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_groups()
        helper.take_screenshot("groups_list_empty")

        helper.create_group("E2E Family Chat")
        time.sleep(2)
        helper.take_screenshot("group_created")

        # Group should be visible in the list
        helper._find("E2E Family Chat")
        helper._find("1 members")

    @pytest.mark.slow
    def test_create_multiple_groups(
        self, alice, app_helper, headless_bob
    ):
        """App creates multiple groups, all visible in the list."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_groups()

        groups = ["Work Chat", "Friends", "Gaming"]
        for name in groups:
            helper.create_group(name)
            time.sleep(1)

        # All groups should be visible
        for name in groups:
            helper._find(name)

        helper.take_screenshot("groups_multiple_created")

    @pytest.mark.slow
    def test_invite_headless_bob_to_group(
        self, alice, app_helper, headless_bob
    ):
        """App creates group, invites HeadlessBob, Bob auto-accepts.

        This tests the full ginv: protocol flow:
        1. App creates group with sender key
        2. App generates a sender key for the invitee
        3. App sends ginv: message over the 1:1 data channel
        4. HeadlessBob parses the invitation, imports sender keys,
           and creates the group locally
        """
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_groups()

        helper.create_group("Invite Test Group")
        helper.open_group("Invite Test Group")
        helper.take_screenshot("group_detail_before_invite")

        # Add HeadlessBob as member
        helper.add_group_member("HeadlessBob")
        time.sleep(5)
        helper.take_screenshot("group_member_invited")

        # HeadlessBob should auto-accept the ginv: invitation
        group = headless_bob.wait_for_group_invitation(timeout=15)

        assert group is not None, "HeadlessBob should receive the invitation"
        assert group.name == "Invite Test Group"
        assert group.member_count >= 2

    @pytest.mark.slow
    def test_app_sends_message_headless_receives(
        self, alice, app_helper, headless_bob
    ):
        """App sends group message, HeadlessBob receives and decrypts.

        This validates the full sender-key encryption chain:
        Alice encrypts with her sender key → broadcast over P2P →
        HeadlessBob decrypts using Alice's sender key (imported via ginv:).
        """
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_groups()

        helper.create_group("Message Send Group")
        helper.open_group("Message Send Group")

        # Invite HeadlessBob and wait for acceptance
        helper.add_group_member("HeadlessBob")
        time.sleep(5)
        headless_bob.wait_for_group_invitation(timeout=15)

        # App sends a group message
        helper.send_group_message("Hello from Alice!")
        time.sleep(3)
        helper.take_screenshot("group_message_sent")

        # HeadlessBob receives the encrypted message
        msg = headless_bob.wait_for_group_message(timeout=15)

        assert msg is not None, "HeadlessBob should receive the message"
        assert msg.content == "Hello from Alice!"

    @pytest.mark.slow
    def test_headless_sends_message_app_receives(
        self, alice, app_helper, headless_bob
    ):
        """HeadlessBob sends group message, app shows it in the UI.

        Tests the reverse direction: HeadlessBob encrypts with its
        sender key → broadcast over P2P → App decrypts and renders.
        """
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_groups()

        helper.create_group("Message Recv Group")
        helper.open_group("Message Recv Group")

        # Invite HeadlessBob and wait for acceptance
        helper.add_group_member("HeadlessBob")
        time.sleep(5)
        group = headless_bob.wait_for_group_invitation(timeout=15)

        # HeadlessBob sends a message
        headless_bob.send_group_message(group.id, "Hello from HeadlessBob!")
        time.sleep(5)

        # App should show HeadlessBob's message
        assert helper.has_group_message("Hello from HeadlessBob!"), (
            "App should display message from HeadlessBob"
        )
        helper.take_screenshot("group_message_received_from_headless")

    @pytest.mark.slow
    def test_bidirectional_group_messaging(
        self, alice, app_helper, headless_bob
    ):
        """Full bidirectional: Alice and Bob exchange group messages.

        Validates that both parties can encrypt and decrypt with each
        other's sender keys after the ginv: invitation exchange.
        """
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_groups()

        helper.create_group("Bidir Group")
        helper.open_group("Bidir Group")

        # Invite HeadlessBob and wait for acceptance
        helper.add_group_member("HeadlessBob")
        time.sleep(5)
        group = headless_bob.wait_for_group_invitation(timeout=15)

        # Round 1: Alice → Bob
        helper.send_group_message("Message 1 from Alice")
        time.sleep(3)
        msg1 = headless_bob.wait_for_group_message(timeout=15)
        assert msg1.content == "Message 1 from Alice"

        # Round 2: Bob → Alice
        headless_bob.send_group_message(group.id, "Reply 1 from Bob")
        time.sleep(5)
        assert helper.has_group_message("Reply 1 from Bob"), (
            "App should show Bob's reply"
        )

        # Round 3: Alice → Bob
        helper.send_group_message("Message 2 from Alice")
        time.sleep(3)
        msg2 = headless_bob.wait_for_group_message(timeout=15)
        assert msg2.content == "Message 2 from Alice"

        helper.take_screenshot("group_bidirectional_complete")

    @pytest.mark.slow
    def test_group_members_sheet_shows_headless(
        self, alice, app_helper, headless_bob
    ):
        """After inviting HeadlessBob, members sheet shows both members."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_groups()

        helper.create_group("Members Test")
        helper.open_group("Members Test")

        # Invite HeadlessBob
        helper.add_group_member("HeadlessBob")
        time.sleep(5)
        headless_bob.wait_for_group_invitation(timeout=15)

        # Open members sheet
        helper.open_members_sheet()
        time.sleep(2)
        helper.take_screenshot("group_members_with_headless")

        # Verify member is visible (app shows "Peer <code>" or display name)
        helper._find("Peer", partial=True)

    @pytest.mark.slow
    def test_group_detail_shows_member_count(
        self, alice, app_helper, headless_bob
    ):
        """Group detail shows updated member count after invite."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)
        helper.navigate_to_groups()

        helper.create_group("Count Test Group")
        helper.open_group("Count Test Group")

        # Initially 1 member
        helper._find("1 members")
        helper.take_screenshot("group_one_member")

        # Invite HeadlessBob
        helper.add_group_member("HeadlessBob")
        time.sleep(5)
        headless_bob.wait_for_group_invitation(timeout=15)

        # Should now show 2 members
        time.sleep(2)
        helper._find("2 members")
        helper.take_screenshot("group_two_members")

    @pytest.mark.slow
    def test_navigate_groups_and_back(
        self, alice, app_helper, headless_bob
    ):
        """Navigate to groups list, create a group, go back to home."""
        helper = self._pair_and_setup(alice, app_helper, headless_bob)

        # Navigate to groups
        helper.navigate_to_groups()
        helper.take_screenshot("groups_list_view")

        # Create a group
        helper.create_group("Nav Test Group")
        helper.take_screenshot("groups_after_create")

        # Go back to home
        helper.go_back_to_home()
        time.sleep(1)
        helper.take_screenshot("home_after_groups")
