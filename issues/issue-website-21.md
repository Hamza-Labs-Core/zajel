# [MEDIUM] No Subresource Integrity on any external resources and missing security headers

**Area**: Website
**File**: packages/website/app/root.tsx
**Type**: Security

**Description**: The application loads external resources (Google Fonts from `fonts.googleapis.com` and `fonts.gstatic.com`) and makes external API calls (GitHub API) but does not implement any of the standard security headers that modern web applications should have:

1. **X-Content-Type-Options**: Not set. Without `nosniff`, browsers may MIME-sniff responses, potentially interpreting a text response as executable script.
2. **X-Frame-Options**: Not set. The site can be embedded in iframes on any domain, enabling clickjacking attacks.
3. **Referrer-Policy**: Not set. The default policy leaks the full URL in Referer headers to external domains.
4. **Permissions-Policy**: Not set. The site does not restrict browser features (camera, microphone, geolocation, etc.) that could be exploited if XSS is achieved.
5. **Strict-Transport-Security (HSTS)**: Not set. Users accessing the site over HTTP are not automatically redirected to HTTPS by the browser on subsequent visits.

**Impact**: The site is vulnerable to clickjacking, MIME-type confusion attacks, and Referer information leakage. Without HSTS, users on insecure networks could be downgraded to HTTP. Without Permissions-Policy, an XSS attack could access browser APIs like the camera or microphone.

**Fix**: For Cloudflare Pages deployment, create a `public/_headers` file:
```
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
```
Alternatively, configure these in `wrangler.toml` or via Cloudflare dashboard rules.
