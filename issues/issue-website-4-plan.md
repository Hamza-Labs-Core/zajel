# Plan: GitHub API response not validated before use

**Issue**: issue-website-4.md
**Severity**: MEDIUM
**Area**: Website
**Files to modify**: `packages/website/app/routes/home.tsx`

## Analysis

In `packages/website/app/routes/home.tsx`, the `useEffect` on lines 79-95 fetches the GitHub API without checking `res.ok` before parsing:

```typescript
fetch(GITHUB_API)
  .then((res) => res.json())
  .then((data: Release) => {
    setRelease(data);
    if (data.assets) {
      // ...
    }
  })
  .catch(console.error);
```

Line 82: `res.json()` is called unconditionally, even on 403 (rate limited), 404 (not found), or 500 (server error) responses. The GitHub rate-limit response body (`{ "message": "API rate limit exceeded", "documentation_url": "..." }`) does not have `assets` or `tag_name` properties. While the `if (data.assets)` check on line 86 prevents a crash, the `setRelease(data)` on line 85 still sets invalid data, and `release?.tag_name` on line 111 may render the rate-limit message string or `undefined`.

Additionally, the `browser_download_url` values from the API response (used in `findAssetUrl` on line 71) are not validated against expected GitHub domains. This is covered in issue-website-5 but is related.

## Fix Steps

1. **Add `res.ok` check** before parsing the response. In `packages/website/app/routes/home.tsx`, replace lines 82-94:
   ```typescript
   fetch(GITHUB_API)
     .then((res) => {
       if (!res.ok) {
         throw new Error(`GitHub API returned ${res.status}`);
       }
       return res.json();
     })
     .then((data: Release) => {
       if (!data.tag_name || !Array.isArray(data.assets)) {
         throw new Error('Invalid release data structure');
       }
       setRelease(data);
       const urls: Record<string, string | null> = {};
       Object.keys(platforms).forEach((p) => {
         urls[p] = findAssetUrl(data.assets, p);
       });
       setDownloadUrls(urls);
     })
     .catch((err) => {
       console.error('Failed to fetch release data:', err);
     });
   ```

2. **Add runtime validation** of the response structure. Before calling `setRelease(data)`, verify that `data.tag_name` is a string and `data.assets` is an array. This guards against malformed or spoofed API responses.

3. **Remove the `if (data.assets)` guard** that was previously needed (line 86) since the validation above now ensures `data.assets` is always present and valid when we reach that code.

4. **Consider adding an error state** to provide user feedback when the API call fails:
   ```typescript
   const [fetchError, setFetchError] = useState(false);
   ```
   Set `setFetchError(true)` in the catch block. This can be used later to show a "Could not load release info" message in the download section if desired.

## Testing

- Load the home page with a working internet connection and verify that release data populates correctly (version tag in hero button, download URLs in cards).
- Simulate a rate-limited response by temporarily changing `GITHUB_API` to a URL that returns a 403 and verify the page renders gracefully without the release data (all platforms show "Coming Soon").
- Verify that `console.error` is called with a descriptive message when the API fails.
- Check that no uncaught promise rejections appear in the console.

## Risk Assessment

- This is a non-breaking change. The download section already has a fallback for when URLs are not available (shows "Coming Soon" text).
- The additional validation adds a small amount of processing overhead that is negligible compared to the network request itself.
- The error is logged to `console.error` but not shown to the user. A future enhancement could add a user-facing error message, but for now the graceful degradation (showing "Coming Soon" for all platforms) is acceptable.
