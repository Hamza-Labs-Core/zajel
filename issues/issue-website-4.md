# [MEDIUM] GitHub API response not validated before use

**Area**: Website
**File**: packages/website/app/routes/home.tsx:82-94
**Type**: Security

**Description**: The `fetch(GITHUB_API)` call on line 82 does not check `res.ok` before parsing the JSON response. If the GitHub API returns a non-200 status (rate limited with 403, server error with 500, etc.), the response body will be parsed as JSON and set as the release state. The GitHub API rate-limit response body has a different shape than a release object, and the code proceeds to iterate over `data.assets` (line 88) without verifying the data structure. Additionally, the response type is cast as `Release` without runtime validation, meaning any API response shape is trusted.

**Impact**: When the GitHub API is rate-limited (60 requests/hour for unauthenticated requests), the page will silently fail with potentially undefined behavior. The `data.assets` check on line 86 prevents a crash, but download URLs will remain empty without any user feedback. More critically, if the API endpoint is ever MITM'd or DNS-hijacked, the `browser_download_url` from a spoofed response could point users to malicious download locations.

**Fix**:
1. Check `res.ok` before parsing: `if (!res.ok) throw new Error('API request failed')`.
2. Validate the response structure at runtime before using it.
3. Validate that `browser_download_url` values actually point to `github.com` or `objects.githubusercontent.com` domains before rendering them as download links.
4. Add error state to show users a meaningful message when the API call fails.
5. Consider using a server-side loader to fetch this data with an API token to avoid rate limiting and to prevent exposing the API call to client-side manipulation.
