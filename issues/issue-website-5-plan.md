# Plan: Download URLs from external API rendered without domain validation

**Issue**: issue-website-5.md
**Severity**: MEDIUM
**Area**: Website
**Files to modify**: `packages/website/app/routes/home.tsx`

## Analysis

In `packages/website/app/routes/home.tsx`, the `findAssetUrl` function (lines 65-72) extracts `browser_download_url` from the GitHub API response and returns it directly:

```typescript
function findAssetUrl(assets: ReleaseAsset[], platform: string): string | null {
  const ext = platforms[platform].extension;
  const asset = assets.find((a) => {
    const name = a.name.toLowerCase();
    return name.includes(platform) && (name.endsWith(`.${ext}`) || name.endsWith(".zip"));
  });
  return asset ? asset.browser_download_url : null;
}
```

These URLs are then used as `href` values in anchor tags at line 184-186:
```tsx
<a key={key} href={url || "#"} ...>
```

There is no validation that the URLs point to legitimate GitHub domains. If the API response were ever tampered with (DNS poisoning, compromised repository, MITM on the API call), users could be directed to download malicious binaries from attacker-controlled servers.

## Fix Steps

1. **Add a URL validation function** in `packages/website/app/routes/home.tsx`, before the `findAssetUrl` function:
   ```typescript
   function isValidGithubDownloadUrl(url: string): boolean {
     try {
       const parsed = new URL(url);
       return (
         parsed.protocol === 'https:' &&
         (parsed.hostname === 'github.com' ||
          parsed.hostname.endsWith('.githubusercontent.com'))
       );
     } catch {
       return false;
     }
   }
   ```

2. **Apply validation in `findAssetUrl`** (line 71). Replace:
   ```typescript
   return asset ? asset.browser_download_url : null;
   ```
   with:
   ```typescript
   if (asset && isValidGithubDownloadUrl(asset.browser_download_url)) {
     return asset.browser_download_url;
   }
   return null;
   ```

3. **This ensures** that any URL not pointing to `github.com` or `*.githubusercontent.com` over HTTPS is treated as if no download is available, falling back to the "Coming Soon" state for that platform.

## Testing

- Load the home page normally and verify that all valid download URLs still work (they should point to `github.com` or `*.githubusercontent.com`).
- In a test scenario, manually modify the API response (using browser dev tools network interception) to include a `browser_download_url` pointing to `https://evil.com/malware.apk` and verify it is rejected (platform shows "Coming Soon" instead).
- Verify that the function correctly handles malformed URLs (empty string, non-URL strings) by returning `false`.

## Risk Assessment

- This is a purely additive validation. Valid GitHub URLs will continue to work as before.
- The validation uses an allowlist approach (only `github.com` and `*.githubusercontent.com` are accepted), which is the most secure approach.
- If GitHub ever changes its CDN domain for release assets, the allowlist will need updating. This is preferable to the alternative of allowing any domain.
- The `endsWith('.githubusercontent.com')` check covers subdomains like `objects.githubusercontent.com` used for release assets.
