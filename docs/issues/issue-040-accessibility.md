# Issue #40: Accessibility Audit and Recommendations

## Overview

This document provides a comprehensive accessibility audit of all components in the Zajel web client. The audit identifies missing ARIA attributes, keyboard navigation issues, and screen reader support gaps, along with specific recommendations for each component.

---

## Executive Summary

| Component | Severity | Issues Found |
|-----------|----------|--------------|
| MyCode.tsx | High | 5 issues |
| EnterCode.tsx | Critical | 7 issues |
| ApprovalRequest.tsx | High | 6 issues |
| PendingApproval.tsx | Medium | 4 issues |
| ChatView.tsx | Critical | 9 issues |
| StatusIndicator.tsx | Medium | 3 issues |
| KeyChangeWarning.tsx | High | 7 issues |
| FileTransfer.tsx | Critical | 10 issues |

**Total Issues: 51**

---

## Component-by-Component Audit

### 1. MyCode.tsx

**File:** `/home/meywd/zajel/packages/web-client/src/components/MyCode.tsx`

#### Current Issues

1. **Missing landmark role** (Line 19)
   - The card div lacks a semantic role
   - Screen readers cannot identify this as a distinct region

2. **Code display not accessible** (Lines 21-26)
   - Individual characters in divs are not announced as a cohesive code
   - No `aria-label` describing the full code
   - Screen readers will read each character separately without context

3. **Copy button lacks proper feedback** (Lines 28-30)
   - No `aria-live` region to announce copy success
   - Button state change not communicated to assistive technology

4. **Missing heading hierarchy context** (Line 20)
   - `<h2>` may not fit page hierarchy
   - No `aria-labelledby` connection to the card region

5. **No keyboard instructions**
   - Users don't know they can copy with keyboard

#### Recommendations

```tsx
// Line 19: Add region role and labelling
<div class="card" role="region" aria-labelledby="my-code-heading">
  <h2 id="my-code-heading">Your Code</h2>

  {/* Lines 21-26: Add accessible code display */}
  <div
    class="code-display"
    role="group"
    aria-label={`Your connection code is ${code.split('').join(' ')}`}
  >
    {chars.map((char, i) => (
      <div key={i} class="char" aria-hidden="true">
        {char}
      </div>
    ))}
  </div>

  {/* Add screen-reader only full code */}
  <span class="sr-only">Your code is {code}</span>

  {/* Lines 28-30: Add aria-live for copy feedback */}
  <button
    class="copy-btn"
    onClick={handleCopy}
    aria-label={copied ? 'Code copied to clipboard' : 'Copy code to clipboard'}
  >
    {copied ? 'Copied!' : 'Copy Code'}
  </button>
  <div aria-live="polite" class="sr-only">
    {copied && 'Code copied to clipboard'}
  </div>
</div>
```

---

### 2. EnterCode.tsx

**File:** `/home/meywd/zajel/packages/web-client/src/components/EnterCode.tsx`

#### Current Issues

1. **Input fields lack labels** (Lines 82-91)
   - No `aria-label` or associated `<label>` elements
   - Screen readers cannot identify what each input is for

2. **No instructions for input format**
   - Users don't know inputs are for a 6-character code
   - No `aria-describedby` linking to instructions

3. **No group labeling** (Line 80)
   - The code-input container lacks `role="group"` with proper label

4. **Paste functionality not announced**
   - No feedback when code is pasted

5. **Auto-focus behavior not communicated**
   - Moving to next input on character entry confuses screen reader users

6. **Connect button lacks loading state** (Lines 94-100)
   - No `aria-busy` or `aria-disabled` feedback

7. **Missing field requirements**
   - No `aria-required` on inputs
   - No error states or validation messages

#### Recommendations

```tsx
// Lines 77-102: Full accessible implementation
<div class="card" role="region" aria-labelledby="enter-code-heading">
  <h2 id="enter-code-heading">Peer's Code</h2>
  <p id="code-instructions" class="sr-only">
    Enter the 6-character code from your peer. Characters will auto-advance.
  </p>

  <div
    class="code-input"
    onPaste={handlePaste}
    role="group"
    aria-labelledby="enter-code-heading"
    aria-describedby="code-instructions"
  >
    {chars.map((char, i) => (
      <input
        key={i}
        ref={(el) => (inputRefs.current[i] = el)}
        type="text"
        inputMode="text"
        maxLength={1}
        value={char}
        onInput={(e) => handleInput(i, (e.target as HTMLInputElement).value)}
        onKeyDown={(e) => handleKeyDown(i, e)}
        disabled={disabled}
        aria-label={`Character ${i + 1} of 6`}
        aria-required="true"
        autoComplete="off"
        autoCapitalize="characters"
      />
    ))}
  </div>

  {/* Live region for paste/progress feedback */}
  <div aria-live="polite" class="sr-only">
    {chars.filter(c => c).length} of 6 characters entered
  </div>

  <button
    class="btn btn-primary"
    onClick={handleConnect}
    disabled={!isComplete || disabled}
    aria-disabled={!isComplete || disabled}
    aria-busy={disabled}
  >
    {disabled ? 'Connecting...' : 'Connect'}
  </button>
</div>
```

---

### 3. ApprovalRequest.tsx

**File:** `/home/meywd/zajel/packages/web-client/src/components/ApprovalRequest.tsx`

#### Current Issues

1. **Modal lacks proper role** (Line 9)
   - No `role="dialog"` or `role="alertdialog"`
   - No `aria-modal="true"`

2. **Missing focus management**
   - Focus not trapped within modal
   - No auto-focus on first actionable element

3. **No escape key handling**
   - Cannot dismiss with keyboard

4. **Buttons lack descriptive labels** (Lines 16-21)
   - "Accept" and "Reject" don't specify what action they perform

5. **Overlay not announced**
   - Screen readers don't know this is urgent/blocking content

6. **Missing labelledby/describedby**
   - Dialog not associated with its heading or description

#### Recommendations

```tsx
// Full accessible modal implementation
export function ApprovalRequest({ peerCode, onAccept, onReject }: ApprovalRequestProps) {
  const acceptRef = useRef<HTMLButtonElement>(null);

  // Focus first button on mount
  useEffect(() => {
    acceptRef.current?.focus();
  }, []);

  // Handle Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onReject();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onReject]);

  return (
    <div
      class="approval-overlay"
      role="presentation"
      aria-hidden="true"
    >
      <div
        class="approval-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-desc"
      >
        <h3 id="approval-title">Connection Request</h3>
        <p id="approval-desc">
          <span class="code" aria-label={`Peer code ${peerCode}`}>{peerCode}</span> wants to connect
        </p>
        <div class="btn-row" role="group" aria-label="Connection decision">
          <button
            ref={acceptRef}
            class="btn btn-success"
            onClick={onAccept}
            aria-label={`Accept connection from ${peerCode}`}
          >
            Accept
          </button>
          <button
            class="btn btn-danger"
            onClick={onReject}
            aria-label={`Reject connection from ${peerCode}`}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

### 4. PendingApproval.tsx

**File:** `/home/meywd/zajel/packages/web-client/src/components/PendingApproval.tsx`

#### Current Issues

1. **Spinner lacks accessible label** (Line 10)
   - No `role="status"` or `aria-label`
   - Animation not described

2. **Loading state not announced**
   - No `aria-live` to announce waiting status

3. **Cancel button context unclear** (Lines 12-14)
   - What is being canceled?

4. **No progress indication**
   - Screen reader users don't know connection is pending

#### Recommendations

```tsx
export function PendingApproval({ peerCode, onCancel }: PendingApprovalProps) {
  return (
    <div class="card" role="region" aria-labelledby="pending-heading">
      <div class="loading-state" aria-live="polite">
        <div
          class="spinner"
          role="status"
          aria-label="Loading"
        >
          <span class="sr-only">Waiting for connection approval</span>
        </div>
        <p id="pending-heading">
          Waiting for <span aria-label={`peer ${peerCode}`}>{peerCode}</span> to accept...
        </p>
        <button
          class="btn btn-secondary btn-sm"
          onClick={onCancel}
          aria-label={`Cancel connection request to ${peerCode}`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
```

---

### 5. ChatView.tsx

**File:** `/home/meywd/zajel/packages/web-client/src/components/ChatView.tsx`

#### Current Issues

1. **Messages not in semantic list** (Lines 51-58)
   - No `<ul>`/`<li>` or `role="list"`/`role="listitem"`

2. **New messages not announced**
   - No `aria-live` region for incoming messages
   - Screen reader users miss new messages

3. **Message sender not clear** (Lines 53-55)
   - Visual differentiation via CSS only
   - No aria-label indicating "You said" vs "They said"

4. **Input lacks label** (Lines 61-67)
   - Placeholder is not sufficient for accessibility
   - No associated `<label>` element

5. **File button lacks context** (Lines 68-70)
   - "+" is not descriptive
   - `title` alone is insufficient

6. **Send button lacks accessible name** (Lines 71-75)
   - SVG icon only, no text alternative

7. **Disconnect button context** (Lines 46-48)
   - Doesn't specify what will be disconnected

8. **Form lacks proper labeling** (Line 60)
   - No `aria-label` on form

9. **Auto-scroll behavior** (Lines 22-24)
   - May be disorienting for screen reader users

#### Recommendations

```tsx
export function ChatView({
  peerCode,
  messages,
  onSendMessage,
  onDisconnect,
  onSelectFile,
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputId = 'chat-message-input';

  // ... existing logic ...

  return (
    <div class="chat-container" role="main" aria-label={`Chat with ${peerCode}`}>
      <header class="chat-header">
        <h2 id="chat-peer">{peerCode}</h2>
        <button
          class="btn btn-danger btn-sm"
          onClick={onDisconnect}
          aria-label={`Disconnect from ${peerCode}`}
        >
          Disconnect
        </button>
      </header>

      {/* Messages with live region for new messages */}
      <div
        class="messages"
        role="log"
        aria-label="Message history"
        aria-live="polite"
        aria-relevant="additions"
      >
        <ul role="list" aria-label="Chat messages">
          {messages.map((msg) => (
            <li
              key={msg.id}
              class={`message ${msg.sender === 'me' ? 'sent' : 'received'}`}
              role="listitem"
              aria-label={`${msg.sender === 'me' ? 'You' : peerCode} said: ${msg.content}`}
            >
              <span class="sr-only">{msg.sender === 'me' ? 'You' : peerCode}:</span>
              {msg.content}
            </li>
          ))}
        </ul>
        <div ref={messagesEndRef} />
      </div>

      <form
        class="chat-input"
        onSubmit={handleSubmit}
        aria-label="Send a message"
      >
        <label for={inputId} class="sr-only">Type a message</label>
        <input
          id={inputId}
          type="text"
          placeholder="Type a message..."
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
          aria-label="Message input"
        />
        <button
          type="button"
          class="btn btn-secondary"
          onClick={onSelectFile}
          aria-label="Attach and send a file"
        >
          <span aria-hidden="true">+</span>
          <span class="sr-only">Attach file</span>
        </button>
        <button
          type="submit"
          aria-label="Send message"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
          <span class="sr-only">Send</span>
        </button>
      </form>
    </div>
  );
}
```

---

### 6. StatusIndicator.tsx

**File:** `/home/meywd/zajel/packages/web-client/src/components/StatusIndicator.tsx`

#### Current Issues

1. **Colored dot conveys meaning visually only** (Lines 32-35)
   - Color alone is not accessible
   - No text alternative for the dot state

2. **Status changes not announced**
   - No `aria-live` for state transitions

3. **Dot element provides no semantic value** (Line 34)
   - `<span class={dotClass} />` is purely decorative but conveys meaning

#### Recommendations

```tsx
export function StatusIndicator({ state }: StatusIndicatorProps) {
  const isConnected = state === 'connected';
  const isConnecting =
    state === 'connecting' ||
    state === 'pairing' ||
    state === 'webrtc_connecting' ||
    state === 'handshaking';

  let dotClass = 'dot';
  if (isConnected) dotClass += ' connected';
  else if (isConnecting) dotClass += ' connecting';

  return (
    <div
      class="status-indicator"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span
        class={dotClass}
        aria-hidden="true"
        role="presentation"
      />
      <span>
        {stateLabels[state]}
        <span class="sr-only">
          {isConnected && ' - secure connection established'}
          {isConnecting && ' - please wait'}
        </span>
      </span>
    </div>
  );
}
```

---

### 7. KeyChangeWarning.tsx

**File:** `/home/meywd/zajel/packages/web-client/src/components/KeyChangeWarning.tsx`

#### Current Issues

1. **Modal lacks proper ARIA roles** (Lines 16-17)
   - No `role="alertdialog"`
   - No `aria-modal="true"`

2. **Critical security warning not properly announced**
   - Should use `aria-live="assertive"`
   - Role should indicate urgency

3. **Fingerprints not accessible** (Lines 31-61)
   - Long code blocks with inline styles
   - No semantic structure or labels

4. **Focus management missing**
   - Focus not trapped in modal
   - No escape key handling

5. **Button colors convey meaning** (Lines 68-73)
   - Danger/warning colors not sufficient alone

6. **No skip mechanism for long fingerprints**
   - Screen readers must read entire fingerprints

7. **Missing landmark structure**
   - Instructions section not marked up

#### Recommendations

```tsx
export function KeyChangeWarning({
  peerCode,
  oldFingerprint,
  newFingerprint,
  onAccept,
  onDisconnect,
}: KeyChangeWarningProps) {
  const disconnectRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    disconnectRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDisconnect();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onDisconnect]);

  return (
    <div class="approval-overlay" role="presentation">
      <div
        class="approval-dialog"
        style={{ maxWidth: '400px' }}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="warning-title"
        aria-describedby="warning-desc"
      >
        <h3
          id="warning-title"
          style={{ color: 'var(--error, #ef4444)' }}
        >
          Security Warning
        </h3>

        <div id="warning-desc">
          <p style={{ marginBottom: '12px' }}>
            The key for <span class="code" aria-label={`peer ${peerCode}`}>{peerCode}</span> has changed!
          </p>
          <p style={{ fontSize: '14px', marginBottom: '12px', opacity: 0.9 }}>
            This could indicate a man-in-the-middle attack, or the peer may have
            reinstalled the app or cleared their data.
          </p>
        </div>

        <div role="group" aria-label="Fingerprint comparison">
          <div style={{ marginBottom: '12px' }}>
            <strong
              id="old-fp-label"
              style={{ fontSize: '12px', display: 'block', marginBottom: '4px' }}
            >
              Previous Fingerprint:
            </strong>
            <code
              aria-labelledby="old-fp-label"
              tabIndex={0}
              style={{
                display: 'block',
                fontSize: '11px',
                wordBreak: 'break-all',
                background: 'rgba(239, 68, 68, 0.2)',
                padding: '6px',
                borderRadius: '4px',
                border: '1px solid rgba(239, 68, 68, 0.3)',
              }}
            >
              {oldFingerprint}
            </code>
          </div>
          <div style={{ marginBottom: '16px' }}>
            <strong
              id="new-fp-label"
              style={{ fontSize: '12px', display: 'block', marginBottom: '4px' }}
            >
              New Fingerprint:
            </strong>
            <code
              aria-labelledby="new-fp-label"
              tabIndex={0}
              style={{
                display: 'block',
                fontSize: '11px',
                wordBreak: 'break-all',
                background: 'rgba(34, 197, 94, 0.2)',
                padding: '6px',
                borderRadius: '4px',
                border: '1px solid rgba(34, 197, 94, 0.3)',
              }}
            >
              {newFingerprint}
            </code>
          </div>
        </div>

        <p style={{ fontSize: '12px', marginBottom: '16px', opacity: 0.8 }}>
          Verify with your peer through a trusted channel (voice call, in person)
          before accepting the new key.
        </p>

        <div class="btn-row" role="group" aria-label="Security decision actions">
          <button
            ref={disconnectRef}
            class="btn btn-danger"
            onClick={onDisconnect}
            aria-label="Disconnect - recommended for security"
          >
            Disconnect
          </button>
          <button
            class="btn"
            onClick={onAccept}
            style={{ background: 'var(--warning, #f59e0b)' }}
            aria-label="Accept new key - proceed with caution"
          >
            Accept New Key
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

### 8. FileTransfer.tsx

**File:** `/home/meywd/zajel/packages/web-client/src/components/FileTransfer.tsx`

#### Current Issues

1. **Drop zone not keyboard accessible** (Lines 60-66)
   - Only click/drag interactions
   - No keyboard-triggered file selection

2. **Hidden file input has no label** (Lines 67-72)
   - `style={{ display: 'none' }}` makes it inaccessible

3. **Drop zone lacks ARIA attributes**
   - No `role` or `aria-label`
   - Drag state not announced

4. **Progress bars not accessible** (Lines 100-108)
   - No `role="progressbar"`
   - No `aria-valuenow`, `aria-valuemin`, `aria-valuemax`

5. **Transfer status not announced**
   - No `aria-live` for progress updates

6. **Dismiss button lacks context** (Lines 87-98)
   - Which transfer is being dismissed?

7. **File size not read properly**
   - Format function output not labeled

8. **Error states not announced** (Lines 109-121)
   - Failed transfers need assertive announcement

9. **No keyboard instructions**
   - How to use drag/drop alternative

10. **Transfer list lacks semantic structure** (Lines 76-123)
    - Should be a list with proper roles

#### Recommendations

```tsx
export function FileTransfer({ transfers, onSendFile, onDismiss }: FileTransferProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = 'file-input';

  // ... existing handlers ...

  return (
    <div class="card" role="region" aria-labelledby="file-transfer-heading">
      <h2 id="file-transfer-heading">File Transfer</h2>

      {/* Accessible file drop zone */}
      <div
        class={`file-zone ${dragOver ? 'dragover' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="File upload area. Click or press Enter to select a file, or drag and drop a file here"
        aria-describedby="drop-instructions"
      >
        <label for={inputId} class="sr-only">Select file to send</label>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
          aria-describedby="drop-instructions"
        />
        <p id="drop-instructions">
          Drop a file here or click to select
          <span class="sr-only">. You can also press Enter or Space to open file selector.</span>
        </p>
      </div>

      {/* Announce drag state */}
      <div aria-live="polite" class="sr-only">
        {dragOver && 'File detected. Release to upload.'}
      </div>

      {/* Accessible transfer list */}
      {transfers.length > 0 && (
        <ul
          role="list"
          aria-label="File transfers"
          aria-live="polite"
        >
          {transfers.map((transfer) => (
            <li
              key={transfer.id}
              class="file-progress"
              style={transfer.status === 'failed' ? { borderColor: 'var(--error, #ef4444)' } : undefined}
              aria-label={`${transfer.fileName}, ${formatSize(transfer.totalSize)}, ${
                transfer.status === 'complete'
                  ? 'completed'
                  : transfer.status === 'failed'
                    ? 'failed'
                    : `${Math.round((transfer.receivedChunks / transfer.totalChunks) * 100)}% complete`
              }`}
            >
              <div class="name" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  {transfer.fileName} ({formatSize(transfer.totalSize)})
                </span>
                {transfer.status === 'failed' && (
                  <button
                    class="btn btn-sm"
                    style={{
                      background: 'var(--error, #ef4444)',
                      padding: '2px 8px',
                      fontSize: '11px',
                    }}
                    onClick={() => onDismiss(transfer.id)}
                    aria-label={`Dismiss failed transfer of ${transfer.fileName}`}
                  >
                    Dismiss
                  </button>
                )}
              </div>

              {/* Accessible progress bar */}
              <div
                class="bar"
                role="progressbar"
                aria-valuenow={Math.round((transfer.receivedChunks / transfer.totalChunks) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${transfer.fileName} transfer progress`}
              >
                <div
                  class="fill"
                  style={{
                    width: `${(transfer.receivedChunks / transfer.totalChunks) * 100}%`,
                    background: transfer.status === 'failed' ? 'var(--error, #ef4444)' : undefined,
                  }}
                />
              </div>

              <div
                style={{
                  fontSize: '12px',
                  color: transfer.status === 'failed' ? 'var(--error, #ef4444)' : 'var(--text-muted)',
                  marginTop: '4px',
                }}
                aria-live={transfer.status === 'failed' ? 'assertive' : undefined}
              >
                {transfer.status === 'complete'
                  ? 'Complete'
                  : transfer.status === 'failed'
                    ? transfer.error || 'Transfer failed'
                    : `${transfer.receivedChunks}/${transfer.totalChunks} chunks`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

---

## Global Accessibility Requirements

### 1. Screen Reader Only CSS Class

Add to global styles:

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.sr-only-focusable:focus {
  position: static;
  width: auto;
  height: auto;
  margin: 0;
  overflow: visible;
  clip: auto;
  white-space: normal;
}
```

### 2. Focus Management Utilities

Create a focus trap utility for modals:

```tsx
// utils/focusTrap.ts
export function useFocusTrap(ref: RefObject<HTMLElement>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return;

    const focusableElements = ref.current.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    firstElement?.focus();

    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [ref, active]);
}
```

### 3. Skip Links

Add skip link to main layout:

```tsx
<a href="#main-content" class="sr-only sr-only-focusable">
  Skip to main content
</a>
```

### 4. Announce Live Updates

Create a live announcer utility:

```tsx
// utils/announce.ts
let announcer: HTMLElement | null = null;

export function announce(message: string, priority: 'polite' | 'assertive' = 'polite') {
  if (!announcer) {
    announcer = document.createElement('div');
    announcer.setAttribute('aria-live', priority);
    announcer.setAttribute('aria-atomic', 'true');
    announcer.className = 'sr-only';
    document.body.appendChild(announcer);
  }

  announcer.setAttribute('aria-live', priority);
  announcer.textContent = '';

  // Small delay to ensure screen reader picks up change
  setTimeout(() => {
    if (announcer) announcer.textContent = message;
  }, 100);
}
```

---

## Testing Recommendations

### Manual Testing

1. **Keyboard Navigation**
   - Tab through all interactive elements
   - Verify focus is visible
   - Test Enter/Space activation
   - Test Escape for modals

2. **Screen Reader Testing**
   - Test with NVDA (Windows)
   - Test with VoiceOver (macOS/iOS)
   - Test with TalkBack (Android)

3. **Color Contrast**
   - Verify 4.5:1 contrast for text
   - Verify 3:1 contrast for interactive elements

### Automated Testing

Add accessibility tests using jest-axe:

```tsx
import { axe, toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

test('MyCode has no accessibility violations', async () => {
  const { container } = render(<MyCode code="ABC123" />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

---

## Priority Implementation Order

### Critical (Must Fix)

1. ChatView.tsx - Core messaging functionality
2. EnterCode.tsx - Essential for connection establishment
3. FileTransfer.tsx - Core file sharing feature

### High Priority

4. ApprovalRequest.tsx - Security-critical modal
5. KeyChangeWarning.tsx - Security-critical modal
6. MyCode.tsx - Essential for sharing connection code

### Medium Priority

7. PendingApproval.tsx - Loading state
8. StatusIndicator.tsx - Status feedback

---

## WCAG 2.1 Compliance Summary

| Guideline | Current Status | After Fixes |
|-----------|---------------|-------------|
| 1.1 Text Alternatives | Fail | Pass |
| 1.3 Adaptable | Fail | Pass |
| 1.4 Distinguishable | Partial | Pass |
| 2.1 Keyboard Accessible | Fail | Pass |
| 2.4 Navigable | Fail | Pass |
| 3.2 Predictable | Partial | Pass |
| 4.1 Compatible | Fail | Pass |

---

## Estimated Implementation Effort

| Component | Estimated Hours |
|-----------|----------------|
| MyCode.tsx | 1 hour |
| EnterCode.tsx | 2 hours |
| ApprovalRequest.tsx | 2 hours |
| PendingApproval.tsx | 0.5 hours |
| ChatView.tsx | 3 hours |
| StatusIndicator.tsx | 0.5 hours |
| KeyChangeWarning.tsx | 2 hours |
| FileTransfer.tsx | 3 hours |
| Global utilities | 2 hours |
| Testing | 4 hours |
| **Total** | **20 hours** |

---

## Research: How Other Apps Solve This

This section documents accessibility patterns and implementations from major messaging applications, providing insights for Zajel's accessibility improvements.

### 1. Signal Messenger

**Source:** [Signal Desktop Accessibility Issue #2711](https://github.com/signalapp/Signal-Desktop/issues/2711)

#### Accessibility Features

- **Electron-based accessibility**: Signal Desktop is rendered as web content, making it mostly accessible to screen readers by default
- **Timestamp optimization**: Signal 7.84.0 improves accessibility by skipping repeated timestamp announcements when new messages arrive in a thread
- **iOS VoiceOver support**: Described as "really very accessible for blind iOS users" with clear voice messaging and haptic feedback

#### Known Issues and Lessons Learned

1. **Incoming messages should auto-announce**: Screen readers should automatically read incoming chats using ARIA live regions
2. **Navigation landmarks needed**: Each message should be separated by navigation elements (headings) for quick screen reader navigation between messages
3. **Unlabeled buttons**: Buttons placed after the edit field lack proper labels, making them unknown to screen reader users
4. **Link accessibility**: VoiceOver users cannot consistently open links in messages

#### Key Takeaway for Zajel

Signal's experience shows that even well-built Electron/web apps need explicit ARIA implementation. Simply being web-based is not enough - proper landmarks, live regions, and button labels are essential.

---

### 2. Telegram

**Sources:** [Telegram Desktop Accessibility Issue #476](https://github.com/telegramdesktop/tdesktop/issues/476), [Telegram Desktop Accessibility Issue #2215](https://github.com/telegramdesktop/tdesktop/issues/2215), [AppleVis: Accessible Telegram Script](https://www.applevis.com/forum/ios-ipados/accessible-telegram-script-enhance-telegram-web-accessibility-voiceover-users-ios)

#### Current Accessibility Status

- **Desktop**: Not accessible to JAWS or NVDA screen readers - users report that screen readers "don't read anything"
- **Web**: Significant accessibility gaps requiring community-developed workarounds
- **Mobile**: iOS app has VoiceOver issues that community scripts attempt to fix

#### Community Solutions (Accessible Telegram Script)

A community-developed script addresses Telegram Web's accessibility gaps with these patterns:

1. **Simplified Message Navigation**
   - Each message converted into a single, focusable item
   - Messages act as "headings" for screen reader navigation
   - Users can navigate message-to-message using heading navigation (e.g., VoiceOver Rotor)

2. **Accessible Context Menus**
   - Replaces default inaccessible context menus with custom accessible dialogs
   - Actions like reply, forward, copy, delete are properly announced

3. **Proper Labeling**
   - "Forward to..." screen and search results labeled with context (User, Group, Channel)
   - Fixes bug where screen readers announced text field twice

4. **Keyboard Navigation**
   - Tab, Shift-Tab, and Arrow key navigation
   - Keyboard shortcuts for navigating between messages

#### Key Takeaway for Zajel

Telegram's challenges show what happens when accessibility is not prioritized. The community script provides a roadmap for implementing proper message navigation, context menus, and keyboard shortcuts in chat interfaces.

---

### 3. WhatsApp

**Source:** [Accessibility of WhatsApp - Accessibility.com](https://www.accessibility.com/blog/accessibility-of-whatsapp)

#### Accessibility Achievements

- **High accessibility rating**: WhatsApp ranked "highly accessible" for persons with disabilities in India based on WCAG guidelines
- **Screen reader compatibility**: Works with assistive technology like screen readers and voice-to-text services
- **AI assistant integration**: Compatible with Siri for reading messages aloud and dictating messages
- **Voice message transcripts**: Provides transcripts for users with hearing disabilities

#### Limitations

- **Web requires mobile app**: WhatsApp Web requires the mobile app installation, which creates barriers for:
  - Users who cannot use mobile apps due to disabilities
  - Users who prefer web-based assistive technologies
  - Desktop-first accessibility tool users

#### Key Takeaway for Zajel

WhatsApp demonstrates the value of voice message transcripts and screen reader compatibility. Zajel should ensure the web client is fully independent and does not require mobile app pairing for accessibility.

---

### 4. Slack

**Sources:** [Slack Accessibility](https://slack.com/accessibility), [Slack Multi-year Accessibility Plan](https://slack.com/accessibility-plan), [How to Fail at Accessibility - Slack Engineering](https://slack.engineering/how-to-fail-at-accessibility/), [Automated Accessibility Testing at Slack](https://slack.engineering/automated-accessibility-testing-at-slack/)

#### WCAG Compliance

- **Target**: WCAG Level AA for all features, Level AAA wherever possible
- **Internal standards**: Slack Accessibility Standards that product teams follow
- **Dedicated team**: Full accessibility team supporting developers throughout development

#### Automated Testing Approach

Slack's accessibility testing evolution provides a model for implementation:

1. **Tool Selection**: Chose Axe for its flexibility and WCAG alignment
2. **Integration Point**: Incorporated automated tests into development workflow (2022)
3. **Compliance Level**: Tests check WCAG 2.1, Levels A and AA
4. **Proactive Approach**: Tests catch violations before code ships

#### Enterprise Compliance

- SOC 2, SOC 3, ISO 27001, HIPAA certifications
- Real-time audit logs and compliance exports
- Enterprise Key Management

#### Key Takeaway for Zajel

Slack's engineering blog documents their journey from accessibility issues to systematic testing. Their automated testing with Axe should be adopted, and their internal standards approach provides a template for maintaining accessibility across the codebase.

---

### 5. Discord

**Source:** [Discord Accessibility](https://discord.com/accessibility)

#### WCAG Compliance

- Discord is compliant with WCAG 2.1

#### Comparison with Slack

| Feature | Slack | Discord |
|---------|-------|---------|
| WCAG Compliance | 2.1 AA (targeting AAA) | 2.1 |
| Dedicated A11y Team | Yes | Less documented |
| Automated Testing | Axe integration | Not documented |
| Enterprise Compliance | Full | Limited |

#### Key Takeaway for Zajel

Discord meets WCAG 2.1 but has less documented accessibility processes. For a security-focused messaging app like Zajel, following Slack's more rigorous approach is recommended.

---

### 6. Microsoft Teams

**Source:** [Screen Reader Support for Microsoft Teams](https://support.microsoft.com/en-us/office/screen-reader-support-for-microsoft-teams-d12ee53f-d15f-445e-be8d-f0ba2c5ee68f), [Basic Tasks Using a Screen Reader with Microsoft Teams](https://support.microsoft.com/en-us/office/basic-tasks-using-a-screen-reader-with-microsoft-teams-538a8741-f21b-4b04-b575-9df70ed4105d)

#### Screen Reader Support

- Works with Windows Narrator, JAWS, and NVDA
- Documentation designed for users with visual or cognitive impairments

#### Keyboard Shortcuts

| Action | Web Shortcut | Desktop Shortcut |
|--------|-------------|------------------|
| View shortcuts | Ctrl+. | Ctrl+. |
| Activity view | Ctrl+Shift+1 | Similar |
| Chat view | Ctrl+Shift+2 | Ctrl+2 |
| Start audio call | Ctrl+Shift+C | Same |
| Start video call | Ctrl+Shift+U | Same |
| Cycle sections (Mac) | Command+F6 | - |

#### Accessibility Features

- **Immersive Reader**: Customizes reading/viewing experience for different visual and cognitive needs
- **Disability Answer Desk**: Technical assistance for accessibility questions
- **Multiple assistive tech support**: JAWS, NVDA, Narrator all documented

#### Key Takeaway for Zajel

Microsoft Teams provides comprehensive keyboard shortcuts and screen reader documentation. Zajel should implement similar shortcuts and document them clearly for users.

---

### 7. Intercom Messenger

**Sources:** [Building for Everyone: How We Made the Intercom Messenger Accessible](https://www.intercom.com/blog/messenger-accessibility/), [How We Made the Intercom Messenger Accessible - Daniel Husar](https://www.danielhusar.sk/blog/how-we-made-the-intercom-messenger-accessible/), [Hot Button Issue: Improving Accessibility in the Messenger](https://www.intercom.com/blog/accessibility-buttons-messenger/)

#### ARIA Implementation Details

Intercom provides the most detailed public documentation of chat accessibility implementation:

1. **aria-label for clickable elements**
   - Added to all elements with onClick handlers where functionality is not clear
   - Essential for decorative icons without text

2. **aria-live for dynamic content**
   - Added to support DOM changes without page reload
   - Screen readers watch for mutations and announce changes

3. **Messenger apps framework**
   - Extended framework with aria-label attributes
   - Enables all embedded apps to be fully accessible

#### Code-Level Changes

1. **Language attribute**: Set on HTML elements for correct screen reader pronunciation
2. **Semantic markup**: Updated code to include proper elements:
   - Headings for structure
   - Paragraphs for content
   - Labels for form elements
3. **Quick reply contrast**: Maintains 4.5:1 contrast ratio between background and text

#### Recent Improvements (Keyboard Users)

- Arrow key navigation in chat window
- ESC key behavior maintains logical focus
- Skip links visible when focused
- Breadcrumbs wrapped in navigation landmarks
- Emoji/GIF pickers support four-directional arrow keys

#### Automated Testing

Two main tools integrated:
1. **ESLint a11y plugin**: Static code checking for accessibility issues
2. **React-a11y**: Runtime validation in integration tests

#### Key Takeaway for Zajel

Intercom's documentation provides actionable patterns for Zajel:
- Use aria-label on icon buttons
- Implement aria-live regions for message updates
- Set language attributes on HTML elements
- Integrate ESLint a11y and runtime testing

---

### WCAG 2.1 Guidelines Specific to Messaging Apps

**Sources:** [ARIA23: Using role=log for Sequential Information Updates](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA23.html), [Understanding Success Criterion 4.1.3: Status Messages](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html), [Feed Pattern | APG | WAI | W3C](https://www.w3.org/WAI/ARIA/apg/patterns/feed/), [ARIA: log role | MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/log_role)

#### The `role="log"` Pattern

The log role is specifically designed for chat interfaces:

```html
<div role="log" aria-label="Chat messages" aria-live="polite">
  <!-- Messages appended here -->
</div>
```

**Characteristics:**
- Implicit `aria-live="polite"` - doesn't interrupt user
- Implicit `aria-atomic="false"` - only new content is announced
- New content added at the end is automatically announced
- Old content may disappear (e.g., message limits)

**WCAG Technique Example:**
```html
<div id="chatlog" role="log" aria-labelledby="chat-heading">
  <h2 id="chat-heading">Chat Log</h2>
  <ul>
    <li>[timestamp] User: Message content</li>
    <!-- New messages appended here -->
  </ul>
</div>
```

#### The `role="feed"` Pattern

For infinite-scroll message lists:

```html
<div role="feed" aria-labelledby="feed-heading" aria-busy="false">
  <article role="article" aria-posinset="1" aria-setsize="-1">
    <!-- Message content -->
  </article>
</div>
```

**When to use feed vs log:**
| Use Case | Role |
|----------|------|
| Real-time chat with auto-scroll | `log` |
| Scrollable message history | `feed` |
| Social media timeline | `feed` |
| Live updates (notifications) | `log` or `status` |

#### ARIA Live Regions

**Sources:** [ARIA Live Regions | MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions), [Accessible Notifications with ARIA Live Regions](https://www.sarasoueidan.com/blog/accessible-notifications-with-aria-live-regions-part-1/)

| Value | Behavior | Use Case |
|-------|----------|----------|
| `polite` | Waits for user idle | Chat messages, status updates |
| `assertive` | Interrupts immediately | Errors, security warnings |
| `off` | No announcement | Content user controls |

**Best Practices:**
1. Pre-render empty live regions before content arrives
2. Use `aria-relevant="additions"` for chat (not "all")
3. Avoid making apps too "chatty" with excessive announcements
4. Never repeat entire conversation when new messages arrive

**For Zajel's KeyChangeWarning:**
```html
<div role="alertdialog" aria-live="assertive">
  <!-- Security warning content -->
</div>
```

#### Success Criterion 4.1.3: Status Messages

Status messages must be programmatically identified without receiving focus:

**Applies to:**
- Connection status changes
- Message sent confirmations
- File transfer progress updates

**Implementation:**
```html
<div role="status" aria-live="polite">
  Connected to peer ABC123
</div>
```

---

### Keyboard Navigation Patterns

**Sources:** [Developing a Keyboard Interface | APG | WAI | W3C](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/), [WebAIM: Keyboard Accessibility](https://webaim.org/techniques/keyboard/), [Focus & Keyboard Operability | Yale](https://usability.yale.edu/web-accessibility/articles/focus-keyboard-operability)

#### Focus Management in Chat Applications

1. **Roving Tabindex for Message Lists**
   ```html
   <ul role="list">
     <li tabindex="0">Current message</li>
     <li tabindex="-1">Other message</li>
     <li tabindex="-1">Other message</li>
   </ul>
   ```
   - Tab moves into/out of list
   - Arrow keys navigate within list

2. **Modal Focus Trapping**
   - Focus trapped within modals (ApprovalRequest, KeyChangeWarning)
   - Return focus to trigger element on close
   - ESC key dismisses modal

3. **Focus Persistence**
   - Never let `document.activeElement` become null or body
   - When deleting messages, focus next/previous message
   - When closing dialogs, return focus to trigger

4. **Visible Focus Indicators**
   ```css
   :focus-visible {
     outline: 2px solid var(--primary);
     outline-offset: 2px;
   }
   ```

#### Recommended Keyboard Shortcuts for Zajel

| Action | Shortcut | Notes |
|--------|----------|-------|
| Send message | Enter | Standard |
| New line | Shift+Enter | Standard |
| Navigate messages | Arrow Up/Down | Within message list |
| Jump to input | Escape or / | Focus message input |
| Attach file | Ctrl+U | Common pattern |
| Disconnect | Ctrl+D | With confirmation |

---

### Color Contrast Requirements

**Sources:** [WebAIM: Contrast and Color Accessibility](https://webaim.org/articles/contrast/), [WCAG 2.1 Contrast (Minimum)](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html), [WCAG 2.1 Contrast (Enhanced)](https://www.w3.org/WAI/WCAG21/Understanding/contrast-enhanced.html)

#### Contrast Ratios

| Level | Normal Text | Large Text | UI Components |
|-------|-------------|------------|---------------|
| AA | 4.5:1 | 3:1 | 3:1 |
| AAA | 7:1 | 4.5:1 | - |

**Large text defined as:**
- 18pt (24px) or larger
- 14pt (18.66px) bold or larger

#### Dark Mode Considerations

**Source:** [Dark Mode Doesn't Satisfy WCAG | BOIA](https://www.boia.org/blog/offering-a-dark-mode-doesnt-satisfy-wcag-color-contrast-requirements)

- Dark mode does NOT exempt from WCAG contrast requirements
- Both light and dark themes must meet 4.5:1 minimum
- Avoid pure black (#000000) - causes eye strain and "halation effect"
- Use softer dark grays for backgrounds
- Avoid highly saturated colors in dark mode

#### Zajel-Specific Considerations

For Zajel's messaging interface:

| Element | Current | Target |
|---------|---------|--------|
| Message text | Must verify | 4.5:1 (AA) |
| Status indicators | Color alone | Add text labels |
| Error messages | Red only | Add icons + 4.5:1 contrast |
| Fingerprint codes | May be low contrast | 7:1 (AAA for security) |

---

### Implementation Recommendations for Zajel

Based on this research, here are prioritized recommendations:

#### Critical - Implement Immediately

1. **Add `role="log"` to ChatView message container**
   - Ensures new messages are announced
   - Use `aria-live="polite"` and `aria-relevant="additions"`

2. **Label all icon buttons**
   - Send button, attach file button, disconnect button
   - Use `aria-label` or visually-hidden text

3. **Implement focus trapping in modals**
   - ApprovalRequest, KeyChangeWarning
   - Add ESC key dismissal

4. **Add keyboard navigation to message list**
   - Arrow keys for message navigation
   - Enter to interact with message

#### High Priority

5. **Use `role="alertdialog"` for security warnings**
   - KeyChangeWarning should interrupt screen reader
   - Use `aria-live="assertive"`

6. **Progress bar accessibility**
   - Add `role="progressbar"` with aria-valuenow/min/max
   - Announce significant progress changes

7. **Status indicator announcements**
   - Add `role="status"` to StatusIndicator
   - Ensure text alternative for colored dots

#### Medium Priority

8. **Automated testing integration**
   - Add eslint-plugin-jsx-a11y
   - Add jest-axe for component tests
   - Consider react-a11y for runtime checks

9. **Keyboard shortcut documentation**
   - Implement Ctrl+. to show shortcuts (like Slack/Teams)
   - Document all keyboard interactions

10. **Dark mode contrast audit**
    - Verify all text meets 4.5:1 ratio
    - Test with contrast checker tools

---

### References and Further Reading

#### Official Standards
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/standards-guidelines/wcag/)
- [WAI-ARIA 1.2 Specification](https://www.w3.org/WAI/standards-guidelines/aria/)
- [ARIA Authoring Practices Guide (APG)](https://www.w3.org/WAI/ARIA/apg/)

#### Patterns
- [ARIA23: Using role=log](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA23)
- [Feed Pattern | APG](https://www.w3.org/WAI/ARIA/apg/patterns/feed/)
- [ARIA: log role | MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/log_role)

#### Industry Examples
- [Intercom Messenger Accessibility](https://www.intercom.com/blog/messenger-accessibility/)
- [Slack Automated Accessibility Testing](https://slack.engineering/automated-accessibility-testing-at-slack/)
- [Slack Accessibility](https://slack.com/accessibility)

#### Tools
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [Axe Accessibility Testing](https://www.deque.com/axe/)
- [eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y)
