# App - Chat Features

## Chat Screen
### Main Chat Screen Widget
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L22-32`
- **Description**: ConsumerStatefulWidget that displays encrypted messaging interface for peer-to-peer communication

### Split-view/Embedded Mode
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L22-28`
- **Description**: Renders chat without Scaffold/AppBar when embedded in split-view layouts

### Connection Status Indicator
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L140-158`
- **Description**: Displays offline warning banner when peer is disconnected with message queuing indication

### App Bar Header
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L198-234`
- **Description**: Shows peer avatar, name, connection status, and action buttons for voice/video calls

### Embedded Header
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L236-287`
- **Description**: Compact header variant for split-view mode with peer info and action buttons

## Messaging
### Text Message Sending
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L550-594`
- **Description**: Sends encrypted text messages with status tracking (pending/sending/sent/failed)

### File Sending
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L596-639`
- **Description**: Allows picking and sending files with progress tracking and attachment metadata

### Message List Rendering
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L380-403`
- **Description**: Displays chronological message history with date dividers between different days

### Empty State
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L349-378`
- **Description**: Shows E2E encryption info (X25519 + ChaCha20-Poly1305) when no messages exist

### Message Bubble Widget
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L938-1000`
- **Description**: Renders individual message bubble with alignment, styling, and status indicators

### Message Status Indicators
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L1053-1075`
- **Description**: Shows message delivery status (sending/sent/delivered/read/failed) with appropriate icons

### File Message Rendering
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L1002-1051`
- **Description**: Displays file attachments with name, size, open button for received files

### File Opening
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L405-446`
- **Description**: Opens files using system default apps on desktop (xdg-open/open/cmd) or share sheet on mobile

## Input & Composition
### Message Input Bar
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L470-548`
- **Description**: TextField with emoji button, file attachment, send button, and keyboard handling

### Emoji Picker Integration
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L165-178`
- **Description**: Toggles filtered emoji picker with keyboard fallback

### Filtered Emoji Picker Widget
- **Location**: `packages/app/lib/features/chat/widgets/filtered_emoji_picker.dart:L48-101`
- **Description**: Custom emoji picker excluding blocked emojis for Islamic values compliance

### Blocked Emojis Set
- **Location**: `packages/app/lib/features/chat/widgets/filtered_emoji_picker.dart:L12-35`
- **Description**: Filters out alcohol, gambling, pork, inappropriate gestures, and suggestive emojis

### Desktop Key Handling
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L116-127`
- **Description**: Handles Enter (send) and Shift+Enter (newline) on desktop platforms

### Auto-scroll to Latest
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L641-651`
- **Description**: Animates scroll to bottom when new messages arrive

## VoIP Integration
### Voice Call Button
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L291-294`
- **Description**: Initiates voice-only call with peer validation

### Video Call Button
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L296-300`
- **Description**: Initiates video call with peer validation

### Start Call Handler
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L654-683`
- **Description**: Handles call initiation with error handling and navigation to call screen

### Incoming Call Listener
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L71-89`
- **Description**: Monitors VoIP state and shows incoming call dialog when call arrives

### Incoming Call Dialog
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L694-733`
- **Description**: Modal dialog for accepting/rejecting incoming calls with video option

### Call Screen Navigation
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L736-751`
- **Description**: Routes to call screen with VoIP and media services

## Peer Management
### Rename Peer Dialog
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L753-797`
- **Description**: Modal for changing peer alias with immediate UI update

### Delete Conversation
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L799-838`
- **Description**: Confirms and removes peer, clears messages, disconnects connection

### Peer Information Sheet
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L861-918`
- **Description**: Modal showing peer name, ID, IP, connection status, last seen timestamp

### Peer Info Row Widget
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L1088-1117`
- **Description**: Reusable label-value row for displaying peer information

## Security & Verification
### Fingerprint Verification Section
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L1124-1360`
- **Description**: Expandable section for comparing X25519 public key fingerprints with peer through trusted channels

### Fingerprint Loading
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L1147-1168`
- **Description**: Async loader for user and peer fingerprints using crypto service

### Fingerprint Card Widget
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L1363-1435`
- **Description**: Displays monospace fingerprint with copy-to-clipboard functionality

### Fingerprint Copy Handler
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L1170-1180`
- **Description**: Copies fingerprint to clipboard and shows toast notification

### Security Verification UI Components
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L1253-1352`
- **Description**: Info boxes for instructions, warnings (peer offline), and success confirmation

### End-to-End Encryption Info
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L844,368,903`
- **Description**: Displays encryption method (X25519 key exchange + ChaCha20-Poly1305) in multiple locations

## State Management & Lifecycle
### Message Stream Listener
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L91-103`
- **Description**: Monitors message stream and reloads messages when new ones arrive for current peer

### Widget Lifecycle Management
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L56-113`
- **Description**: Initializes observers, listeners, and cleans up subscriptions on dispose

### App Lifecycle Handling
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L65-69`
- **Description**: Focuses message input when app resumes to foreground

### Dialog Context Management
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L48-54`
- **Description**: Uses root navigator context for split-view embedded mode to fix GTK/Linux dialog rendering

## Utilities
### Date Formatting
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L924-935`
- **Description**: Formats dates as "Today", "Yesterday", or "DD/MM/YYYY" for messages and info

### Date Divider Widget
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L448-468`
- **Description**: Visual divider showing date between message groups

### Time Formatting
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L1077-1079`
- **Description**: Formats message timestamp as "HH:MM"

### File Size Formatting
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L1081-1085`
- **Description**: Converts byte sizes to human-readable format (B/KB/MB)

### Connection Status Display
- **Location**: `packages/app/lib/features/chat/chat_screen.dart:L840-859`
- **Description**: Maps peer connection states to user-friendly status strings and colors
