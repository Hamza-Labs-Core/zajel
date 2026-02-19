# [HIGH] No Content Security Policy (CSP) headers configured

**Area**: Website
**File**: packages/website/app/root.tsx
**Type**: Security

**Description**: The application does not set any Content Security Policy headers, either via HTTP headers or `<meta>` tags. There is no server-side configuration (no `headers` export in routes, no middleware) and no CSP meta tag in the `<head>`. Without CSP, the browser has no restrictions on loading external scripts, styles, images, or making connections to arbitrary domains. This significantly increases the impact of any XSS vulnerability, as injected scripts can freely load external resources, exfiltrate data, or import malicious payloads.

**Impact**: Any XSS vulnerability (such as the Mermaid innerHTML issue) becomes fully exploitable without CSP restrictions. Attackers can load external scripts, exfiltrate data to arbitrary domains, and perform any action in the user's browser context. Additionally, there is no protection against clickjacking (no `X-Frame-Options` or `frame-ancestors` CSP directive).

**Fix**: Add a Content Security Policy. For a React Router / Cloudflare Pages deployment, this can be done via a `_headers` file in the public directory or via server-side headers. A recommended starting policy:
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.github.com; frame-ancestors 'none'
```
Also add `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff` headers.
