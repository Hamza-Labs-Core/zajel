# [LOW] Client-side-only data fetching for release info causes layout shift and no SSR

**Area**: Website
**File**: packages/website/app/routes/home.tsx:79-95
**Type**: Best Practice

**Description**: The GitHub release data is fetched entirely on the client side using `useEffect` + `fetch` (lines 79-95). React Router v7 supports server-side loaders that can fetch data before rendering. The current approach has several drawbacks:
1. **No SSR**: The download section renders without any release data on the initial server-rendered HTML, then populates after the client-side fetch completes. This causes a flash of "Coming Soon" on all platforms before the actual download links appear.
2. **Layout shift**: When the release data loads, download cards change from "Coming Soon" to actual download links, and the hero button gains a version tag, causing visible layout shifts (poor Core Web Vitals CLS score).
3. **Rate limiting**: Every visitor makes an unauthenticated GitHub API request, which is rate-limited to 60 requests/hour per IP. High-traffic pages will frequently hit this limit.
4. **SEO impact**: Search engine crawlers will not see download links in the initial HTML.

**Impact**: Users experience a flash of incomplete content on page load. The site is rate-limited by GitHub API. Search engines cannot index download links. Layout shift degrades user experience and Core Web Vitals scores.

**Fix**: Use a React Router `loader` function to fetch release data server-side:
```typescript
export async function loader() {
  const res = await fetch(GITHUB_API, {
    headers: { 'Accept': 'application/vnd.github.v3+json' }
  });
  if (!res.ok) return { release: null };
  return { release: await res.json() };
}
```
This provides data on first render, avoids client-side rate limiting, and improves SEO. Cache the response to reduce API calls further.
