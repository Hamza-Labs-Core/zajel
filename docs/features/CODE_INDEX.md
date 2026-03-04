# Zajel Feature-to-Code Index

A developer reference mapping every feature to its implementation location.

---

## App

### Chat

| Feature | Location |
|---------|----------|
| Chat Screen | `packages/app/lib/features/chat/chat_screen.dart:L22-32` |
| Split-view/Embedded Mode | `packages/app/lib/features/chat/chat_screen.dart:L22-28` |
| Connection Status Indicator | `packages/app/lib/features/chat/chat_screen.dart:L140-158` |
| App Bar Header | `packages/app/lib/features/chat/chat_screen.dart:L198-234` |
| Embedded Header | `packages/app/lib/features/chat/chat_screen.dart:L236-287` |
| Text Message Sending | `packages/app/lib/features/chat/chat_screen.dart:L550-594` |
| File Sending | `packages/app/lib/features/chat/chat_screen.dart:L596-639` |
| Message List Rendering | `packages/app/lib/features/chat/chat_screen.dart:L380-403` |
| Empty State | `packages/app/lib/features/chat/chat_screen.dart:L349-378` |
| Message Bubble Widget | `packages/app/lib/features/chat/chat_screen.dart:L938-1000` |
| Message Status Indicators | `packages/app/lib/features/chat/chat_screen.dart:L1053-1075` |
| File Message Rendering | `packages/app/lib/features/chat/chat_screen.dart:L1002-1051` |
| File Opening | `packages/app/lib/features/chat/chat_screen.dart:L405-446` |
| Message Input Bar | `packages/app/lib/features/chat/chat_screen.dart:L470-548` |
| Emoji Picker Integration | `packages/app/lib/features/chat/chat_screen.dart:L165-178` |
| Filtered Emoji Picker | `packages/app/lib/features/chat/widgets/filtered_emoji_picker.dart:L48-101` |
| Blocked Emojis Set | `packages/app/lib/features/chat/widgets/filtered_emoji_picker.dart:L12-35` |
| Desktop Key Handling | `packages/app/lib/features/chat/chat_screen.dart:L116-127` |
| Auto-scroll to Latest | `packages/app/lib/features/chat/chat_screen.dart:L641-651` |
| Voice Call Button | `packages/app/lib/features/chat/chat_screen.dart:L291-294` |
| Video Call Button | `packages/app/lib/features/chat/chat_screen.dart:L296-300` |
| Start Call Handler | `packages/app/lib/features/chat/chat_screen.dart:L654-683` |
| Incoming Call Listener | `packages/app/lib/features/chat/chat_screen.dart:L71-89` |
| Incoming Call Dialog | `packages/app/lib/features/chat/chat_screen.dart:L694-733` |
| Call Screen Navigation | `packages/app/lib/features/chat/chat_screen.dart:L736-751` |
| Rename Peer Dialog | `packages/app/lib/features/chat/chat_screen.dart:L753-797` |
| Delete Conversation | `packages/app/lib/features/chat/chat_screen.dart:L799-838` |
| Peer Information Sheet | `packages/app/lib/features/chat/chat_screen.dart:L861-918` |
| Peer Info Row Widget | `packages/app/lib/features/chat/chat_screen.dart:L1088-1117` |
| Fingerprint Verification Section | `packages/app/lib/features/chat/chat_screen.dart:L1124-1360` |
| Fingerprint Loading | `packages/app/lib/features/chat/chat_screen.dart:L1147-1168` |
| Fingerprint Card Widget | `packages/app/lib/features/chat/chat_screen.dart:L1363-1435` |
| Fingerprint Copy Handler | `packages/app/lib/features/chat/chat_screen.dart:L1170-1180` |
| Security Verification UI | `packages/app/lib/features/chat/chat_screen.dart:L1253-1352` |
| End-to-End Encryption Info | `packages/app/lib/features/chat/chat_screen.dart:L844,368,903` |
| Message Stream Listener | `packages/app/lib/features/chat/chat_screen.dart:L91-103` |
| Widget Lifecycle Management | `packages/app/lib/features/chat/chat_screen.dart:L56-113` |
| App Lifecycle Handling | `packages/app/lib/features/chat/chat_screen.dart:L65-69` |
| Dialog Context Management | `packages/app/lib/features/chat/chat_screen.dart:L48-54` |
| Date Formatting | `packages/app/lib/features/chat/chat_screen.dart:L924-935` |
| Date Divider Widget | `packages/app/lib/features/chat/chat_screen.dart:L448-468` |
| Time Formatting | `packages/app/lib/features/chat/chat_screen.dart:L1077-1079` |
| File Size Formatting | `packages/app/lib/features/chat/chat_screen.dart:L1081-1085` |
| Connection Status Display | `packages/app/lib/features/chat/chat_screen.dart:L840-859` |

### Channels

| Feature | Location |
|---------|----------|
| Channel Creation | `packages/app/lib/features/channels/services/channel_service.dart:L40-88` |
| Channel Subscription | `packages/app/lib/features/channels/services/channel_service.dart:L102-124` |
| Channel Link Encoding | `packages/app/lib/features/channels/services/channel_link_service.dart:L19-35` |
| Channel Link Decoding | `packages/app/lib/features/channels/services/channel_link_service.dart:L40-67` |
| Channel Model | `packages/app/lib/features/channels/models/channel.dart:L241-356` |
| Channel Manifest | `packages/app/lib/features/channels/models/channel.dart:L99-234` |
| Channel Rules | `packages/app/lib/features/channels/models/channel.dart:L39-92` |
| Admin Key | `packages/app/lib/features/channels/models/channel.dart:L15-36` |
| Channel Role Enum | `packages/app/lib/features/channels/models/channel.dart:L5-13` |
| Chunk Model | `packages/app/lib/features/channels/models/chunk.dart:L105-226` |
| Chunk Payload Model | `packages/app/lib/features/channels/models/chunk.dart:L26-99` |
| Content Type Enum | `packages/app/lib/features/channels/models/chunk.dart:L7-21` |
| Content Splitting into Chunks | `packages/app/lib/features/channels/services/channel_service.dart:L138-202` |
| Chunk Reassembly | `packages/app/lib/features/channels/services/channel_service.dart:L227-302` |
| Chunk Signature Verification | `packages/app/lib/features/channels/services/channel_service.dart:L316-336` |
| Crypto Service | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L13-376` |
| Signing Key Generation | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L30-40` |
| Encryption Key Generation | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L45-55` |
| Channel ID Derivation | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L62-75` |
| Manifest Signing | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L99-120` |
| Manifest Verification | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L127-158` |
| Payload Encryption | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L190-216` |
| Payload Decryption | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L221-253` |
| Chunk Signing | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L262-276` |
| Chunk Signature Verification (Crypto) | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L282-304` |
| Subscriber 5-Step Verification | `packages/app/lib/features/channels/services/channel_crypto_service.dart:L321-365` |
| Storage Service | `packages/app/lib/features/channels/services/channel_storage_service.dart:L20-362` |
| Channel Persistence | `packages/app/lib/features/channels/services/channel_storage_service.dart:L98-209` |
| Chunk Persistence | `packages/app/lib/features/channels/services/channel_storage_service.dart:L214-327` |
| Database Initialization | `packages/app/lib/features/channels/services/channel_storage_service.dart:L38-91` |
| Latest Sequence Lookup | `packages/app/lib/features/channels/services/channel_storage_service.dart:L314-326` |
| Sync Service | `packages/app/lib/features/channels/services/channel_sync_service.dart:L29-393` |
| Chunk Announcement | `packages/app/lib/features/channels/services/channel_sync_service.dart:L130-190` |
| Chunk Request | `packages/app/lib/features/channels/services/channel_sync_service.dart:L196-237` |
| Chunk Push | `packages/app/lib/features/channels/services/channel_sync_service.dart:L243-258` |
| Periodic Sync | `packages/app/lib/features/channels/services/channel_sync_service.dart:L85-108` |
| Server Message Handling | `packages/app/lib/features/channels/services/channel_sync_service.dart:L277-393` |
| Admin Management Service | `packages/app/lib/features/channels/services/admin_management_service.dart:L11-120` |
| Appoint Admin | `packages/app/lib/features/channels/services/admin_management_service.dart:L35-69` |
| Remove Admin | `packages/app/lib/features/channels/services/admin_management_service.dart:L80-119` |
| Admin Authorization Validation | `packages/app/lib/features/channels/services/admin_management_service.dart:L129-138` |
| Upstream Message Validation | `packages/app/lib/features/channels/services/admin_management_service.dart:L148-168` |
| Update Channel Rules | `packages/app/lib/features/channels/services/admin_management_service.dart:L173-192` |
| Encryption Key Rotation | `packages/app/lib/features/channels/services/channel_service.dart:L421-447` |
| Add Admin | `packages/app/lib/features/channels/services/channel_service.dart:L364-389` |
| Remove Admin (Service) | `packages/app/lib/features/channels/services/channel_service.dart:L392-415` |
| Upstream Message Model | `packages/app/lib/features/channels/models/upstream_message.dart:L25-95` |
| Upstream Payload Model | `packages/app/lib/features/channels/models/upstream_message.dart:L98-166` |
| Upstream Message Types | `packages/app/lib/features/channels/models/upstream_message.dart:L10-19` |
| Reply Thread | `packages/app/lib/features/channels/models/upstream_message.dart:L169-194` |
| Upstream Service | `packages/app/lib/features/channels/services/upstream_service.dart:L25-136` |
| Send Reply | `packages/app/lib/features/channels/services/upstream_service.dart:L70-87` |
| Send Vote | `packages/app/lib/features/channels/services/upstream_service.dart:L94-112` |
| Send Reaction | `packages/app/lib/features/channels/services/upstream_service.dart:L119-136` |
| Poll Model | `packages/app/lib/features/channels/services/poll_service.dart:L34-89` |
| Poll Option | `packages/app/lib/features/channels/services/poll_service.dart:L14-31` |
| Poll Results | `packages/app/lib/features/channels/services/poll_service.dart:L92-138` |
| Poll Service | `packages/app/lib/features/channels/services/poll_service.dart:L147-162` |
| Create Poll | `packages/app/lib/features/channels/services/poll_service.dart:L171-200` |
| Live Stream Metadata | `packages/app/lib/features/channels/models/live_stream.dart:L19-117` |
| Live Stream Frame | `packages/app/lib/features/channels/models/live_stream.dart:L124-181` |
| Live Stream State | `packages/app/lib/features/channels/models/live_stream.dart:L7-16` |
| Live Stream Service | `packages/app/lib/features/channels/services/live_stream_service.dart:L33-200` |
| Start Stream | `packages/app/lib/features/channels/services/live_stream_service.dart:L89-129` |
| Send Frame | `packages/app/lib/features/channels/services/live_stream_service.dart:L137-200` |
| RTMP Frame | `packages/app/lib/features/channels/services/rtmp_ingest_service.dart:L30-109` |
| RTMP Tag Type | `packages/app/lib/features/channels/services/rtmp_ingest_service.dart:L8-28` |
| RTMP Ingest Service | `packages/app/lib/features/channels/services/rtmp_ingest_service.dart:L138-150` |
| Routing Hash Service | `packages/app/lib/features/channels/services/routing_hash_service.dart:L112-200` |
| Routing Hash Derivation | `packages/app/lib/features/channels/services/routing_hash_service.dart:L136-145` |
| Historic Routing Hash | `packages/app/lib/features/channels/services/routing_hash_service.dart:L151-158` |
| Epoch Number Calculation | `packages/app/lib/features/channels/services/routing_hash_service.dart:L161-181` |
| Censorship Detection | `packages/app/lib/features/channels/services/routing_hash_service.dart:L188-200` |
| Routing Hash Epoch Duration | `packages/app/lib/features/channels/services/routing_hash_service.dart:L12-18` |
| Background Sync Service | `packages/app/lib/features/channels/services/background_sync_service.dart:L72-200` |
| Sync Result | `packages/app/lib/features/channels/services/background_sync_service.dart:L16-43` |
| Background Task Registration | `packages/app/lib/features/channels/services/background_sync_service.dart:L143-172` |
| Periodic Sync (Background) | `packages/app/lib/features/channels/services/background_sync_service.dart:L72-122` |
| Main Screen (Responsive Layout) | `packages/app/lib/features/channels/channels_main_screen.dart:L19-37` |
| Wide Layout with Sidebar | `packages/app/lib/features/channels/channels_main_screen.dart:L39-67` |
| Channel Sidebar | `packages/app/lib/features/channels/channels_main_screen.dart:L101-208` |
| Channels List Screen | `packages/app/lib/features/channels/channels_list_screen.dart:L13-231` |
| Create Channel Dialog | `packages/app/lib/features/channels/channels_list_screen.dart:L17-73` |
| Subscribe Dialog | `packages/app/lib/features/channels/channels_list_screen.dart:L76-140` |
| Channel Detail Screen | `packages/app/lib/features/channels/channel_detail_screen.dart:L18-643` |
| Embedded Channel Header | `packages/app/lib/features/channels/channel_detail_screen.dart:L135-194` |
| Channel Banner | `packages/app/lib/features/channels/channel_detail_screen.dart:L196-228` |
| Message List | `packages/app/lib/features/channels/channel_detail_screen.dart:L259-270` |
| Message Bubble | `packages/app/lib/features/channels/channel_detail_screen.dart:L272-317` |
| Compose Bar | `packages/app/lib/features/channels/channel_detail_screen.dart:L319-371` |
| Share Dialog | `packages/app/lib/features/channels/channel_detail_screen.dart:L461-529` |
| Channel Info Sheet | `packages/app/lib/features/channels/channel_detail_screen.dart:L531-603` |
| Publish Message | `packages/app/lib/features/channels/channel_detail_screen.dart:L373-459` |
| Content Type Validation | `packages/app/lib/features/channels/services/channel_service.dart:L349-355` |
| Message Display Model | `packages/app/lib/features/channels/providers/channel_providers.dart:L218-232` |
| Message Provider | `packages/app/lib/features/channels/providers/channel_providers.dart:L239-293` |
| Channel Providers | `packages/app/lib/features/channels/providers/channel_providers.dart:L1-294` |
| Selected Channel ID Provider | `packages/app/lib/features/channels/providers/channel_providers.dart:L215` |

### Groups

| Feature | Location |
|---------|----------|
| Groups List Screen | `packages/app/lib/features/groups/groups_list_screen.dart:L1-135` |
| Group Detail Screen | `packages/app/lib/features/groups/group_detail_screen.dart:L1-471` |
| Group Model | `packages/app/lib/features/groups/models/group.dart:L66-164` |
| GroupMember Model | `packages/app/lib/features/groups/models/group.dart:L6-56` |
| GroupMessage Model | `packages/app/lib/features/groups/models/group_message.dart:L36-190` |
| GroupMessageType Enum | `packages/app/lib/features/groups/models/group_message.dart:L7-18` |
| GroupMessageStatus Enum | `packages/app/lib/features/groups/models/group_message.dart:L21-34` |
| VectorClock | `packages/app/lib/features/groups/models/vector_clock.dart:L10-135` |
| GroupService | `packages/app/lib/features/groups/services/group_service.dart:L1-383` |
| Group Creation | `packages/app/lib/features/groups/services/group_service.dart:L42-89` |
| Member Management | `packages/app/lib/features/groups/services/group_service.dart:L95-214` |
| Group Messaging | `packages/app/lib/features/groups/services/group_service.dart:L220-298` |
| Group Sync | `packages/app/lib/features/groups/services/group_service.dart:L304-325` |
| GroupCryptoService | `packages/app/lib/features/groups/services/group_crypto_service.dart:L1-219` |
| Sender Key Generation | `packages/app/lib/features/groups/services/group_crypto_service.dart:L28-36` |
| Key Management | `packages/app/lib/features/groups/services/group_crypto_service.dart:L45-97` |
| Encryption & Decryption | `packages/app/lib/features/groups/services/group_crypto_service.dart:L102-180` |
| GroupStorageService | `packages/app/lib/features/groups/services/group_storage_service.dart:L1-358` |
| Group CRUD | `packages/app/lib/features/groups/services/group_storage_service.dart:L102-154` |
| Message CRUD | `packages/app/lib/features/groups/services/group_storage_service.dart:L160-229` |
| Vector Clock Operations | `packages/app/lib/features/groups/services/group_storage_service.dart:L235-270` |
| Sender Key Storage | `packages/app/lib/features/groups/services/group_storage_service.dart:L276-329` |
| GroupSyncService | `packages/app/lib/features/groups/services/group_sync_service.dart:L1-172` |
| Sync Computation | `packages/app/lib/features/groups/services/group_sync_service.dart:L56-90` |
| Message Application | `packages/app/lib/features/groups/services/group_sync_service.dart:L100-134` |
| Sequence Tracking | `packages/app/lib/features/groups/services/group_sync_service.dart:L140-172` |
| GroupInvitationService | `packages/app/lib/features/groups/services/group_invitation_service.dart:L1-217` |
| Invitation Sending | `packages/app/lib/features/groups/services/group_invitation_service.dart:L67-99` |
| Invitation Receiving | `packages/app/lib/features/groups/services/group_invitation_service.dart:L101-166` |
| Group Message Relay | `packages/app/lib/features/groups/services/group_invitation_service.dart:L168-216` |
| GroupConnectionService | `packages/app/lib/features/groups/services/group_connection_service.dart:L89-462` |
| Group Activation | `packages/app/lib/features/groups/services/group_connection_service.dart:L166-225` |
| Member Connection Management | `packages/app/lib/features/groups/services/group_connection_service.dart:L234-281` |
| Data Broadcasting | `packages/app/lib/features/groups/services/group_connection_service.dart:L287-318` |
| State Queries | `packages/app/lib/features/groups/services/group_connection_service.dart:L324-357` |
| WebRtcP2PAdapter | `packages/app/lib/features/groups/services/webrtc_p2p_adapter.dart:L1-122` |
| Group Providers | `packages/app/lib/features/groups/providers/group_providers.dart:L1-131` |
| Service Providers | `packages/app/lib/features/groups/providers/group_providers.dart:L14-105` |
| Data Providers | `packages/app/lib/features/groups/providers/group_providers.dart:L107-130` |

### Call / VoIP

| Feature | Location |
|---------|----------|
| Main Call Screen | `packages/app/lib/features/call/call_screen.dart:L10-338` |
| Remote Video Display | `packages/app/lib/features/call/call_screen.dart:L146-154` |
| Local Video Preview | `packages/app/lib/features/call/call_screen.dart:L156-177` |
| Call State Status Overlay | `packages/app/lib/features/call/call_screen.dart:L179-257` |
| Call Duration Timer | `packages/app/lib/features/call/call_screen.dart:L116-135` |
| Call Control Buttons | `packages/app/lib/features/call/call_screen.dart:L260-310` |
| In-Call Device Settings Sheet | `packages/app/lib/features/call/call_screen.dart:L379-572` |
| Incoming Call UI | `packages/app/lib/features/call/incoming_call_dialog.dart:L3-127` |
| Caller Avatar Display | `packages/app/lib/features/call/incoming_call_dialog.dart:L52-63` |
| Caller Information | `packages/app/lib/features/call/incoming_call_dialog.dart:L64-79` |
| Call Action Buttons | `packages/app/lib/features/call/incoming_call_dialog.dart:L82-116` |
| Call State Management | `packages/app/lib/core/network/voip_service.dart:L14-32` |
| Call Info Model | `packages/app/lib/core/network/voip_service.dart:L34-75` |
| Outgoing Call Initiation | `packages/app/lib/core/network/voip_service.dart:L191-236` |
| Incoming Call Handling | `packages/app/lib/core/network/voip_service.dart:L473-510` |
| Call Answer | `packages/app/lib/core/network/voip_service.dart:L244-282` |
| Call Rejection | `packages/app/lib/core/network/voip_service.dart:L284-304` |
| Call Hangup | `packages/app/lib/core/network/voip_service.dart:L306-317` |
| Media Controls | `packages/app/lib/core/network/voip_service.dart:L319-371` |
| Peer Connection Management | `packages/app/lib/core/network/voip_service.dart:L373-461` |
| ICE Candidate Handling | `packages/app/lib/core/network/voip_service.dart:L559-596` |
| Resource Cleanup | `packages/app/lib/core/network/voip_service.dart:L627-667` |
| Media Access Control | `packages/app/lib/core/media/media_service.dart:L192-262` |
| Audio Processing | `packages/app/lib/core/media/media_service.dart:L136-175` |
| Device Management | `packages/app/lib/core/media/media_service.dart:L442-510` |
| Camera Switching | `packages/app/lib/core/media/media_service.dart:L311-328` |
| Background Blur Processing | `packages/app/lib/core/media/background_blur_processor.dart:L5-60` |
| Call Signaling Messages | `packages/app/lib/core/network/signaling_client.dart:L416-480` |
| Android Foreground Notification | `packages/app/lib/core/notifications/call_foreground_service.dart:L7-61` |
| Timeout Configuration | `packages/app/lib/core/constants.dart:L95-114` |

### Connection & Pairing

| Feature | Location |
|---------|----------|
| Server Discovery & Connection | `packages/app/lib/features/connection/connect_screen.dart:L194-245` |
| QR Code Sharing | `packages/app/lib/features/connection/connect_screen.dart:L282-447` |
| QR Code Scanning | `packages/app/lib/features/connection/connect_screen.dart:L449-481` |
| Pairing Code Entry | `packages/app/lib/features/connection/connect_screen.dart:L282-447` |
| Web Browser Linking | `packages/app/lib/features/connection/connect_screen.dart:L483-663` |
| Linked Devices Management | `packages/app/lib/features/connection/connect_screen.dart:L601-726` |
| Link Request Approval | `packages/app/lib/features/connection/connect_screen.dart:L46-178` |
| Connection State Management | `packages/app/lib/features/connection/connect_screen.dart:L22-44` |
| Code Entry Validation | `packages/app/lib/features/connection/connect_screen.dart:L809-847` |

### Contacts

| Feature | Location |
|---------|----------|
| Trusted Peers Listing | `packages/app/lib/features/contacts/contacts_screen.dart:L11-22` |
| Contact Search | `packages/app/lib/features/contacts/contacts_screen.dart:L45-57` |
| Contact List Display | `packages/app/lib/features/contacts/contacts_screen.dart:L60-91` |
| Contact Tiles | `packages/app/lib/features/contacts/contacts_screen.dart:L99-169` |
| Online Status Detection | `packages/app/lib/features/contacts/contacts_screen.dart:L107-121` |
| Contact Navigation | `packages/app/lib/features/contacts/contacts_screen.dart:L156-166` |
| Contact Profile Display | `packages/app/lib/features/contacts/contact_detail_screen.dart:L75-105` |
| Alias Management | `packages/app/lib/features/contacts/contact_detail_screen.dart:L108-148` |
| Connection Information | `packages/app/lib/features/contacts/contact_detail_screen.dart:L151-177` |
| Block Contact | `packages/app/lib/features/contacts/contact_detail_screen.dart:L228-262` |
| Remove Contact Permanently | `packages/app/lib/features/contacts/contact_detail_screen.dart:L264-296` |

### Home & Navigation

| Feature | Location |
|---------|----------|
| Home Screen Layout | `packages/app/lib/features/home/home_screen.dart:L10-82` |
| Header Section | `packages/app/lib/features/home/home_screen.dart:L84-184` |
| Peer List Display | `packages/app/lib/features/home/home_screen.dart:L186-269` |
| Peer Card | `packages/app/lib/features/home/home_screen.dart:L272-589` |
| Connection Actions | `packages/app/lib/features/home/home_screen.dart:L322-348` |
| Peer Menu Options | `packages/app/lib/features/home/home_screen.dart:L349-393` |
| Rename Dialog | `packages/app/lib/features/home/home_screen.dart:L409-450` |
| Delete Dialog | `packages/app/lib/features/home/home_screen.dart:L452-493` |
| Block Dialog | `packages/app/lib/features/home/home_screen.dart:L495-532` |
| Top Navigation Bar | `packages/app/lib/features/home/home_screen.dart:L18-46` |
| Responsive Layout System | `packages/app/lib/features/home/main_layout.dart:L10-36` |
| Wide Layout (Split-View) | `packages/app/lib/features/home/main_layout.dart:L39-70` |
| Conversation Sidebar | `packages/app/lib/features/home/main_layout.dart:L105-197` |
| Conversation Tiles | `packages/app/lib/features/home/main_layout.dart:L301-404` |
| Empty Chat Placeholder | `packages/app/lib/features/home/main_layout.dart:L73-102` |

### Settings

| Feature | Location |
|---------|----------|
| Settings Screen | `packages/app/lib/features/settings/settings_screen.dart` |
| Notification Settings | `packages/app/lib/features/settings/notification_settings_screen.dart` |
| Media Settings | `packages/app/lib/features/settings/media_settings_screen.dart` |
| Blocked Peers Screen | `packages/app/lib/features/settings/blocked_peers_screen.dart` |

### Onboarding

| Feature | Location |
|---------|----------|
| Onboarding Screen | `packages/app/lib/features/onboarding/onboarding_screen.dart` |

### Help

| Feature | Location |
|---------|----------|
| Help Screen | `packages/app/lib/features/help/help_screen.dart` |
| Help Article Screen | `packages/app/lib/features/help/help_article_screen.dart` |
| Help Content | `packages/app/lib/features/help/help_content.dart` |

### Attestation

| Feature | Location |
|---------|----------|
| Attestation Initializer | `packages/app/lib/features/attestation/attestation_initializer.dart` |
| Attestation Service | `packages/app/lib/features/attestation/services/attestation_service.dart` |
| Version Check Service | `packages/app/lib/features/attestation/services/version_check_service.dart` |
| Anti-Tamper Service | `packages/app/lib/features/attestation/services/anti_tamper_service.dart` |
| Binary Attestation Service | `packages/app/lib/features/attestation/services/binary_attestation_service.dart` |
| Server Attestation Service | `packages/app/lib/features/attestation/services/server_attestation_service.dart` |
| Attestation Client | `packages/app/lib/features/attestation/services/attestation_client.dart` |
| Session Token Model | `packages/app/lib/features/attestation/models/session_token.dart` |
| Build Token Model | `packages/app/lib/features/attestation/models/build_token.dart` |
| Version Policy Model | `packages/app/lib/features/attestation/models/version_policy.dart` |
| Force Update Dialog | `packages/app/lib/features/attestation/widgets/force_update_dialog.dart` |
| Update Prompt Dialog | `packages/app/lib/features/attestation/widgets/update_prompt_dialog.dart` |
| Binary Reader (Abstract) | `packages/app/lib/features/attestation/platform/binary_reader.dart` |
| Binary Reader (Desktop) | `packages/app/lib/features/attestation/platform/binary_reader_desktop.dart` |
| Attestation Providers | `packages/app/lib/features/attestation/providers/attestation_providers.dart` |

### Core Crypto

| Feature | Location |
|---------|----------|
| Key Exchange Service | `packages/app/lib/core/crypto/crypto_service.dart:L1-396` |
| Session Key Management | `packages/app/lib/core/crypto/crypto_service.dart:L59-218` |
| Identity Key Persistence | `packages/app/lib/core/crypto/crypto_service.dart:L326-354` |
| Encryption and Decryption | `packages/app/lib/core/crypto/crypto_service.dart:L221-286` |
| Public Key Fingerprinting | `packages/app/lib/core/crypto/crypto_service.dart:L69-128` |
| Bootstrap Server Verification | `packages/app/lib/core/crypto/bootstrap_verifier.dart:L1-73` |

### Core Network

| Feature | Location |
|---------|----------|
| WebRTC Peer Connection | `packages/app/lib/core/network/webrtc_service.dart:L35-571` |
| Data Channels | `packages/app/lib/core/network/webrtc_service.dart:L429-471` |
| ICE Candidate Queuing | `packages/app/lib/core/network/webrtc_service.dart:L177-229` |
| Encrypted Message Transport | `packages/app/lib/core/network/webrtc_service.dart:L232-243` |
| Encrypted File Chunking | `packages/app/lib/core/network/webrtc_service.dart:L245-299` |
| Cryptographic Handshake | `packages/app/lib/core/network/webrtc_service.dart:L301-316` |
| WebSocket Connection Management | `packages/app/lib/core/network/signaling_client.dart:L184-312` |
| Certificate Pinning | `packages/app/lib/core/network/pinned_websocket.dart` |
| Heartbeat Protocol | `packages/app/lib/core/network/signaling_client.dart:L759-770` |
| Pairing Code Generation | `packages/app/lib/core/network/connection_manager.dart:L19-73` |
| Pair Request/Response | `packages/app/lib/core/network/signaling_client.dart:L380-399` |
| Call Signaling Messages | `packages/app/lib/core/network/signaling_client.dart:L416-480` |
| ICE Candidate Signaling | `packages/app/lib/core/network/signaling_client.dart:L370-378` |
| Device Link Request/Response | `packages/app/lib/core/network/signaling_client.dart:L401-410` |
| Rendezvous Event Handling | `packages/app/lib/core/network/signaling_client.dart:L671-847` |
| Meeting Points Derivation | `packages/app/lib/core/network/meeting_point_service.dart:L1-100` |
| Rendezvous Registration | `packages/app/lib/core/network/connection_manager.dart:L948-1030` |
| Dead Drop Creation and Decryption | `packages/app/lib/core/network/rendezvous_service.dart:L109-144` |
| Live Match Handling | `packages/app/lib/core/network/rendezvous_service.dart:L146-156` |
| Federated Server Redirects | `packages/app/lib/core/network/connection_manager.dart:L1065-1168` |
| Bootstrap Server Discovery | `packages/app/lib/core/network/server_discovery_service.dart:L1-238` |
| Server Selection | `packages/app/lib/core/network/server_discovery_service.dart:L159-191` |
| Periodic Server Refresh | `packages/app/lib/core/network/server_discovery_service.dart:L217-230` |
| Relay Connection Management | `packages/app/lib/core/network/relay_client.dart:L24-476` |
| Source ID Mapping | `packages/app/lib/core/network/relay_client.dart:L262-320` |
| Introduction Protocol | `packages/app/lib/core/network/relay_client.dart:L182-237` |
| Load Reporting | `packages/app/lib/core/network/relay_client.dart:L322-375` |
| Peer Connection Lifecycle | `packages/app/lib/core/network/connection_manager.dart:L92-1209` |
| Trusted Peer Migration | `packages/app/lib/core/network/connection_manager.dart:L658-723` |
| Signaling State Machine | `packages/app/lib/core/network/connection_manager.dart:L75-90` |
| Linked Device Support | `packages/app/lib/core/network/device_link_service.dart` |
| Message Protocol | `packages/app/lib/core/protocol/message_protocol.dart:L1-216` |
| Handshake Messages | `packages/app/lib/core/protocol/message_protocol.dart:L55-87` |
| File Chunk Encoding | `packages/app/lib/core/protocol/message_protocol.dart:L89-134` |

### Core Storage

| Feature | Location |
|---------|----------|
| SQLite Message Storage | `packages/app/lib/core/storage/message_storage.dart:L1-227` |
| Message Pagination | `packages/app/lib/core/storage/message_storage.dart:L100-137` |
| Message Status Tracking | `packages/app/lib/core/storage/message_storage.dart:L87-98` |
| Message Cleanup | `packages/app/lib/core/storage/message_storage.dart:L179-199` |
| Message Migration | `packages/app/lib/core/storage/message_storage.dart:L151-165` |
| Secure Peer Storage | `packages/app/lib/core/storage/trusted_peers_storage_impl.dart:L1-100` |
| Peer Lookup | `packages/app/lib/core/storage/trusted_peers_storage.dart:L15-66` |
| Peer Metadata | `packages/app/lib/core/storage/trusted_peers_storage.dart:L68-200` |
| File Receive Service | `packages/app/lib/core/storage/file_receive_service.dart` |

### Core Media

| Feature | Location |
|---------|----------|
| Media Access Control | `packages/app/lib/core/media/media_service.dart:L113-262` |
| Audio Processing | `packages/app/lib/core/media/media_service.dart:L136-175` |
| Device Management | `packages/app/lib/core/media/media_service.dart:L439-510` |
| Media Muting and Toggling | `packages/app/lib/core/media/media_service.dart:L264-305` |
| Camera Switching | `packages/app/lib/core/media/media_service.dart:L307-328` |
| Media Preferences | `packages/app/lib/core/media/media_service.dart:L143-175` |
| Background Blur Processing | `packages/app/lib/core/media/background_blur_processor.dart` |

### Core Notifications

| Feature | Location |
|---------|----------|
| Message Notifications | `packages/app/lib/core/notifications/notification_service.dart:L84-118` |
| Call Notifications | `packages/app/lib/core/notifications/notification_service.dart:L120-156` |
| Peer Status Notifications | `packages/app/lib/core/notifications/notification_service.dart:L158-190` |
| File Notifications | `packages/app/lib/core/notifications/notification_service.dart:L192-224` |
| DND and Settings | `packages/app/lib/core/notifications/notification_service.dart:L1-235` |
| Call Foreground Service | `packages/app/lib/core/notifications/call_foreground_service.dart` |

### Core Logging

| Feature | Location |
|---------|----------|
| File-Based Logging | `packages/app/lib/core/logging/logger_service.dart:L16-366` |
| Log Export | `packages/app/lib/core/logging/logger_service.dart:L285-336` |
| Real-time Log Streaming | `packages/app/lib/core/logging/logger_service.dart:L44-48` |
| Configurable Log Levels | `packages/app/lib/core/logging/logger_service.dart:L29-145` |

### Core Configuration

| Feature | Location |
|---------|----------|
| Environment Variables | `packages/app/lib/core/config/environment.dart:L1-100` |
| Build Token | `packages/app/lib/core/config/environment.dart:L62-70` |
| E2E Test Mode | `packages/app/lib/core/config/environment.dart:L72-75` |
| Cryptographic Constants | `packages/app/lib/core/constants.dart:L10-26` |
| File Transfer Constants | `packages/app/lib/core/constants.dart:L32-41` |
| WebRTC Constants | `packages/app/lib/core/constants.dart:L60-85` |
| Call Constants | `packages/app/lib/core/constants.dart:L92-114` |
| Signaling Constants | `packages/app/lib/core/constants.dart:L47-53` |

### Core Models

| Feature | Location |
|---------|----------|
| Peer Model | `packages/app/lib/core/models/peer.dart:L1-87` |
| Message Model | `packages/app/lib/core/models/message.dart:L1-113` |
| Notification Settings | `packages/app/lib/core/models/notification_settings.dart` |
| Media Device Model | `packages/app/lib/core/models/media_device.dart` |
| Linked Device Model | `packages/app/lib/core/models/linked_device.dart` |
| Meeting Points | `packages/app/lib/core/network/meeting_points.dart:L1-104` |

### Core Providers

| Feature | Location |
|---------|----------|
| Provider Configuration | `packages/app/lib/core/providers/app_providers.dart` |

---

## Server

### Core Routing & API

| Feature | Location |
|---------|----------|
| Request Dispatcher | `packages/server/src/index.js:L24-145` |
| CORS Headers | `packages/server/src/index.js:L28-33` |
| Health Check Endpoint | `packages/server/src/index.js:L41-55` |
| API Information Endpoint | `packages/server/src/index.js:L58-85` |
| Signed Bootstrap Response | `packages/server/src/index.js:L88-115` |

### WebSocket Signaling

| Feature | Location |
|---------|----------|
| Signaling Room | `packages/server/src/signaling-room.js:L1-202` |
| Pairing Code Registration | `packages/server/src/signaling-room.js:L83-120` |
| Signaling Message Forwarding | `packages/server/src/signaling-room.js:L122-158` |
| Peer Join/Leave Notifications | `packages/server/src/signaling-room.js:L160-190` |
| WebSocket Error Handling | `packages/server/src/signaling-room.js:L35-58` |

### Relay Registry

| Feature | Location |
|---------|----------|
| Relay Peer Registration | `packages/server/src/relay-registry.js:L22-34` |
| Load Tracking | `packages/server/src/relay-registry.js:L50-56` |
| Available Relay Selection | `packages/server/src/relay-registry.js:L65-88` |
| Peer Unregistration | `packages/server/src/relay-registry.js:L94-96` |
| Registry Statistics | `packages/server/src/relay-registry.js:L110-131` |

### Rendezvous System

| Feature | Location |
|---------|----------|
| Daily Meeting Points with Dead Drops | `packages/server/src/rendezvous-registry.js:L37-74` |
| Hourly Token Live Matching | `packages/server/src/rendezvous-registry.js:L84-127` |
| Dead Drop Retrieval | `packages/server/src/rendezvous-registry.js:L37-73` |
| Live Match Notification | `packages/server/src/rendezvous-registry.js:L107-109` |
| Peer Unregistration | `packages/server/src/rendezvous-registry.js:L171-191` |
| Expiration Cleanup | `packages/server/src/rendezvous-registry.js:L143-165` |
| Registry Statistics | `packages/server/src/rendezvous-registry.js:L197-216` |

### Chunk Distribution System

| Feature | Location |
|---------|----------|
| Chunk Source Announcement | `packages/server/src/chunk-index.js:L65-96` |
| Chunk Source Tracking | `packages/server/src/chunk-index.js:L104-122` |
| Chunk Cache Management | `packages/server/src/chunk-index.js:L135-169` |
| Cached Chunk Retrieval | `packages/server/src/chunk-index.js:L177-204` |
| Pending Request Management | `packages/server/src/chunk-index.js:L219-262` |
| Peer Chunk Cleanup | `packages/server/src/chunk-index.js:L273-292` |
| Chunk Index Cleanup | `packages/server/src/chunk-index.js:L301-327` |
| Chunk Index Statistics | `packages/server/src/chunk-index.js:L338-355` |

### WebSocket Message Handler

| Feature | Location |
|---------|----------|
| Message Type Dispatcher | `packages/server/src/websocket-handler.js:L52-104` |
| Peer Registration Handler | `packages/server/src/websocket-handler.js:L111-136` |
| Load Update Handler | `packages/server/src/websocket-handler.js:L143-153` |
| Rendezvous Registration Handler | `packages/server/src/websocket-handler.js:L160-187` |
| Get Relays Handler | `packages/server/src/websocket-handler.js:L194-203` |
| Ping/Pong Handler | `packages/server/src/websocket-handler.js:L93-95` |
| Heartbeat Handler | `packages/server/src/websocket-handler.js:L210-223` |
| Chunk Announce Handler | `packages/server/src/websocket-handler.js:L235-272` |
| Chunk Request Handler | `packages/server/src/websocket-handler.js:L280-338` |
| Chunk Push Handler | `packages/server/src/websocket-handler.js:L347-388` |
| Peer Disconnect Handler | `packages/server/src/websocket-handler.js:L395-411` |

### Durable Objects

| Feature | Location |
|---------|----------|
| Relay Registry Durable Object | `packages/server/src/durable-objects/relay-registry-do.js:L13-44` |
| Periodic Cleanup Alarm | `packages/server/src/durable-objects/relay-registry-do.js:L50-57` |
| HTTP Stats Endpoint | `packages/server/src/durable-objects/relay-registry-do.js:L66-75` |
| WebSocket Upgrade | `packages/server/src/durable-objects/relay-registry-do.js:L62-93` |

### Server Bootstrap Registry

| Feature | Location |
|---------|----------|
| Server Registration | `packages/server/src/durable-objects/server-registry-do.js:L62-88` |
| Server Listing | `packages/server/src/durable-objects/server-registry-do.js:L90-111` |
| Server Unregistration | `packages/server/src/durable-objects/server-registry-do.js:L113-120` |
| Server Heartbeat | `packages/server/src/durable-objects/server-registry-do.js:L122-160` |

### Device Attestation

| Feature | Location |
|---------|----------|
| Device Registration | `packages/server/src/durable-objects/attestation-registry-do.js:L107-231` |
| Reference Binary Upload | `packages/server/src/durable-objects/attestation-registry-do.js:L239-304` |
| Attestation Challenge Generation | `packages/server/src/durable-objects/attestation-registry-do.js:L311-381` |
| Challenge Verification | `packages/server/src/durable-objects/attestation-registry-do.js:L388-522` |
| Version Policy Management | `packages/server/src/durable-objects/attestation-registry-do.js:L528-578` |

### Cryptography

| Feature | Location |
|---------|----------|
| Ed25519 Signing Key Import | `packages/server/src/crypto/signing.js:L27-46` |
| Ed25519 Payload Signing | `packages/server/src/crypto/signing.js:L54-58` |
| Ed25519 Verification Key Import | `packages/server/src/crypto/attestation.js:L15-31` |
| Build Token Signature Verification | `packages/server/src/crypto/attestation.js:L86-90` |
| HMAC-SHA256 Computation | `packages/server/src/crypto/attestation.js:L122-133` |
| Nonce Generation | `packages/server/src/crypto/attestation.js:L109-113` |
| Session Token Creation | `packages/server/src/crypto/attestation.js:L141-146` |
| Session Token Verification | `packages/server/src/crypto/attestation.js:L154-174` |
| Semver Version Comparison | `packages/server/src/crypto/attestation.js:L182-193` |

### Logging

| Feature | Location |
|---------|----------|
| Environment-Aware Logger | `packages/server/src/logger.js:L39-135` |
| Pairing Code Redaction | `packages/server/src/logger.js:L19-22` |

### Configuration & Deployment

| Feature | Location |
|---------|----------|
| Wrangler Configuration | `packages/server/wrangler.jsonc:L1-76` |
| Custom Domain Routes | `packages/server/wrangler.jsonc:L45-47` |
| Environment Configuration | `packages/server/wrangler.jsonc:L56-75` |
| Durable Object Migrations | `packages/server/wrangler.jsonc:L24-42` |

### Testing

| Feature | Location |
|---------|----------|
| WebSocket Handler Tests | `packages/server/src/__tests__/websocket-handler.test.js:L1-438` |
| Relay Registry Tests | `packages/server/src/__tests__/relay-registry.test.js:L1-236` |
| Rendezvous Registry Tests | `packages/server/src/__tests__/rendezvous-registry.test.js:L1-454` |
| Chunk Index Tests | `packages/server/src/__tests__/chunk-index.test.js:L1-332` |
| WebSocket Chunk Handler Tests | `packages/server/src/__tests__/websocket-handler-chunks.test.js:L1-612` |

---

## Website

### Landing Page

| Feature | Location |
|---------|----------|
| Hero Section | `packages/website/app/routes/home.tsx:L97-117` |
| Features Section | `packages/website/app/routes/home.tsx:L119-171` |
| Downloads Section | `packages/website/app/routes/home.tsx:L173-213` |
| App Store Badges Section | `packages/website/app/routes/home.tsx:L215-237` |
| Platform Detection | `packages/website/app/routes/home.tsx:L51-96` |
| Dynamic Release Integration | `packages/website/app/routes/home.tsx:L24-95` |

### User Guide

| Feature | Location |
|---------|----------|
| Getting Started Section | `packages/website/app/routes/guide.tsx:L47-72` |
| Automatic Peer Discovery | `packages/website/app/routes/guide.tsx:L75-85` |
| Connecting to Peers | `packages/website/app/routes/guide.tsx:L86-111` |
| Sending Messages | `packages/website/app/routes/guide.tsx:L112-123` |
| File Sharing | `packages/website/app/routes/guide.tsx:L124-131` |
| Display Name Configuration | `packages/website/app/routes/guide.tsx:L133-141` |
| User Blocking | `packages/website/app/routes/guide.tsx:L142-153` |
| Troubleshooting Section | `packages/website/app/routes/guide.tsx:L154-196` |
| Security Documentation | `packages/website/app/routes/guide.tsx:L197-229` |
| FAQ Section | `packages/website/app/routes/guide.tsx:L230-263` |
| Table of Contents Navigation | `packages/website/app/routes/guide.tsx:L25-45` |

### Navigation & Layout

| Feature | Location |
|---------|----------|
| Logo and Navigation Bar | `packages/website/app/components/Nav.tsx:L1-23` |
| Footer Links | `packages/website/app/components/Footer.tsx:L1-35` |
| Color Theme and Design System | `packages/website/app/styles/global.css:L1-12` |
| Responsive Design | `packages/website/app/styles/global.css:L427-452` |
| React Router Configuration | `packages/website/react-router.config.ts:L1-5` |
| Vite Build Configuration | `packages/website/vite.config.ts:L1-12` |
| Cloudflare Pages Deployment | `packages/website/wrangler.jsonc:L1-24` |
| Development and Build Commands | `packages/website/package.json:L6-12` |
