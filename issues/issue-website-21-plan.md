# Plan: No Subresource Integrity on any external resources and missing security headers

**Issue**: issue-website-21.md
**Severity**: MEDIUM
**Area**: Website
**Files to modify**: `packages/website/public/_headers` (new file, shared with issue-website-3)

## Analysis

This issue overlaps significantly with issue-website-3 (CSP headers) and issue-website-8 (Google Fonts SRI). The core problem is that the application does not set any security headers:

1. **X-Content-Type-Options**: Not set (MIME sniffing attack vector)
2. **X-Frame-Options**: Not set (clickjacking attack vector)
3. **Referrer-Policy**: Not set (full URL leaked in Referer headers)
4. **Permissions-Policy**: Not set (no restriction on browser APIs like camera/microphone)
5. **Strict-Transport-Security (HSTS)**: Not set (no HTTP-to-HTTPS enforcement)

The root layout at `packages/website/app/root.tsx` has no `headers` export and no server-side middleware. There is no `_headers` file in the `public/` directory (the directory does not exist).

This plan focuses on the security headers that are NOT covered by issue-website-3's CSP. Issue-website-3 already covers the CSP header and the `X-Frame-Options` and `X-Content-Type-Options` headers. This plan ensures all five headers are addressed.

## Fix Steps

1. **This fix is combined with issue-website-3**. The `packages/website/public/_headers` file created in issue-website-3 should include all security headers. The complete file should be:

   ```
   /*
     Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.github.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
     X-Content-Type-Options: nosniff
     X-Frame-Options: DENY
     Referrer-Policy: strict-origin-when-cross-origin
     Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
     Strict-Transport-Security: max-age=31536000; includeSubDomains
   ```

2. **Header explanations**:
   - `X-Content-Type-Options: nosniff` -- Prevents MIME type sniffing, forcing browsers to respect the declared Content-Type
   - `X-Frame-Options: DENY` -- Prevents the site from being embedded in iframes (clickjacking protection)
   - `Referrer-Policy: strict-origin-when-cross-origin` -- Sends the full URL as referrer for same-origin requests, but only the origin for cross-origin requests
   - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()` -- Disables access to sensitive browser APIs that the site does not need
   - `Strict-Transport-Security: max-age=31536000; includeSubDomains` -- Tells browsers to always use HTTPS for 1 year, including subdomains

3. **If the `_headers` file was already created** by issue-website-3, verify it includes all five headers listed above. Add any missing ones.

4. **For the HSTS header**: Only enable this if the site is consistently served over HTTPS. Cloudflare Pages serves everything over HTTPS by default, so this is safe. The `max-age=31536000` (1 year) is the recommended value for HSTS.

## Testing

- Deploy to Cloudflare Pages (or test with `wrangler pages dev ./build/client`) and verify all security headers are present in HTTP responses.
- Use https://securityheaders.com to scan the deployed site and verify a grade of A or A+.
- Verify the site works correctly with all headers applied (no broken functionality from Permissions-Policy or Referrer-Policy).
- Test embedding the site in an iframe on another domain and verify it is blocked by X-Frame-Options.
- Open the browser console and verify no errors related to the security headers.

## Risk Assessment

- These headers are purely restrictive -- they add constraints but do not change the site's behavior for normal usage.
- `Strict-Transport-Security` with a long `max-age` should only be enabled if the site will always be served over HTTPS. Once set, browsers will refuse to connect over HTTP for the specified duration. Cloudflare Pages enforces HTTPS, so this is safe.
- `Permissions-Policy` restricts browser API access. If the site ever needs to access the camera, microphone, geolocation, or other restricted APIs, the policy will need updating. Currently, the site does not use any of these APIs.
- The `Referrer-Policy` value `strict-origin-when-cross-origin` is the browser default in modern browsers, so this header mainly ensures consistent behavior across all browsers.
