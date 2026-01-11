# Issue #34: File Transfer Status Incorrect

## Summary

The file transfer status incorrectly uses `'receiving'` for both sending and receiving files, which is confusing to users. The `FileTransfer` type already defines a `'sending'` status, but it is not being used.

## Analysis

### Current Behavior

In `/home/meywd/zajel/packages/web-client/src/App.tsx`:

**Line 166 - Receiving files (correct):**
```typescript
status: 'receiving' as const,
```

**Line 358 - Sending files (INCORRECT):**
```typescript
status: 'receiving' as const,
```

Both sending and receiving operations use `'receiving'` status, making it impossible for users to distinguish whether they are uploading or downloading a file.

### Type Definition

The `FileTransfer` type in `/home/meywd/zajel/packages/web-client/src/lib/protocol.ts` (lines 187-196) already supports the correct statuses:

```typescript
export interface FileTransfer {
  id: string;
  fileName: string;
  totalSize: number;
  totalChunks: number;
  receivedChunks: number;
  status: 'receiving' | 'sending' | 'complete' | 'failed';
  error?: string;
  data?: Uint8Array[];
}
```

The `'sending'` status is already defined but not utilized.

### UI Display

In `/home/meywd/zajel/packages/web-client/src/components/FileTransfer.tsx` (lines 116-120), the status display does not differentiate between sending and receiving:

```typescript
{transfer.status === 'complete'
  ? 'Complete'
  : transfer.status === 'failed'
    ? transfer.error || 'Transfer failed'
    : `${transfer.receivedChunks}/${transfer.totalChunks} chunks`}
```

## Proposed Fix

### 1. Fix status in App.tsx when sending files

**File:** `/home/meywd/zajel/packages/web-client/src/App.tsx`

**Location:** Line 358 (inside `handleSendFile` callback)

**Current code:**
```typescript
status: 'receiving' as const,
```

**Change to:**
```typescript
status: 'sending' as const,
```

### 2. Update UI to show sending/receiving status

**File:** `/home/meywd/zajel/packages/web-client/src/components/FileTransfer.tsx`

**Location:** Lines 116-120

**Current code:**
```typescript
{transfer.status === 'complete'
  ? 'Complete'
  : transfer.status === 'failed'
    ? transfer.error || 'Transfer failed'
    : `${transfer.receivedChunks}/${transfer.totalChunks} chunks`}
```

**Change to:**
```typescript
{transfer.status === 'complete'
  ? 'Complete'
  : transfer.status === 'failed'
    ? transfer.error || 'Transfer failed'
    : transfer.status === 'sending'
      ? `Sending: ${transfer.receivedChunks}/${transfer.totalChunks} chunks`
      : `Receiving: ${transfer.receivedChunks}/${transfer.totalChunks} chunks`}
```

## Complete Diff

### App.tsx

```diff
--- a/packages/web-client/src/App.tsx
+++ b/packages/web-client/src/App.tsx
@@ -355,7 +355,7 @@ export function App() {
           fileName: file.name,
           totalSize: file.size,
           totalChunks,
-          status: 'receiving' as const,
+          status: 'sending' as const,
         },
       ];
```

### FileTransfer.tsx

```diff
--- a/packages/web-client/src/components/FileTransfer.tsx
+++ b/packages/web-client/src/components/FileTransfer.tsx
@@ -113,7 +113,9 @@ export function FileTransfer({ transfers, onSendFile, onDismiss }: FileTransferP
           >
             {transfer.status === 'complete'
               ? 'Complete'
               : transfer.status === 'failed'
                 ? transfer.error || 'Transfer failed'
-                : `${transfer.receivedChunks}/${transfer.totalChunks} chunks`}
+                : transfer.status === 'sending'
+                  ? `Sending: ${transfer.receivedChunks}/${transfer.totalChunks} chunks`
+                  : `Receiving: ${transfer.receivedChunks}/${transfer.totalChunks} chunks`}
           </div>
```

## Impact

- **Low risk**: The change is straightforward and only affects UI display
- **No breaking changes**: The `'sending'` status is already part of the type definition
- **User experience improvement**: Users can now clearly see whether they are sending or receiving a file

## Testing

1. Connect two clients
2. Send a file from client A to client B
3. Verify client A shows "Sending: X/Y chunks"
4. Verify client B shows "Receiving: X/Y chunks"
5. Verify both show "Complete" when transfer finishes

## Research: How Other Apps Solve This

This section documents how major messaging applications handle file transfer status and state management, providing insights for improving Zajel's implementation.

### Signal

Signal uses a comprehensive transfer state system with clear numeric constants:

**Transfer Progress States** (from [Signal-Android source code](https://github.com/signalapp/Signal-Android)):
```kotlin
const val TRANSFER_PROGRESS_DONE = 0
const val TRANSFER_PROGRESS_STARTED = 1
const val TRANSFER_PROGRESS_PENDING = 2
const val TRANSFER_PROGRESS_FAILED = 3
const val TRANSFER_PROGRESS_PERMANENT_FAILURE = 4
const val TRANSFER_NEEDS_RESTORE = 5
const val TRANSFER_RESTORE_IN_PROGRESS = 6
const val TRANSFER_RESTORE_OFFLOADED = 7
```

**Archive Transfer State Enum**:
```kotlin
enum class ArchiveTransferState {
  NONE,
  COPY_PENDING,
  UPLOAD_IN_PROGRESS,
  TEMPORARY_FAILURE,
  FINISHED,
  PERMANENT_FAILURE
}
```

**Key Patterns**:
- Distinguishes between temporary and permanent failures
- Has a "pending" state before transfer starts
- Separates "done/finished" from in-progress states
- Uses numeric constants for database storage efficiency
- Users see visual indicators: spinning circle during upload, dotted circle during transfer
- Failed messages show red exclamation mark with "Not delivered" and "Tap for details"

**Known Issues** (from [Signal GitHub Issues](https://github.com/signalapp/Signal-Android/issues)):
- Users report messages can get stuck in sending state indefinitely
- No automatic retry for failed attachment downloads was a past complaint
- Large attachments can block subsequent messages

### Telegram

Telegram uses a simpler state model focused on delivery rather than transfer progress.

**Message Status Indicators** (from [Telegram FAQ](https://telegram.org/faq)):

| Icon | State | Meaning |
|------|-------|---------|
| Clock | Pending/Sending | Message is being sent to server |
| Single checkmark | Sent | Message delivered to Telegram cloud |
| Double checkmark | Read | Recipient has opened and read the message |
| Exclamation mark | Failed | Failed to connect to server within 5 minutes |

**Key Differences from Other Apps**:
- No "delivered to device" state (unlike WhatsApp) because Telegram supports multiple devices simultaneously
- Simpler model: Pending -> Sent -> Read
- Error state shows after 5-minute timeout

**File Upload API** (from [Telegram Core API](https://core.telegram.org/api/files)):
- Supports streamed uploads for unknown file sizes
- Uses `upload.saveBigFilePart` with part tracking
- TDLib provides `downloadFile` function with `updateFile` callbacks for progress
- Progress tracking includes: part ID, part size, uploaded bytes, total size

**Bot API Actions**:
- `upload_photo`, `upload_video`, `upload_document` actions show typing indicator
- Provides visual feedback during long uploads

### WhatsApp

WhatsApp uses a well-known checkmark system for message status.

**Message Status Indicators** (from [WhatsApp FAQ](https://faq.whatsapp.com/665923838265756)):

| Icon | State | Meaning |
|------|-------|---------|
| Clock | Pending | Message not sent yet (poor connection) |
| Single gray checkmark | Sent | Message sent but not delivered |
| Double gray checkmarks | Delivered | Message delivered to recipient's device |
| Double blue checkmarks | Read | Message has been read |

**Group Chat Behavior**:
- Double gray checkmarks appear when ALL members receive the message
- Double blue checkmarks appear when ALL members have read it

**Media Transfer Handling**:
- Large media files are automatically segmented for upload
- HD uploads take up to 6x longer
- Video status limited to 30-second clips
- Compression applied to reduce bandwidth

**Key UX Pattern**:
- Status details accessible by tap-and-hold -> "Info"
- Shows exact delivery and read timestamps
- Read receipts can be disabled by users

### Slack

Slack uses an asynchronous upload model with clear state transitions.

**Upload States** (from [Slack Developer Docs](https://docs.slack.dev/messaging/working-with-files/)):

1. **Uploading** - File being transferred to Slack servers
2. **Processing** - Security scan and processing in progress (asynchronous)
3. **Uploaded** - File hosted but not shared
4. **Shared** - File visible in channel
5. **Failed** - Upload or processing failed

**Key Patterns**:
- New upload API (`files.getUploadURLExternal` + `files.completeUploadExternal`) is asynchronous
- Processing (virus scanning, etc.) continues after upload completes
- Files are private until explicitly shared
- Clear distinction between "uploaded" and "shared" states

**Error Handling**:
- Files scanned for viruses; infected files rejected
- 1GB max file size
- Specific error messages for different failure types

### Discord

Discord provides basic upload feedback with retry capabilities.

**Upload States** (from [Discord Support](https://support.discord.com/)):

1. **Uploading** - Progress wheel visible, "Uploading" toast notification
2. **Upload Failed** - Red alert with retry option
3. **Completed** - File appears in message

**Key Patterns**:
- Visual progress bar fills during upload
- "Upload Failed" with "Click here to retry" option
- 8MB limit for free users, 100MB for Nitro subscribers

**Common Failure Causes**:
- File size exceeds limit
- Server issues
- Network problems
- Corrupted/empty files
- Content filtering (SFW channels)

### AWS SDK TransferState (Industry Standard)

The AWS SDK provides a comprehensive [TransferState enum](https://aws-amplify.github.io/aws-sdk-android/docs/reference/com/amazonaws/mobileconnectors/s3/transferutility/TransferState.html) that serves as an industry reference:

```java
enum TransferState {
  WAITING,                    // Queued, not started
  IN_PROGRESS,                // Actively transferring
  PAUSED,                     // Paused by user
  RESUMED_WAITING,            // Resumed, queued for execution
  COMPLETED,                  // Successfully finished
  CANCELED,                   // Canceled by user
  FAILED,                     // Transfer failed
  WAITING_FOR_NETWORK,        // On hold, waiting for network
  PART_COMPLETED,             // Multi-part upload part done
  PENDING_CANCEL,             // Cancel requested, pending
  PENDING_PAUSE,              // Pause requested, pending
  PENDING_NETWORK_DISCONNECT, // Network lost, pause pending
  UNKNOWN                     // Unknown/error state
}
```

**Key Patterns**:
- Separate states for different phases (waiting, in-progress, completed)
- Network-aware states (WAITING_FOR_NETWORK)
- Pending states for async operations (PENDING_CANCEL, PENDING_PAUSE)
- Multi-part upload support (PART_COMPLETED)
- Clear distinction between CANCELED (user action) and FAILED (error)

### UI/UX Best Practices

Based on research from [Uploadcare](https://uploadcare.com/blog/file-uploader-ux-best-practices/), [Telerik Design System](https://www.telerik.com/design-system/docs/components/upload/usage/), and [Cieden Progress Indicators](https://cieden.com/book/atoms/progress-indicator/progress-indicator-ui):

#### Progress Indicator Selection by Wait Time

| Duration | Recommended Indicator |
|----------|----------------------|
| < 1 second | None (instant feedback) |
| 1-3 seconds | Indeterminate (spinner, skeleton) |
| 3-10 seconds | Determinate progress bar with percentage |
| 10+ seconds | Progress bar + time estimate |

#### Essential Elements

1. **Visual Progress**: Real-time progress bar or percentage
2. **Time Estimates**: Show estimated completion time for large files
3. **File Preview**: Thumbnail to verify correct file selected
4. **Cancel Option**: Allow users to abort transfers
5. **Pause/Resume**: For large file transfers

#### Error Handling Best Practices

1. **Specific Error Messages**: "File size exceeds 5MB limit" not "Upload failed"
2. **Pre-validation**: Check file type/size before upload starts
3. **Retry Options**: Clear retry button for failed transfers
4. **Graceful Degradation**: Guide users on how to resolve issues

#### Hybrid Indicators

Combine multiple feedback types for clarity:
- Progress bar + percentage label
- Visual indicator + time remaining
- Status text + icon

### Recommended State Model for Zajel

Based on this research, a more comprehensive state model could be:

```typescript
type FileTransferStatus =
  // Outgoing (sending)
  | 'pending_send'      // Queued for sending
  | 'sending'           // Actively uploading
  | 'sent'              // Uploaded, waiting for confirmation

  // Incoming (receiving)
  | 'pending_receive'   // Download queued
  | 'receiving'         // Actively downloading
  | 'received'          // Download complete

  // Terminal states
  | 'complete'          // Transfer fully complete
  | 'failed'            // Transfer failed (retryable)
  | 'canceled'          // User canceled
  | 'expired';          // Transfer expired/unavailable
```

### Naming Convention Recommendations

| Current | Industry Standard Alternative |
|---------|------------------------------|
| `'receiving'` | `'downloading'` or `'receiving'` |
| `'sending'` | `'uploading'` or `'sending'` |
| `'complete'` | `'completed'` or `'finished'` |
| `'failed'` | `'failed'` or `'error'` |

**Common Patterns Observed**:
- Use gerund (-ing) for in-progress states: uploading, downloading, sending
- Use past tense for completed states: completed, delivered, read
- Use descriptive nouns for waiting states: pending, queued, waiting
- Separate user actions from errors: canceled vs failed

### Sources

- [Signal iOS GitHub - Progress indicator issue](https://github.com/signalapp/Signal-iOS/issues/440)
- [Signal Android GitHub - Retry sending issue](https://github.com/signalapp/Signal-Android/issues/7888)
- [Signal Support - Troubleshooting sending messages](https://support.signal.org/hc/en-us/articles/360009303072-Troubleshooting-sending-messages)
- [Telegram Core API - Files](https://core.telegram.org/api/files)
- [Telegram FAQ](https://telegram.org/faq)
- [WhatsApp FAQ - Check marks](https://faq.whatsapp.com/665923838265756)
- [Android Authority - WhatsApp checkmarks](https://www.androidauthority.com/whatsapp-checkmarks-3077273/)
- [Slack Developer Docs - Working with files](https://docs.slack.dev/messaging/working-with-files/)
- [Discord Support - Upload Failed](https://support.discord.com/hc/en-us/community/posts/360032406112-Upload-Failed-Click-Here-to-retry-the-upload-Will-not-let-me-upload)
- [AWS SDK Android - TransferState](https://aws-amplify.github.io/aws-sdk-android/docs/reference/com/amazonaws/mobileconnectors/s3/transferutility/TransferState.html)
- [Uploadcare - File uploader UX best practices](https://uploadcare.com/blog/file-uploader-ux-best-practices/)
- [Telerik - Upload component usage guidelines](https://www.telerik.com/design-system/docs/components/upload/usage/)
- [Cieden - Progress indicator UI](https://cieden.com/book/atoms/progress-indicator/progress-indicator-ui/)
