# Plan: Missing Open Graph image and Twitter card meta tags

**Issue**: issue-website-13.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/app/routes/home.tsx`, `packages/website/app/routes/guide.tsx`, `packages/website/app/routes/wiki.tsx`

## Analysis

The home page meta function at `packages/website/app/routes/home.tsx` lines 7-22 sets `og:title`, `og:description`, and `og:type` but is missing:
- `og:image` -- no preview image for social media sharing
- `og:url` -- no canonical URL
- Twitter Card meta tags (`twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`)

The guide page at `packages/website/app/routes/guide.tsx` lines 6-11 only sets `title` and `description`, with no OpenGraph tags at all.

The wiki page at `packages/website/app/routes/wiki.tsx` lines 35-38 only sets `title` and `description`, with no OpenGraph tags and no dynamic title based on the current page.

## Fix Steps

1. **Create an OG image**: Design and add an Open Graph preview image (recommended 1200x630px) to `packages/website/public/og-image.png`. This image should include the Zajel logo and tagline.

2. **Update home page meta** in `packages/website/app/routes/home.tsx`. Replace lines 7-22:
   ```typescript
   export const meta: MetaFunction = () => {
     return [
       { title: "Zajel - Private P2P Messaging" },
       {
         name: "description",
         content:
           "End-to-end encrypted peer-to-peer messaging. No servers, no tracking, no compromise on privacy.",
       },
       { property: "og:title", content: "Zajel - Private P2P Messaging" },
       {
         property: "og:description",
         content: "End-to-end encrypted peer-to-peer messaging. No servers, no tracking.",
       },
       { property: "og:type", content: "website" },
       { property: "og:url", content: "https://zajel.app/" },
       { property: "og:image", content: "https://zajel.app/og-image.png" },
       { name: "twitter:card", content: "summary_large_image" },
       { name: "twitter:title", content: "Zajel - Private P2P Messaging" },
       {
         name: "twitter:description",
         content: "End-to-end encrypted peer-to-peer messaging. No servers, no tracking.",
       },
       { name: "twitter:image", content: "https://zajel.app/og-image.png" },
     ];
   };
   ```

3. **Update guide page meta** in `packages/website/app/routes/guide.tsx`. Replace lines 6-11:
   ```typescript
   export const meta: MetaFunction = () => {
     return [
       { title: "User Guide - Zajel" },
       { name: "description", content: "Learn how to use Zajel for secure peer-to-peer messaging" },
       { property: "og:title", content: "User Guide - Zajel" },
       { property: "og:description", content: "Learn how to use Zajel for secure peer-to-peer messaging" },
       { property: "og:type", content: "article" },
       { property: "og:url", content: "https://zajel.app/guide" },
       { property: "og:image", content: "https://zajel.app/og-image.png" },
       { name: "twitter:card", content: "summary_large_image" },
       { name: "twitter:title", content: "User Guide - Zajel" },
       { name: "twitter:description", content: "Learn how to use Zajel for secure peer-to-peer messaging" },
       { name: "twitter:image", content: "https://zajel.app/og-image.png" },
     ];
   };
   ```

4. **Update wiki page meta** in `packages/website/app/routes/wiki.tsx`. The wiki meta is static (lines 35-38) and does not reflect the current page. Since the meta function in React Router v7 does not have access to route params for dynamic values by default, keep it static but add OG tags:
   ```typescript
   export const meta: MetaFunction = () => [
     { title: "Developer Wiki - Zajel" },
     { name: "description", content: "Zajel developer documentation -- architecture, protocols, security, and more" },
     { property: "og:title", content: "Developer Wiki - Zajel" },
     { property: "og:description", content: "Zajel developer documentation -- architecture, protocols, security, and more" },
     { property: "og:type", content: "article" },
     { property: "og:image", content: "https://zajel.app/og-image.png" },
     { name: "twitter:card", content: "summary_large_image" },
     { name: "twitter:title", content: "Developer Wiki - Zajel" },
     { name: "twitter:description", content: "Zajel developer documentation" },
     { name: "twitter:image", content: "https://zajel.app/og-image.png" },
   ];
   ```

## Testing

- Use Facebook's Sharing Debugger (https://developers.facebook.com/tools/debug/) to verify the OG tags are correctly parsed for the home, guide, and wiki pages.
- Use Twitter's Card Validator to verify Twitter cards render correctly.
- Share a link to the site on Discord/Slack and verify the preview shows the image, title, and description.
- Verify the OG image exists at the expected URL (`/og-image.png`).

## Risk Assessment

- This is a metadata-only change with no impact on functionality or layout.
- The `og:url` values use `https://zajel.app/` as the domain. If the site is deployed to a different domain, these values need updating.
- The OG image file needs to be created and added to the public directory. Until the image is created, the meta tags will reference a non-existent file, which is harmless (social platforms will just not show an image preview).
- Dynamic wiki page titles in the meta function would require React Router's `meta` function to accept route params, which requires using the `matches` argument or a `loader` function. This is deferred as a future enhancement.
