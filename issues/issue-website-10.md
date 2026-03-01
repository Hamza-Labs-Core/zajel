# [LOW] No rel="noopener noreferrer" on download links from external API

**Area**: Website
**File**: packages/website/app/routes/home.tsx:184
**Type**: Security

**Description**: The download card anchor tags (line 184) use `href={url || "#"}` where `url` comes from the GitHub API `browser_download_url`. These links do not have `target="_blank"` so they navigate in the same tab, which means `noopener` is not strictly needed for the reverse tabnapping attack vector. However, these links point to external domains (GitHub's asset CDN) and lack `rel="noopener noreferrer"`. While same-tab navigation mitigates reverse tabnapping, the `noreferrer` attribute is still relevant to prevent the Referer header from leaking the current page URL to GitHub's CDN, which is a minor privacy concern.

**Impact**: The current page URL is sent in the `Referer` header when users click download links. This is a minor information leakage concern. No reverse tabnapping risk since the links open in the same tab.

**Fix**: Add `rel="noreferrer"` to the download card links to prevent Referer header leakage. If the downloads should open in a new tab (better UX to keep users on the site), add both `target="_blank"` and `rel="noopener noreferrer"`.
