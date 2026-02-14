"""
E2E tests for channel functionality.

Tests channel creation, navigation, and publishing from the UI.

App flow:
1. Home screen -> tap "Channels" icon button (tooltip) in app bar
2. Channels list screen shows "No channels yet" if empty
3. Tap "Create Channel" FAB or empty-state button -> dialog with name + description
4. After creation, channel appears in list
5. Tap channel -> channel detail screen with compose bar (for owner)
6. Owner can type in compose bar and tap "Publish" to publish text content
"""

import time
import pytest


@pytest.mark.channels
class TestChannels:
    """Test suite for channel creation and management."""

    @pytest.mark.single_device
    def test_navigate_to_channels_screen(self, alice, app_helper):
        """Test navigating from home to the Channels list screen."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Tap the Channels icon button in the home app bar
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        # Verify we are on the Channels list screen by checking the title
        helper._find("Channels", timeout=10)

    @pytest.mark.single_device
    def test_channels_empty_state(self, alice, app_helper):
        """Test that empty channels list shows appropriate message."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        # Verify empty state message
        helper._find("No channels yet", timeout=10)

    @pytest.mark.single_device
    def test_create_channel_via_fab(self, alice, app_helper):
        """Test creating a channel using the floating action button."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        # Tap the Create Channel FAB (tooltip: 'Create Channel')
        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        # The Create Channel dialog should appear
        helper._find("Create Channel", timeout=5)

        # Find the text fields in the dialog
        _type_in_field(helper, 0, "Test Channel Alpha")
        _type_in_field(helper, 1, "A channel for testing", hide_keyboard=True)

        # Tap the Create button in the dialog
        helper._find("Create", timeout=10, partial=False).click()
        time.sleep(3)

        # Verify the channel appears in the list
        helper._find("Test Channel Alpha", timeout=10)

    @pytest.mark.single_device
    def test_create_channel_via_empty_state_button(self, alice, app_helper):
        """Test creating a channel from the empty state button."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        # Verify empty state and tap the Create Channel button within it
        helper._find("No channels yet", timeout=10)
        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        # Fill in channel name
        _type_in_field(helper, 0, "Empty State Channel", hide_keyboard=True)

        # Tap Create
        helper._find("Create", timeout=10, partial=False).click()
        time.sleep(3)

        # Verify the channel appears in the list
        helper._find("Empty State Channel", timeout=10)

    @pytest.mark.single_device
    def test_create_channel_cancel(self, alice, app_helper):
        """Test that canceling channel creation does not add a channel."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        # Open create dialog
        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        # Type a name
        _type_in_field(helper, 0, "Should Not Exist", hide_keyboard=True)

        # Cancel the dialog
        helper._find("Cancel", timeout=5, partial=False).click()
        time.sleep(2)

        # The channel should NOT appear -- the empty state should still be visible
        helper._find("No channels yet", timeout=5)

    @pytest.mark.single_device
    def test_open_channel_detail(self, alice, app_helper):
        """Test opening a channel detail screen after creating a channel."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels and create one
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, 0, "Detail Test Channel")
        _type_in_field(helper, 1, "Channel description here", hide_keyboard=True)

        helper._find("Create", timeout=10, partial=False).click()
        time.sleep(3)

        # Tap the channel in the list to open detail
        helper._find("Detail Test Channel", timeout=10).click()
        time.sleep(2)

        # Verify we are on the detail screen - channel name should be in app bar
        helper._find("Detail Test Channel", timeout=10)

        # Verify the description is visible
        helper._find("Channel description here", timeout=10)

        # Verify the OWNER role chip is visible
        helper._find("OWNER", timeout=10)

    @pytest.mark.single_device
    def test_channel_detail_has_compose_bar(self, alice, app_helper):
        """Test that channel detail screen shows compose bar for owner."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels and create one
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, 0, "Compose Bar Channel", hide_keyboard=True)

        helper._find("Create", timeout=10, partial=False).click()
        time.sleep(3)

        # Open the channel
        helper._find("Compose Bar Channel", timeout=10).click()
        time.sleep(2)

        # The Publish button should be visible (exact match to avoid "Publish content..." text)
        helper._find("Publish", timeout=10, partial=False)

    @pytest.mark.single_device
    def test_publish_message_to_channel(self, alice, app_helper):
        """Test publishing a text message to a channel as owner."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels and create one
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, 0, "Publish Test Channel", hide_keyboard=True)

        helper._find("Create", timeout=10, partial=False).click()
        time.sleep(3)

        # Open the channel
        helper._find("Publish Test Channel", timeout=10).click()
        time.sleep(2)

        # Type in the compose bar and publish
        _type_in_compose_bar(helper, "Hello from the channel owner!")

        # Tap publish button (exact match to avoid hitting "Publish content..." text)
        helper._find("Publish", timeout=10, partial=False).click()
        time.sleep(3)

        # Verify the publish snackbar appeared (indicates success)
        # The snackbar says "Published (N chunk(s))"
        helper._find("Published", timeout=10)

    @pytest.mark.single_device
    def test_channel_shows_share_button_for_owner(self, alice, app_helper):
        """Test that channel detail shows share button for the owner."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels and create one
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, 0, "Share Test Channel", hide_keyboard=True)

        helper._find("Create", timeout=10, partial=False).click()
        time.sleep(3)

        # Open the channel
        helper._find("Share Test Channel", timeout=10).click()
        time.sleep(2)

        # Share button should be visible (tooltip: 'Share channel')
        helper._find("Share channel", timeout=10)

    @pytest.mark.single_device
    def test_channel_shows_info_button(self, alice, app_helper):
        """Test that channel detail shows the info button."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels and create one
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, 0, "Info Test Channel", hide_keyboard=True)

        helper._find("Create", timeout=10, partial=False).click()
        time.sleep(3)

        # Open the channel
        helper._find("Info Test Channel", timeout=10).click()
        time.sleep(2)

        # Info button should be visible (tooltip: 'Channel info')
        helper._find("Channel info", timeout=10)

    @pytest.mark.single_device
    def test_channel_info_sheet(self, alice, app_helper):
        """Test opening the channel info bottom sheet."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels and create one
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, 0, "Info Sheet Channel")
        _type_in_field(helper, 1, "Sheet description", hide_keyboard=True)

        helper._find("Create", timeout=10, partial=False).click()
        time.sleep(3)

        # Open the channel
        helper._find("Info Sheet Channel", timeout=10).click()
        time.sleep(2)

        # Tap the info button
        helper._find("Channel info", timeout=10).click()
        time.sleep(2)

        # Verify the info sheet shows channel details
        helper._find("Channel Info", timeout=10)
        helper._find("Info Sheet Channel", timeout=5)

    @pytest.mark.single_device
    def test_channel_list_shows_role(self, alice, app_helper):
        """Test that channel list shows the role (OWNER) for created channels."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels and create one
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, 0, "Role Display Channel", hide_keyboard=True)

        helper._find("Create", timeout=10, partial=False).click()
        time.sleep(3)

        # Verify the OWNER role is displayed in the list
        helper._find("OWNER", timeout=10)

    @pytest.mark.single_device
    def test_navigate_back_from_channel_detail(self, alice, app_helper):
        """Test navigating back from channel detail to channel list."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Channels and create one
        helper._find("Channels", timeout=10).click()
        time.sleep(2)

        helper._find("Create Channel", timeout=10).click()
        time.sleep(2)

        _type_in_field(helper, 0, "Nav Back Channel", hide_keyboard=True)

        helper._find("Create", timeout=10, partial=False).click()
        time.sleep(3)

        # Open the channel
        helper._find("Nav Back Channel", timeout=10).click()
        time.sleep(2)

        # Verify we are on detail screen
        helper._find("Nav Back Channel", timeout=10)

        # Press back
        helper.driver.back()
        time.sleep(2)

        # We should be back on the channels list -- verify by looking for the list title
        # The AppBar title "Channels" should be present
        helper._find("Channels", timeout=10)


# ── Helpers ──────────────────────────────────────────────────────


def _type_in_field(helper, field_index, text, hide_keyboard=False):
    """Type text into a specific EditText field by index within a dialog.

    Flutter dialogs render TextField widgets as android.widget.EditText
    in UiAutomator2. We locate them by index since multiple fields may
    be present (e.g. channel name + description).

    Set hide_keyboard=True after typing the last field so the keyboard
    doesn't obscure dialog action buttons (Create, Cancel, etc.).
    """
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.common.by import By

    fields = WebDriverWait(helper.driver, 10).until(
        lambda d: d.find_elements(By.XPATH, "//android.widget.EditText")
    )

    if len(fields) <= field_index:
        raise ValueError(
            f"Expected at least {field_index + 1} EditText fields, found {len(fields)}"
        )

    field = fields[field_index]
    field.click()
    time.sleep(0.5)
    helper.driver.execute_script('mobile: type', {'text': text})
    time.sleep(0.5)

    if hide_keyboard:
        try:
            helper.driver.hide_keyboard()
        except Exception:
            pass  # Keyboard might already be hidden
        time.sleep(0.5)


def _type_in_compose_bar(helper, text):
    """Type text into the compose bar (single EditText on detail screen).

    On the channel detail screen the compose bar is a TextField with
    hint 'Publish to channel...'. It renders as android.widget.EditText.
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
