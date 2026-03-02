# Plan: isWikiLink function uses heuristic that may misclassify links

**Issue**: issue-website-16.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/app/components/wiki/MarkdownRenderer.tsx`

## Analysis

In `packages/website/app/components/wiki/MarkdownRenderer.tsx`, lines 7-9, the `isWikiLink` function uses a heuristic to determine if a link should be treated as an internal wiki link:

```typescript
function isWikiLink(href: string): boolean {
  return !href.startsWith("http") && !href.startsWith("#") && !href.includes("/") && !href.includes(".");
}
```

This heuristic has several edge cases:
1. `mailto:user@example.com` -- does not start with "http" and does not contain "/" initially, but contains "." so it would be caught. However, `mailto:` without a domain (e.g., `mailto:user`) would pass.
2. `ftp://files.example.com` -- starts with "ftp", not "http", but contains "/" and "." so it would be caught.
3. `//cdn.example.com/file` -- starts with "//", contains "/", so caught by the "/" check.
4. Wiki page slugs with dots (e.g., `v2.0-Migration`) -- contains ".", would be misclassified as an external link.
5. Links like `javascript:alert(1)` -- does not start with "http", no "/" or ".", would be classified as a wiki link (though react-markdown may strip these).

The most practical concern is that `mailto:` links without dots and `javascript:` URIs could be misclassified.

## Fix Steps

1. **Replace the heuristic with a more robust check** in `packages/website/app/components/wiki/MarkdownRenderer.tsx`. Replace lines 7-9:

   ```typescript
   function isWikiLink(href: string): boolean {
     // External protocols (http:, https:, mailto:, ftp:, tel:, javascript:, etc.)
     if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
     // Protocol-relative URLs
     if (href.startsWith('//')) return false;
     // Anchor links
     if (href.startsWith('#')) return false;
     // Relative paths with directories
     if (href.includes('/')) return false;
     // File extensions (e.g., .pdf, .png, .html) -- but not slugs with dots
     if (/\.\w{2,4}$/.test(href)) return false;
     // Anything remaining is treated as a wiki slug
     return true;
   }
   ```

2. **Key improvements**:
   - The regex `^[a-z][a-z0-9+.-]*:/i` matches any URI scheme per RFC 3986 (including `mailto:`, `ftp:`, `tel:`, `javascript:`, `data:`, etc.)
   - Protocol-relative URLs (`//example.com`) are explicitly excluded
   - The file extension check `/\.\w{2,4}$/` only matches common file extensions at the end of the string, allowing wiki slugs with dots in the middle (like `v2.0-Migration`) to still be recognized as wiki links
   - The `/` check for relative paths is retained

3. **The change in behavior** for dots: the old check `!href.includes(".")` rejected any href containing a dot anywhere. The new check `!/\.\w{2,4}$/.test(href)` only rejects hrefs ending with a file-extension-like pattern (2-4 word characters after a dot at the end). This allows slugs like `v2.0-Migration` to be treated as wiki links.

## Testing

- Wiki links like `Architecture`, `Home`, `Getting-Started` should still be classified as wiki links and navigate to `/wiki/${lang}/Architecture`, etc.
- External links like `https://example.com`, `http://example.com` should be classified as external.
- `mailto:user@example.com` should be classified as external (caught by protocol regex).
- `ftp://files.example.com` should be classified as external (caught by protocol regex).
- Anchor links like `#section` should be classified as anchors (not wiki links).
- Links with file extensions like `document.pdf`, `image.png` should be classified as external.
- Links like `v2.0-Migration` should be classified as wiki links (dot not at end with extension pattern).
- `javascript:alert(1)` should be classified as external (caught by protocol regex).

## Risk Assessment

- The protocol regex is well-established (RFC 3986 scheme definition) and handles all standard URI schemes.
- The relaxed dot check (`/\.\w{2,4}$/` vs `includes(".")`) could theoretically allow a link like `file.js` to be treated as external (which is correct), but might miss unusual file extensions longer than 4 characters. This is an acceptable tradeoff since wiki slugs conventionally do not end with file extensions.
- This is a wiki-internal change. External links and hash links continue to behave identically since their checks are unchanged.
- The change is backward-compatible for all current wiki content since existing wiki slugs do not contain dots or protocol prefixes.
