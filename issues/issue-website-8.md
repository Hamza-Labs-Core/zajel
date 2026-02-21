# [MEDIUM] External Google Fonts loaded without Subresource Integrity (SRI)

**Area**: Website
**File**: packages/website/app/routes/wiki.tsx:40-44
**Type**: Security

**Description**: The wiki route loads Google Fonts via external stylesheet links (`fonts.googleapis.com` and `fonts.gstatic.com`) without Subresource Integrity (SRI) hashes. The `links` export adds preconnect hints and a stylesheet for "Noto Sans Arabic". If the Google Fonts CDN were compromised or a MITM attack occurred, a malicious stylesheet could be served that includes CSS-based exfiltration techniques (using `url()` values in CSS to leak page content) or could alter the page appearance for phishing purposes.

**Impact**: A compromised CDN or MITM on the fonts connection could serve malicious CSS, potentially enabling data exfiltration via CSS selectors, page defacement, or content injection through CSS `content` properties. While Google Fonts is generally trustworthy, defense-in-depth principles require SRI for all external resources.

**Fix**:
1. Self-host the Google Font files to eliminate the external dependency entirely. Download the font files and serve them from the application's public directory.
2. If self-hosting is not feasible, note that Google Fonts dynamically generates CSS (different per user-agent), making SRI impractical. In that case, use a CSP `style-src` directive to limit which external stylesheets can be loaded, restricting it to `https://fonts.googleapis.com`.
3. Consider using `font-display: swap` in a local `@font-face` declaration instead.
