# Plan: No Content Security Policy (CSP) headers configured

**Issue**: issue-website-3.md
**Severity**: HIGH
**Area**: Website
**Files to modify**: `packages/website/public/_headers` (new file)

## Analysis

The application at `packages/website/app/root.tsx` does not set any Content Security Policy headers. There is no `_headers` file in the `public/` directory (the directory does not even exist yet), no CSP `<meta>` tag in the `<head>` section (lines 19-23 of root.tsx), and no server-side middleware or route-level `headers` export.

Without CSP, any XSS vulnerability (such as the Mermaid innerHTML issue from issue-website-1) can load external scripts, exfiltrate data to arbitrary domains, or import malicious payloads with no restrictions. The site can also be embedded in iframes on any domain, enabling clickjacking.

The site currently loads external resources from:
- `fonts.googleapis.com` (stylesheets, in wiki.tsx line 43)
- `fonts.gstatic.com` (font files, in wiki.tsx lines 41-42)
- `api.github.com` (API calls, in home.tsx line 25)

These must be allowed in the CSP policy.

## Fix Steps

1. **Create the `public/` directory** if it does not exist:
   ```bash
   mkdir -p packages/website/public
   ```

2. **Create `packages/website/public/_headers`** with the following content. Cloudflare Pages automatically processes this file:
   ```
   /*
     Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.github.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'
     X-Frame-Options: DENY
     X-Content-Type-Options: nosniff
     Referrer-Policy: strict-origin-when-cross-origin
     Permissions-Policy: camera=(), microphone=(), geolocation=()
   ```

3. **Note on `'unsafe-inline'` for style-src**: React Router and Mermaid may inject inline styles. The `'unsafe-inline'` directive is needed for style-src to avoid breaking these. If possible in the future, use nonces or hashes to eliminate `'unsafe-inline'`.

4. **Verify that Vite's build process copies `public/` files** to the output. React Router's Vite plugin should do this automatically, but verify by checking the build output directory (`build/client/`).

## Testing

- Build the website and verify that `_headers` is present in `build/client/`.
- Deploy to Cloudflare Pages (or test with `wrangler pages dev ./build/client`) and verify that response headers include the CSP and other security headers.
- Open the browser's developer console and check for CSP violation reports when loading the home page and wiki pages.
- Verify that Google Fonts still load on wiki pages (especially the Arabic font).
- Verify that the GitHub API call on the home page still works.
- Verify that Mermaid diagrams still render (they may inject inline styles).
- Use a tool like securityheaders.com to validate the headers.

## Risk Assessment

- **`'unsafe-inline'` for styles** is a tradeoff -- it weakens the CSP for styles but is required for React's inline styles and Mermaid's SVG output. This can be improved later with nonce-based CSP.
- If Mermaid outputs inline scripts (unlikely in strict mode), the `script-src 'self'` directive will block them, which is the desired behavior.
- The `connect-src` directive restricts API calls to `'self'` and `api.github.com`. If future features add connections to other APIs, the CSP will need updating.
- Cloudflare Pages-specific: the `_headers` file is the standard way to set headers. This approach does not require server-side code changes.
