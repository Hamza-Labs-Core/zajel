# Plan: No rel="noopener noreferrer" on download links from external API

**Issue**: issue-website-10.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/app/routes/home.tsx`

## Analysis

In `packages/website/app/routes/home.tsx`, the download card anchor tags at lines 184-199 use `href={url || "#"}` where `url` comes from the GitHub API `browser_download_url`:

```tsx
<a
  key={key}
  href={url || "#"}
  className={`download-card ${isDisabled ? "disabled" : ""} ${
    isRecommended && !isDisabled ? "recommended" : ""
  }`}
  onClick={(e) => isDisabled && e.preventDefault()}
>
```

These links do not have `target="_blank"` or `rel="noreferrer"`. While they open in the same tab (so reverse tabnapping is not a risk), the `Referer` header is sent to GitHub's CDN when users click download links, leaking the current page URL. For better UX, downloads should open in a new tab so users remain on the site.

Note that the "View All Releases on GitHub" link at lines 203-209 correctly uses `target="_blank" rel="noopener noreferrer"`.

## Fix Steps

1. **Add `target="_blank"` and `rel="noopener noreferrer"` to the download card anchor tags** in `packages/website/app/routes/home.tsx`. Modify the `<a>` tag at line 184 to include these attributes:

   ```tsx
   <a
     key={key}
     href={url || "#"}
     className={`download-card ${isDisabled ? "disabled" : ""} ${
       isRecommended && !isDisabled ? "recommended" : ""
     }`}
     onClick={(e) => isDisabled && e.preventDefault()}
     target={url ? "_blank" : undefined}
     rel={url ? "noopener noreferrer" : undefined}
   >
   ```

2. **Conditionally apply the attributes**: Only set `target="_blank"` and `rel` when there is an actual URL (not for disabled cards with `href="#"`). This avoids opening a blank tab when a disabled card is clicked.

## Testing

- Click a download link and verify it opens in a new tab.
- Check the network tab to verify the `Referer` header is not sent to `objects.githubusercontent.com` (due to `noreferrer`).
- Click a disabled "Coming Soon" card and verify nothing happens (no new tab opens).
- Verify the download completes successfully in the new tab.

## Risk Assessment

- Very low risk change. Adding `target="_blank"` changes the UX slightly (downloads open in new tab instead of navigating away), but this is the standard pattern for download links and better for user experience.
- The `noopener` attribute prevents the opened page from accessing `window.opener`, which is a minor security best practice.
- The `noreferrer` attribute prevents the `Referer` header from being sent, which is a minor privacy improvement.
