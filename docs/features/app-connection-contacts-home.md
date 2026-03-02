# App - Connection, Contacts & Home Features

## Connection Feature

### Peer Discovery & Server Connection
- **Location**: `packages/app/lib/features/connection/connect_screen.dart:L194-245`
- **Description**: Server discovery via SWIM gossip protocol, WebSocket connection to selected VPS server, automatic pairing code generation, trusted peer reconnection

### QR Code Sharing
- **Location**: `packages/app/lib/features/connection/connect_screen.dart:L282-447`
- **Description**: Display personal 6-character pairing code, generate QR code from pairing code (zajel:// URI format), copy pairing code to clipboard

### QR Code Scanning
- **Location**: `packages/app/lib/features/connection/connect_screen.dart:L449-481`
- **Description**: Mobile device camera integration via mobile_scanner, parse zajel:// URI scheme, automatic code extraction from QR data

### Pairing Code Entry
- **Location**: `packages/app/lib/features/connection/connect_screen.dart:L282-447`
- **Description**: Manual 6-character code input field, uppercase text conversion, code validation (6 characters required), connect button with loading state

### Web Browser Linking
- **Location**: `packages/app/lib/features/connection/connect_screen.dart:L483-663`
- **Description**: Create link sessions for web browser pairing, generate QR codes for web linking, display link codes with copy functionality, 5-minute expiration timer

### Linked Devices Management
- **Location**: `packages/app/lib/features/connection/connect_screen.dart:L601-726`
- **Description**: List all linked web devices, display device connection status (online/offline), revoke linked devices, show device names with connection indicators

### Link Request Approval
- **Location**: `packages/app/lib/features/connection/connect_screen.dart:L46-178`
- **Description**: Listen for incoming web client link requests, show approval dialogs with device details, display link code and key fingerprint, accept/reject with security warnings

### Connection State Management
- **Location**: `packages/app/lib/features/connection/connect_screen.dart:L22-44`
- **Description**: TabController for multi-tab interface (3 tabs), track connection state (connecting/connected/disconnected), error handling and retry

### Code Entry Validation
- **Location**: `packages/app/lib/features/connection/connect_screen.dart:L809-847`
- **Description**: Code length validation (exactly 6 characters), code format validation (alphanumeric), empty field detection, error messages via SnackBar

## Contacts Feature

### Trusted Peers Listing
- **Location**: `packages/app/lib/features/contacts/contacts_screen.dart:L11-22`
- **Description**: Provider fetches all trusted peers from storage, filters out blocked peers, sorts alphabetically by alias or display name

### Contact Search
- **Location**: `packages/app/lib/features/contacts/contacts_screen.dart:L45-57`
- **Description**: Real-time search input field, filter by contact name or alias, case-insensitive matching

### Contact List Display
- **Location**: `packages/app/lib/features/contacts/contacts_screen.dart:L60-91`
- **Description**: Scrollable ListView of contacts, shows empty state when no contacts or when search has no matches

### Contact Tiles
- **Location**: `packages/app/lib/features/contacts/contacts_screen.dart:L99-169`
- **Description**: Display contact name (alias or device name), online status indicator (green circle), last seen timestamp (relative time), connection status

### Online Status Detection
- **Location**: `packages/app/lib/features/contacts/contacts_screen.dart:L107-121`
- **Description**: Match peers by ID or public key, account for peer ID changes after migration, live peer lookup from visible peers provider

### Contact Navigation
- **Location**: `packages/app/lib/features/contacts/contacts_screen.dart:L156-166`
- **Description**: Tap to open chat with contact, long press to view contact details, use live peer ID for correct routing after migration

### Contact Profile Display
- **Location**: `packages/app/lib/features/contacts/contact_detail_screen.dart:L75-105`
- **Description**: Avatar with initials, display name and optional alias, avatar background color based on primary theme

### Alias Management
- **Location**: `packages/app/lib/features/contacts/contact_detail_screen.dart:L108-148`
- **Description**: Edit alias text field, save button to persist changes, clear button to remove existing alias

### Connection Information
- **Location**: `packages/app/lib/features/contacts/contact_detail_screen.dart:L151-177`
- **Description**: Peer ID display (monospace font), trusted since timestamp, last seen timestamp

### Block Contact
- **Location**: `packages/app/lib/features/contacts/contact_detail_screen.dart:L228-262`
- **Description**: Confirmation dialog before blocking, add to blocked peers list, prevent blocked peer from connecting

### Remove Contact Permanently
- **Location**: `packages/app/lib/features/contacts/contact_detail_screen.dart:L264-296`
- **Description**: Confirmation dialog with strong warning, delete from trusted peers storage, requires re-pairing to communicate

## Home Feature

### Home Screen Layout
- **Location**: `packages/app/lib/features/home/home_screen.dart:L10-82`
- **Description**: Header section with user info and status, scrollable peer list, error state with retry button, connect FAB button

### Header Section
- **Location**: `packages/app/lib/features/home/home_screen.dart:L84-184`
- **Description**: User avatar with initials, display name, pairing code display, connection status indicator (Online/Connecting/Offline) with color coding

### Peer List Display
- **Location**: `packages/app/lib/features/home/home_screen.dart:L186-269`
- **Description**: Split peers into Online and Offline groups, show count for each group, full peer cards, empty state guidance

### Peer Card
- **Location**: `packages/app/lib/features/home/home_screen.dart:L272-589`
- **Description**: Avatar with connection status indicator, peer name with alias support, status text and color, multiple action buttons based on state

### Connection Actions
- **Location**: `packages/app/lib/features/home/home_screen.dart:L322-348`
- **Description**: Connect button for offline peers, cancel button for connecting peers (with loading spinner), chat button for connected peers

### Peer Menu Options
- **Location**: `packages/app/lib/features/home/home_screen.dart:L349-393`
- **Description**: Rename peer (edit alias), delete peer connection, block peer via popup menu with icons

### Rename Dialog
- **Location**: `packages/app/lib/features/home/home_screen.dart:L409-450`
- **Description**: Text input field with current name, save/cancel buttons, auto-focus, update alias in storage with immediate UI refresh

### Delete Dialog
- **Location**: `packages/app/lib/features/home/home_screen.dart:L452-493`
- **Description**: Confirmation dialog, remove from trusted peers, clear chat messages, disconnect peer (best-effort)

### Block Dialog
- **Location**: `packages/app/lib/features/home/home_screen.dart:L495-532`
- **Description**: Confirmation dialog, add to blocked peers using public key or ID, prevent future connections

### Top Navigation Bar
- **Location**: `packages/app/lib/features/home/home_screen.dart:L18-46`
- **Description**: Channels button, Groups button, Contacts button, Connect button (QR scanner), Settings button

### Responsive Layout System
- **Location**: `packages/app/lib/features/home/main_layout.dart:L10-36`
- **Description**: Breakpoint at 720px for wide/narrow switch, LayoutBuilder for dynamic layout selection

### Wide Layout (Split-View)
- **Location**: `packages/app/lib/features/home/main_layout.dart:L39-70`
- **Description**: Sidebar (320px) + Chat split view, vertical divider between sections, responsive chat area

### Conversation Sidebar
- **Location**: `packages/app/lib/features/home/main_layout.dart:L105-197`
- **Description**: Header with user info and status, peer list with selection, connect FAB, navigation icons

### Conversation Tiles
- **Location**: `packages/app/lib/features/home/main_layout.dart:L301-404`
- **Description**: Peer name with alias support, last message preview or connection status, timestamp, online status indicator, selection highlighting

### Empty Chat Placeholder
- **Location**: `packages/app/lib/features/home/main_layout.dart:L73-102`
- **Description**: Centered message icon with "Select a conversation" prompt for wide layout
