"""
E2E tests for group functionality.

Tests group creation, navigation, and messaging from the UI.

App flow:
1. Home screen -> tap "Groups" icon button (tooltip) in app bar
2. Groups list screen shows "No groups yet" if empty
3. Tap "Create Group" FAB or empty-state button -> dialog with group name
4. After creation, group appears in list with member count
5. Tap group -> group detail screen with message list and compose bar
6. User can type in compose bar and tap "Send" to send a group message
"""

import time
import pytest


@pytest.mark.groups
class TestGroups:
    """Test suite for group creation and messaging."""

    @pytest.mark.single_device
    def test_navigate_to_groups_screen(self, alice, app_helper):
        """Test navigating from home to the Groups list screen."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Tap the Groups icon button in the home app bar
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        # Verify we are on the Groups list screen by checking the title
        helper._find("Groups", timeout=10)

    @pytest.mark.single_device
    def test_groups_empty_state(self, alice, app_helper):
        """Test that empty groups list shows appropriate message."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        # Verify empty state message
        helper._find("No groups yet", timeout=10)

    @pytest.mark.single_device
    def test_create_group_via_fab(self, alice, app_helper):
        """Test creating a group using the floating action button."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        # Tap the Create Group FAB (tooltip: 'Create Group')
        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        # The Create Group dialog should appear
        helper._find("Create Group", timeout=5)

        # Fill in the group name
        _type_in_field(helper, "Test Group Alpha")

        # Tap the Create button in the dialog
        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Verify the group appears in the list
        helper._find("Test Group Alpha", timeout=10)

    @pytest.mark.single_device
    def test_create_group_via_empty_state_button(self, alice, app_helper):
        """Test creating a group from the empty state button."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        # Verify empty state and tap the Create Group button
        helper._find("No groups yet", timeout=10)
        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        # Fill in group name
        _type_in_field(helper, "Empty State Group")

        # Tap Create
        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Verify the group appears in the list
        helper._find("Empty State Group", timeout=10)

    @pytest.mark.single_device
    def test_create_group_cancel(self, alice, app_helper):
        """Test that canceling group creation does not add a group."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        # Open create dialog
        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        # Type a name
        _type_in_field(helper, "Should Not Exist")

        # Cancel the dialog
        helper._find("Cancel", timeout=5, partial=False).click()
        time.sleep(2)

        # The group should NOT appear -- the empty state should still be visible
        helper._find("No groups yet", timeout=5)

    @pytest.mark.single_device
    def test_group_list_shows_member_count(self, alice, app_helper):
        """Test that group list shows member count."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups and create one
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, "Member Count Group")

        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # The group should show member count (at least 1 member = self)
        helper._find("member", timeout=10)

    @pytest.mark.single_device
    def test_open_group_detail(self, alice, app_helper):
        """Test opening a group detail screen after creating a group."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups and create one
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, "Detail Test Group")

        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Tap the group in the list to open detail
        helper._find("Detail Test Group", timeout=10).click()
        time.sleep(2)

        # Verify we are on the detail screen -- group name in app bar
        helper._find("Detail Test Group", timeout=10)

    @pytest.mark.single_device
    def test_group_detail_empty_messages(self, alice, app_helper):
        """Test that new group detail screen shows empty message state."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups and create one
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, "Empty Msgs Group")

        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Open the group
        helper._find("Empty Msgs Group", timeout=10).click()
        time.sleep(2)

        # Verify the empty message state
        helper._find("No messages yet", timeout=10)

    @pytest.mark.single_device
    def test_group_detail_has_compose_bar(self, alice, app_helper):
        """Test that group detail screen shows compose bar."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups and create one
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, "Compose Bar Group")

        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Open the group
        helper._find("Compose Bar Group", timeout=10).click()
        time.sleep(2)

        # The Send button should be visible (tooltip: 'Send')
        helper._find("Send", timeout=10)

    @pytest.mark.single_device
    def test_send_message_in_group(self, alice, app_helper):
        """Test sending a text message in a group."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups and create one
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, "Messaging Group")

        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Open the group
        helper._find("Messaging Group", timeout=10).click()
        time.sleep(2)

        # Type a message in the compose bar
        _type_in_compose_bar(helper, "Hello group members!")

        # Tap the Send button
        helper._find("Send", timeout=10).click()
        time.sleep(3)

        # Verify the sent message appears in the message list
        helper._find("Hello group members!", timeout=10)

    @pytest.mark.single_device
    def test_group_detail_shows_add_member_button(self, alice, app_helper):
        """Test that group detail shows add member button."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups and create one
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, "Add Member Group")

        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Open the group
        helper._find("Add Member Group", timeout=10).click()
        time.sleep(2)

        # Add member button should be visible (tooltip: 'Add member')
        helper._find("Add member", timeout=10)

    @pytest.mark.single_device
    def test_group_detail_shows_members_button(self, alice, app_helper):
        """Test that group detail shows members count button."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups and create one
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, "Members Button Group")

        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Open the group
        helper._find("Members Button Group", timeout=10).click()
        time.sleep(2)

        # Members button tooltip contains the count, e.g. "1 members"
        helper._find("members", timeout=10)

    @pytest.mark.single_device
    def test_group_members_sheet(self, alice, app_helper):
        """Test opening the group members bottom sheet."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups and create one
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, "Members Sheet Group")

        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Open the group
        helper._find("Members Sheet Group", timeout=10).click()
        time.sleep(2)

        # Tap the members button to open the sheet
        helper._find("members", timeout=10).click()
        time.sleep(2)

        # The members sheet should show "Members (N)"
        helper._find("Members", timeout=10)

    @pytest.mark.single_device
    def test_navigate_back_from_group_detail(self, alice, app_helper):
        """Test navigating back from group detail to group list."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups and create one
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, "Nav Back Group")

        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Open the group
        helper._find("Nav Back Group", timeout=10).click()
        time.sleep(2)

        # Verify we are on the detail screen
        helper._find("Nav Back Group", timeout=10)

        # Press back
        helper.driver.back()
        time.sleep(2)

        # We should be back on the groups list
        helper._find("Groups", timeout=10)

    @pytest.mark.single_device
    def test_send_multiple_messages_in_group(self, alice, app_helper):
        """Test sending multiple messages in a group."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Groups and create one
        helper._find("Groups", timeout=10).click()
        time.sleep(2)

        helper._find("Create Group", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, "Multi Msg Group")

        helper._find("Create", timeout=5, partial=False).click()
        time.sleep(3)

        # Open the group
        helper._find("Multi Msg Group", timeout=10).click()
        time.sleep(2)

        # Send first message
        _type_in_compose_bar(helper, "First message")
        helper._find("Send", timeout=10).click()
        time.sleep(3)

        # Send second message
        _type_in_compose_bar(helper, "Second message")
        helper._find("Send", timeout=10).click()
        time.sleep(3)

        # Both messages should be visible
        helper._find("First message", timeout=10)
        helper._find("Second message", timeout=10)


# ── Helpers ──────────────────────────────────────────────────────


def _type_in_field(helper, text):
    """Type text into the single EditText field in a dialog.

    The Create Group dialog has only one TextField (group name).
    Flutter renders it as android.widget.EditText in UiAutomator2.
    """
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.common.by import By

    input_field = WebDriverWait(helper.driver, 10).until(
        EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
    )
    input_field.click()
    time.sleep(0.5)
    helper.driver.execute_script('mobile: type', {'text': text})
    time.sleep(0.5)


def _type_in_compose_bar(helper, text):
    """Type text into the compose bar on the group detail screen.

    The compose bar has a TextField with hint 'Type a message...'
    rendered as android.widget.EditText in UiAutomator2.
    """
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.common.by import By

    input_field = WebDriverWait(helper.driver, 10).until(
        EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
    )
    input_field.click()
    time.sleep(0.5)
    helper.driver.execute_script('mobile: type', {'text': text})
    time.sleep(0.5)
