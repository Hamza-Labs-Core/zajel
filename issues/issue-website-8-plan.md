# Plan: External Google Fonts loaded without Subresource Integrity (SRI)

**Issue**: issue-website-8.md
**Severity**: MEDIUM
**Area**: Website
**Files to modify**: `packages/website/app/routes/wiki.tsx`, potentially `packages/website/public/fonts/` (new directory for self-hosted fonts)

## Analysis

In `packages/website/app/routes/wiki.tsx`, lines 40-44 load Google Fonts via external CDN:

```typescript
export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@400;600;700&display=swap" },
];
```

Google Fonts dynamically generates CSS responses based on the user-agent header, making SRI hashes impractical (different browsers get different CSS content). The recommended approach is to self-host the fonts to eliminate the external dependency entirely.

If self-hosting is not feasible in the short term, the CSP headers from issue-website-3 will restrict which external stylesheets can load (`style-src` directive), providing partial mitigation.

## Fix Steps

### Option A: Self-host fonts (recommended)

1. **Download the Noto Sans Arabic font files** in WOFF2 format (the most efficient web font format) for weights 400, 600, and 700.

2. **Create the fonts directory**: `packages/website/public/fonts/`

3. **Add font files** to the public directory:
   - `NotoSansArabic-Regular.woff2`
   - `NotoSansArabic-SemiBold.woff2`
   - `NotoSansArabic-Bold.woff2`

4. **Create a local font CSS file** at `packages/website/app/styles/fonts.css`:
   ```css
   @font-face {
     font-family: 'Noto Sans Arabic';
     font-style: normal;
     font-weight: 400;
     font-display: swap;
     src: url('/fonts/NotoSansArabic-Regular.woff2') format('woff2');
   }

   @font-face {
     font-family: 'Noto Sans Arabic';
     font-style: normal;
     font-weight: 600;
     font-display: swap;
     src: url('/fonts/NotoSansArabic-SemiBold.woff2') format('woff2');
   }

   @font-face {
     font-family: 'Noto Sans Arabic';
     font-style: normal;
     font-weight: 700;
     font-display: swap;
     src: url('/fonts/NotoSansArabic-Bold.woff2') format('woff2');
   }
   ```

5. **Import the font CSS** in `wiki.tsx` and remove the external links. Replace the `links` export (lines 40-44):
   ```typescript
   // Remove the links export entirely (no more external font loading)
   ```
   And add an import at the top:
   ```typescript
   import "~/styles/fonts.css";
   ```

### Option B: Keep external fonts, rely on CSP (short-term)

1. If self-hosting is deferred, the CSP from issue-website-3 already restricts `style-src` to `'self' 'unsafe-inline' https://fonts.googleapis.com` and `font-src` to `'self' https://fonts.gstatic.com`, which limits the attack surface.

2. No changes needed to `wiki.tsx` in this case.

## Testing

- For Option A: Load a wiki page in Arabic (`/wiki/ar/Home`) and verify that Noto Sans Arabic renders correctly.
- Verify that font files are served from the same origin (no external requests to Google).
- Check the network tab in browser dev tools to confirm no requests to `fonts.googleapis.com` or `fonts.gstatic.com`.
- Verify that the font-display: swap behavior works (text is visible immediately, font swaps in when loaded).

## Risk Assessment

- **Option A**: Self-hosting fonts adds files to the repository (~50-100KB per weight in WOFF2). This increases the deployment bundle size but eliminates the external dependency entirely.
- **Option A**: The font files must be kept up-to-date manually if the project wants newer versions of Noto Sans Arabic. This is a minor maintenance burden.
- **Option B**: Relying on CSP alone does not eliminate the risk of a compromised Google Fonts CDN serving malicious CSS, but it significantly limits what an attacker can do (no loading of scripts or connecting to arbitrary domains).
- The font is only used for Arabic wiki pages, so the impact is limited to those pages.
