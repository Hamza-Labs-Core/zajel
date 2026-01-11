# Issue #29: Missing displayName/XSS Validation Analysis

## Executive Summary

This document analyzes the XSS (Cross-Site Scripting) vulnerability concerns raised in PR review issue #29 regarding user-controlled strings in the Zajel web client. After thorough analysis, the risk level is **LOW** due to Preact's default escaping behavior, though some improvements are recommended.

---

## 1. User-Controlled Data Sources

The following user-controlled data is rendered in the UI:

### 1.1 Peer Code (`peerCode`)
- **Source**: Signaling server (6-character alphanumeric code)
- **Validation**: Strict validation via `PAIRING_CODE_REGEX` in `/home/meywd/zajel/packages/web-client/src/lib/signaling.ts` (line 12)
- **Pattern**: `^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$`
- **Rendered in**:
  - `ChatView.tsx` (line 45): `<h2>{peerCode}</h2>`
  - `ApprovalRequest.tsx` (line 13): `<span class="code">{peerCode}</span>`
  - `PendingApproval.tsx` (line 11): `<p>Waiting for {peerCode} to accept...</p>`
  - `KeyChangeWarning.tsx` (line 21): `<span class="code">{peerCode}</span>`
  - `App.tsx` (lines 519, 574): Displayed in security info panels

### 1.2 Chat Message Content (`msg.content`)
- **Source**: Decrypted from peer via WebRTC data channel
- **Validation**: None (arbitrary text from peer)
- **Rendered in**:
  - `ChatView.tsx` (lines 53-55):
    ```tsx
    <div key={msg.id} class={`message ${msg.sender === 'me' ? 'sent' : 'received'}`}>
      {msg.content}
    </div>
    ```

### 1.3 File Name (`transfer.fileName`)
- **Source**: Received from peer via file transfer protocol
- **Validation**: None (arbitrary filename from peer)
- **Rendered in**:
  - `FileTransfer.tsx` (line 84): `{transfer.fileName} ({formatSize(transfer.totalSize)})`
  - Also used in download (line 244 App.tsx): `a.download = t.fileName`

### 1.4 Error Messages
- **Source**: Various - server errors, protocol errors
- **Rendered in**:
  - `App.tsx` (line 612): `<p style={{ margin: 0 }}>{error}</p>`
  - `FileTransfer.tsx` (line 119): `{transfer.error || 'Transfer failed'}`

### 1.5 Key Fingerprints
- **Source**: Derived from public keys (hex string)
- **Rendered in**:
  - `App.tsx` (lines 513, 520-521, 570, 583): Inside `<code>` tags
  - `KeyChangeWarning.tsx` (lines 42, 60): Inside `<code>` tags

### 1.6 My Code (`myCode`)
- **Source**: Generated locally by `generatePairingCode()` in `signaling.ts`
- **Validation**: Inherently safe (generated from known character set)
- **Rendered in**:
  - `MyCode.tsx` (lines 22-26): Individual characters rendered

---

## 2. Preact/React Default Escaping Behavior

### 2.1 How JSX Protects Against XSS

Preact (and React) automatically escapes values interpolated in JSX expressions. When you write:

```tsx
<div>{userInput}</div>
```

Preact converts special HTML characters to their entity equivalents:
- `<` becomes `&lt;`
- `>` becomes `&gt;`
- `&` becomes `&amp;`
- `"` becomes `&quot;`
- `'` becomes `&#x27;`

This means malicious input like `<script>alert('XSS')</script>` would be rendered as literal text, not executed.

### 2.2 Verification - Dangerous Patterns Search

Searched for dangerous patterns that bypass Preact's escaping:
- **Unsafe HTML injection APIs**: **NOT FOUND** in codebase
- **innerHTML assignment**: **NOT FOUND** in codebase
- **Direct DOM manipulation with user input**: **NOT FOUND**

The codebase exclusively uses safe JSX interpolation for all user-controlled data.

---

## 3. Risk Assessment by Data Type

| Data Type | Risk Level | Justification |
|-----------|------------|---------------|
| `peerCode` | **VERY LOW** | Strict regex validation (6 alphanumeric chars) |
| `msg.content` | **LOW** | Preact auto-escapes; no HTML rendering |
| `fileName` | **LOW** | Preact auto-escapes; file download name is safe |
| `error` | **LOW** | Server-controlled messages; Preact escapes |
| Fingerprints | **VERY LOW** | Hex-derived; displayed in `<code>` tags |
| `myCode` | **NONE** | Locally generated from known charset |

---

## 4. Potential Attack Vectors (Mitigated)

### 4.1 Chat Message Injection
**Scenario**: Malicious peer sends `<img src=x onerror=alert(1)>`
**Protection**: Preact escapes the content, rendering it as visible text.
**Status**: MITIGATED

### 4.2 Filename Injection
**Scenario**: Malicious peer sends file named `<script>evil()</script>.txt`
**Protection**: Preact escapes in display; `download` attribute treats as literal string.
**Status**: MITIGATED

### 4.3 Protocol Error Message Injection
**Scenario**: Malicious server sends crafted error message with HTML
**Protection**: Preact escapes the content.
**Status**: MITIGATED

---

## 5. Remaining Concerns and Recommendations

### 5.1 Defense in Depth - Input Validation

While Preact's escaping provides protection at render time, implementing input validation adds defense in depth:

**Recommendation 1: Validate Filename**
```typescript
// Maximum filename length to prevent UI issues
const MAX_FILENAME_LENGTH = 255;

function sanitizeFilename(name: string): string {
  // Remove path separators and limit length
  return name
    .replace(/[/\\]/g, '_')
    .slice(0, MAX_FILENAME_LENGTH);
}
```

**Recommendation 2: Validate Chat Message Length**
```typescript
const MAX_MESSAGE_LENGTH = 10000;

function validateMessage(content: string): boolean {
  return content.length > 0 && content.length <= MAX_MESSAGE_LENGTH;
}
```

### 5.2 Content Security Policy (CSP)

Add CSP headers to prevent inline script execution even if escaping fails:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';">
```

### 5.3 URL Validation (Not Currently Needed)

The application does not render user-provided URLs as links. If this feature is added in the future, implement URL validation:

```typescript
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}
```

### 5.4 displayName Consideration

The PR review mentions `displayName` but the current codebase uses `peerCode` instead of display names. If display names are added in the future:

```typescript
const MAX_DISPLAY_NAME_LENGTH = 50;
const DISPLAY_NAME_REGEX = /^[\p{L}\p{N}\p{Emoji}\s._-]+$/u;

function validateDisplayName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_DISPLAY_NAME_LENGTH &&
    DISPLAY_NAME_REGEX.test(name)
  );
}
```

---

## 6. Files Analyzed

| File | Path | User Data Rendered |
|------|------|-------------------|
| App.tsx | `/home/meywd/zajel/packages/web-client/src/App.tsx` | peerCode, error, fingerprints |
| ChatView.tsx | `/home/meywd/zajel/packages/web-client/src/components/ChatView.tsx` | peerCode, msg.content |
| ApprovalRequest.tsx | `/home/meywd/zajel/packages/web-client/src/components/ApprovalRequest.tsx` | peerCode |
| PendingApproval.tsx | `/home/meywd/zajel/packages/web-client/src/components/PendingApproval.tsx` | peerCode |
| FileTransfer.tsx | `/home/meywd/zajel/packages/web-client/src/components/FileTransfer.tsx` | fileName, error |
| KeyChangeWarning.tsx | `/home/meywd/zajel/packages/web-client/src/components/KeyChangeWarning.tsx` | peerCode, fingerprints |
| MyCode.tsx | `/home/meywd/zajel/packages/web-client/src/components/MyCode.tsx` | myCode (locally generated) |
| EnterCode.tsx | `/home/meywd/zajel/packages/web-client/src/components/EnterCode.tsx` | User input (local only) |
| StatusIndicator.tsx | `/home/meywd/zajel/packages/web-client/src/components/StatusIndicator.tsx` | None (uses static labels) |
| signaling.ts | `/home/meywd/zajel/packages/web-client/src/lib/signaling.ts` | Contains code validation |

---

## 7. Conclusion

**Overall Risk Level: LOW**

The Zajel web client is well-protected against XSS attacks due to:

1. **Preact's automatic escaping** of all JSX-interpolated values
2. **No use of unsafe HTML injection APIs** or direct innerHTML manipulation
3. **Strict validation** of pairing codes (the most visible user-controlled string)
4. **No URL rendering** from user input

**Recommended Actions (Priority Order)**:

1. **[Optional]** Add filename length validation to prevent UI overflow
2. **[Optional]** Add message length validation to prevent memory issues
3. **[Recommended]** Implement CSP headers for defense in depth
4. **[Future]** If displayName feature is added, implement proper validation

The current implementation follows secure coding practices for a Preact/React application. The PR review concern is valid for awareness, but the actual risk is minimal given the framework's built-in protections.

---

## 8. Code References

### Existing Validation (signaling.ts lines 10-21)
```typescript
const PAIRING_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 6;
const PAIRING_CODE_REGEX = new RegExp(`^[${PAIRING_CODE_CHARS}]{${PAIRING_CODE_LENGTH}}$`);

function isValidPairingCode(code: string): boolean {
  return PAIRING_CODE_REGEX.test(code);
}
```

### Safe JSX Rendering Example (ChatView.tsx lines 52-56)
```tsx
{messages.map((msg) => (
  <div key={msg.id} class={`message ${msg.sender === 'me' ? 'sent' : 'received'}`}>
    {msg.content}  {/* Preact auto-escapes this */}
  </div>
))}
```

---

## Research: How Other Apps Solve This

This section documents how major messaging applications handle XSS prevention, input sanitization, and Content Security Policy implementation.

### 1. Signal Desktop

**Platform**: Electron (Chromium-based desktop app)

#### Historical Vulnerabilities
Signal Desktop through version 1.10.1 had an [XSS vulnerability](https://www.cvedetails.com/vulnerability-list/vendor_id-17912/Signal.html) via resource locations in SCRIPT, IFRAME, or IMG elements. The software failed to sanitize specific HTML elements that could be used to inject HTML code into remote chat windows. Researchers were able to [bypass Signal's CSP](https://github.com/signalapp/Signal-Desktop/issues/1635) by leveraging `child-src 'self'` to load content into child frames that were unconstrained by the parent's CSP.

#### Key Security Measures
1. **Electron Security Configuration**:
   - `nodeIntegration: false` - Prevents Node.js access from renderer
   - `contextIsolation: true` - Isolates preload scripts from renderer context
   - `sandbox: true` - Enables Chromium sandbox

2. **CSP Implementation**: Uses restrictive CSP headers, though [child frames don't inherit parent CSP](https://bishopfox.com/blog/reasonably-secure-electron)

3. **Framework Consideration**: The flaw stemmed from use of React's `dangerouslySetInnerHTML` without proper sanitization

#### Lessons for Zajel
- Avoid `dangerouslySetInnerHTML` entirely (Zajel already does this)
- If ever needed, always sanitize with DOMPurify first
- CSP alone is not sufficient - it's a "seatbelt" not a complete solution

---

### 2. Telegram Web

**Platform**: Web application (WebK/WebZ clients)

#### Historical Vulnerabilities
[CVE-2024-33905](https://medium.com/@pedbap/telegram-web-app-xss-session-hijacking-1-click-95acccdc8d90): Telegram WebK before 2.0.0 (488) allowed XSS via the `web_app_open_link` postMessage event type. Attackers could use the `javascript:` scheme to execute code within web.telegram.org context.

#### Security Patches Implemented
1. **SafeWindow URL**: Links are processed in a secure, isolated context
2. **`noreferrer` Argument**: New windows cannot access the originating Telegram window context
3. **Enhanced Input Validation**: URLs passed through postMessages are validated before processing
4. **Protocol Validation**: Telegram now checks that URL protocols are not `javascript:` before processing

#### Lessons for Zajel
- Always validate URL protocols (whitelist `http:` and `https:` only)
- Use `rel="noopener noreferrer"` on all external links
- Validate postMessage origins if ever implementing cross-frame communication

---

### 3. WhatsApp Web/Desktop

**Platform**: Electron desktop app + web client

#### Historical Vulnerabilities
Security researcher Gal Weizman discovered multiple issues including [CSP bypass leading to XSS](https://www.securityweek.com/vulnerability-whatsapp-desktop-app-exposed-user-files/). The attack chain:
1. Manipulate reply message quotes
2. Alter link preview banners to hide actual destination
3. Trick users into clicking JavaScript URI links
4. Achieve persistent XSS

The Electron app was using outdated Chromium (Chrome 69 when Chrome 78 was current), exposing users to known vulnerabilities.

#### Key Security Measures
1. **Link Preview Generation**: Server-side, not client-controlled
2. **Outdated Dependencies**: A cautionary tale - always keep Electron updated
3. **End-to-End Encryption**: Protects message content in transit

#### Lessons for Zajel
- Keep dependencies (especially Electron if ever used) up to date
- Never trust client-generated link previews without server validation
- The Zajel web client doesn't render links as clickable, which is inherently safer

---

### 4. Matrix Element Web

**Platform**: React-based web client

#### Security Architecture
1. **[X-XSS-Protection Header](https://github.com/element-hq/element-web)**: `X-XSS-Protection: 1; mode=block`
2. **[CSP Frame Ancestors](https://github.com/element-hq/element-web)**: `Content-Security-Policy: frame-ancestors 'self'`
3. **Domain Separation**: [Strongly recommended](https://matrix.org/category/security/) to host homeserver on completely different registered domain from web client

#### Historical Vulnerabilities
- Matrix Static was vulnerable to XSS via room names due to missing sanitization
- Prototype pollution via specially crafted event keys
- [CVE-2025-32026](https://www.cvedetails.com/cve/CVE-2025-32026/): Recent XSS in Element Web

#### Key Security Measures
1. **React's Virtual DOM**: Provides automatic escaping layer
2. **Matrix-React-SDK**: Centralized security handling in SDK
3. **Regular Security Audits**: Active security hall of fame program

#### Lessons for Zajel
- React/Preact's virtual DOM with auto-escaping is industry standard
- Domain separation is important for production deployments
- Regular security review and updates are essential

---

### 5. Discord

**Platform**: Electron desktop + web client (React-based)

#### Historical Vulnerabilities
[Discord RCE vulnerability](https://www.sonatype.com/blog/discord-squashes-critical-electron-bugs-open-source-attacks-continue-to-grow) exploited:
1. `contextIsolation: false` (insecure Electron config)
2. XSS flaw in Sketchfab iframe embeds
3. Electron navigation restriction bypass

#### Security Remediation
1. **Enabled `contextIsolation`**: Prevents RCE escalation from XSS
2. **Disabled vulnerable embeds**: Removed Sketchfab until fixed
3. **Updated Electron**: Keeping Chromium current

#### Key Lessons
- XSS in Electron apps can escalate to RCE if not properly sandboxed
- Iframe embeds from third parties are high-risk
- `contextIsolation: true` is mandatory for Electron security

---

### 6. Slack

**Platform**: Electron desktop + web client

#### Historical Vulnerabilities
[Stored XSS via Markdown editor](https://hackerone.com/reports/132104) allowed `javascript:` links in editing mode.

#### Security Recommendations (from [Slack's official docs](https://api.slack.com/authentication/best-practices))
1. Never consume tokens via URL query strings
2. Always use POST for transmitting secrets
3. Consider OWASP Top 10 vulnerabilities (XSS, CSRF, SQLi)
4. Lock down app permissions

---

### Summary: Industry Best Practices

Based on research across all major messaging apps, here are the consolidated best practices:

#### 1. Framework-Level Protection
| Approach | Used By | Notes |
|----------|---------|-------|
| React/Preact auto-escaping | All modern apps | Primary defense against XSS |
| Avoid `dangerouslySetInnerHTML` | Signal, Element, Discord | If needed, always use DOMPurify |
| Virtual DOM diffing | React/Preact apps | Additional protection layer |

#### 2. Content Security Policy

**Recommended Strict CSP** (per [Google's guidelines](https://web.dev/articles/strict-csp)):
```
Content-Security-Policy:
  script-src 'self' 'nonce-{RANDOM}' 'strict-dynamic';
  object-src 'none';
  base-uri 'none';
  frame-ancestors 'self';
```

**Key Directives**:
- `script-src 'self'`: Only allow scripts from same origin
- `'nonce-{RANDOM}'`: Per-request random value for inline scripts
- `'strict-dynamic'`: Trust scripts loaded by trusted scripts
- `object-src 'none'`: Block plugins (Flash, Java)
- `base-uri 'none'`: Prevent base tag injection

#### 3. URL/Link Handling

```typescript
// Industry-standard URL validation
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// Link rendering with security attributes
<a href={validatedUrl} rel="noopener noreferrer" target="_blank">
```

**Protocol Blacklist** (always block):
- `javascript:`
- `vbscript:`
- `data:` (for links)
- `file:`

#### 4. Markdown/Rich Text Rendering

Per [Showdown's XSS documentation](https://github.com/showdownjs/showdown/wiki/Markdown's-XSS-Vulnerability-(and-how-to-mitigate-it)) and [react-markdown best practices](https://www.pullrequest.com/blog/secure-markdown-rendering-in-react-balancing-flexibility-and-safety/):

1. **Sanitize AFTER conversion**: Never before, as markdown parsers and sanitizers parse differently
2. **Use [DOMPurify](https://github.com/cure53/DOMPurify)**: OWASP-recommended sanitization library
3. **Consider [react-markdown](https://github.com/remarkjs/react-markdown)**: Secure by default, escapes HTML

```typescript
// Safe markdown rendering pattern
import DOMPurify from 'dompurify';
import { marked } from 'marked';

function renderMarkdown(input: string): string {
  const html = marked.parse(input);
  return DOMPurify.sanitize(html);
}
```

#### 5. Electron-Specific (if applicable in future)

Per [Electron's security documentation](https://www.electronjs.org/docs/latest/tutorial/security):

```javascript
// Secure Electron configuration
const mainWindow = new BrowserWindow({
  webPreferences: {
    nodeIntegration: false,      // CRITICAL
    contextIsolation: true,       // CRITICAL
    sandbox: true,                // CRITICAL
    webSecurity: true,
    allowRunningInsecureContent: false
  }
});
```

---

### Zajel's Current Position

**Strengths** (already implemented):
1. Preact auto-escaping for all user content
2. No use of `dangerouslySetInnerHTML`
3. No URL/link rendering from user input
4. Strict regex validation for peer codes
5. No iframe embeds or third-party content

**Recommendations** (ordered by priority):

| Priority | Recommendation | Effort | Impact |
|----------|---------------|--------|--------|
| HIGH | Add CSP headers (see Section 5.2) | Low | High |
| MEDIUM | Add filename length/character validation | Low | Medium |
| MEDIUM | Add message length limits | Low | Medium |
| LOW | URL validation if links added | Medium | High |
| LOW | DOMPurify integration if rich text added | Medium | High |

---

### References

- [Electron Security Best Practices](https://www.electronjs.org/docs/latest/tutorial/security)
- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [Google Strict CSP Guide](https://web.dev/articles/strict-csp)
- [React XSS Prevention Guide](https://pragmaticwebsecurity.com/articles/spasecurity/react-xss-part2)
- [DOMPurify Documentation](https://github.com/cure53/DOMPurify)
- [Matrix Security Hall of Fame](https://matrix.org/security-hall-of-fame/)
- [Signal Desktop GitHub Issues](https://github.com/signalapp/Signal-Desktop/issues)
- [Element Web Repository](https://github.com/element-hq/element-web)
- [Telegram XSS CVE-2024-33905](https://medium.com/@pedbap/telegram-web-app-xss-session-hijacking-1-click-95acccdc8d90)
- [WhatsApp Security Advisories](https://www.whatsapp.com/security/advisories)
- [Discord Electron Security](https://www.sonatype.com/blog/discord-squashes-critical-electron-bugs-open-source-attacks-continue-to-grow)
- [Slack Security Best Practices](https://api.slack.com/authentication/best-practices)
