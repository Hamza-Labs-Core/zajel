# [LOW] Missing Open Graph image and Twitter card meta tags

**Area**: Website
**File**: packages/website/app/routes/home.tsx:7-22
**Type**: Best Practice

**Description**: The home page meta function sets `og:title`, `og:description`, and `og:type` but is missing several important social sharing meta tags:
1. No `og:image` -- social media platforms will show no preview image when the site is shared.
2. No `og:url` -- the canonical URL is not specified.
3. No Twitter Card meta tags (`twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`).
4. The guide page (line 6-11) has even fewer meta tags -- only `title` and `description`, no OpenGraph tags at all.
5. The wiki page similarly lacks OpenGraph tags for the specific page being viewed.

**Impact**: When users share links to the website on social media platforms (Twitter, Facebook, LinkedIn, Discord, etc.), the preview will lack an image and may have incomplete metadata, reducing click-through rates and professional appearance. This is particularly important for a privacy-focused project that relies on organic sharing.

**Fix**: Add complete OpenGraph and Twitter Card meta tags to all routes:
```typescript
{ property: "og:image", content: "https://zajel.app/og-image.png" },
{ property: "og:url", content: "https://zajel.app/" },
{ name: "twitter:card", content: "summary_large_image" },
{ name: "twitter:title", content: "Zajel - Private P2P Messaging" },
{ name: "twitter:description", content: "End-to-end encrypted peer-to-peer messaging." },
{ name: "twitter:image", content: "https://zajel.app/og-image.png" },
```
For the wiki route, dynamically set the `og:title` based on the current page slug.
