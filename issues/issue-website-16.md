# [LOW] isWikiLink function uses heuristic that may misclassify links

**Area**: Website
**File**: packages/website/app/components/wiki/MarkdownRenderer.tsx:7-9
**Type**: Bug

**Description**: The `isWikiLink` function determines if a markdown link should be treated as an internal wiki link by checking four negative conditions: not starting with "http", not starting with "#", not containing "/", and not containing ".". This heuristic has edge cases:
1. Links starting with "ftp://" or "mailto:" would be misclassified as wiki links and routed to `/wiki/${lang}/ftp://...` or `/wiki/${lang}/mailto:...`.
2. Links starting with "//" (protocol-relative URLs) would be misclassified as wiki links.
3. Wiki page slugs that legitimately contain dots (e.g., "v2.0-Migration") would be treated as external links.
4. Relative paths like `../other-page` would pass the "/" check since `includes("/")` would catch the slash -- but this is a coincidental fix rather than intentional handling.

**Impact**: Markdown content containing `mailto:`, `ftp://`, or protocol-relative links will be incorrectly routed as wiki pages, resulting in broken links that navigate to nonexistent wiki pages. Wiki pages with dots in their names cannot be linked correctly.

**Fix**: Use a more robust link classification approach:
```typescript
function isWikiLink(href: string): boolean {
  // External protocols
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
  // Protocol-relative URLs
  if (href.startsWith('//')) return false;
  // Anchor links
  if (href.startsWith('#')) return false;
  // Relative paths with directories
  if (href.includes('/')) return false;
  // File extensions (but allow slugs with dots if needed)
  if (/\.\w{2,4}$/.test(href)) return false;
  return true;
}
```
