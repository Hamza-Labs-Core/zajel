# [MEDIUM] Download URLs from external API rendered without domain validation

**Area**: Website
**File**: packages/website/app/routes/home.tsx:65-72,184
**Type**: Security

**Description**: The `findAssetUrl` function extracts `browser_download_url` from the GitHub API response and these URLs are directly used as `href` values in anchor tags (line 184). There is no validation that these URLs actually point to GitHub domains. If the GitHub API response were ever tampered with (e.g., via a supply chain attack on the repository, DNS poisoning, or a compromised GitHub account), users could be directed to download malicious binaries from attacker-controlled domains.

**Impact**: Users could be tricked into downloading malware if the API response is manipulated. Since these are download links for application binaries, the impact is particularly severe -- users would install and run the downloaded files with full trust.

**Fix**: Validate that all `browser_download_url` values match expected GitHub domains before rendering them:
```typescript
function isValidGithubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'github.com' ||
           parsed.hostname.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}
```
Apply this validation in `findAssetUrl` before returning the URL.
