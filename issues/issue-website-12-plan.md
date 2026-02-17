# Plan: HTML lang attribute hardcoded to "en" even on Arabic wiki pages

**Issue**: issue-website-12.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/app/routes/wiki.tsx`

## Analysis

In `packages/website/app/root.tsx`, line 18 hardcodes the HTML lang attribute:

```tsx
<html lang="en">
```

When users navigate to Arabic wiki pages (`/wiki/ar/*`), the document-level `lang` attribute remains "en" even though the content is in Arabic. The wiki layout does set `dir="rtl"` on a nested `<div>` at line 123 of `wiki.tsx`:

```tsx
<div className="wiki-layout" dir={isArabic ? "rtl" : "ltr"} ...>
```

But the `dir` attribute only controls text direction, not language. The `lang` attribute on `<html>` is used by:
- Screen readers to select pronunciation rules
- Browsers for hyphenation and language-specific rendering
- Search engines for content classification

## Fix Steps

1. **Add a `useEffect` in `packages/website/app/routes/wiki.tsx`** to dynamically update `document.documentElement.lang` when the language changes. Add this effect after the existing effects (around line 116):

   ```typescript
   // Update document language for accessibility
   useEffect(() => {
     document.documentElement.lang = lang;
     return () => {
       document.documentElement.lang = "en";
     };
   }, [lang]);
   ```

2. **This approach**:
   - Sets `document.documentElement.lang` to the current wiki language ("en" or "ar") when the wiki page mounts or the language changes.
   - Restores it to "en" when the wiki component unmounts (navigating away from wiki pages).
   - Works with client-side navigation since React effects run on mount and update.

3. **For SSR considerations**: The server-rendered HTML will still have `lang="en"` since this effect runs client-side only. For full SSR support, a context-based approach would be needed where the root layout reads the language from a React Router outlet context. However, since the wiki route primarily functions as a client-side rendered SPA section (content is loaded via dynamic imports), the `useEffect` approach is sufficient.

## Testing

- Navigate to `/wiki/en/Home` and inspect the `<html>` element -- verify `lang="en"`.
- Navigate to `/wiki/ar/Home` and inspect the `<html>` element -- verify `lang="ar"`.
- Switch between English and Arabic using the language switch and verify the `lang` attribute updates.
- Navigate away from the wiki (e.g., to `/guide`) and verify `lang` resets to "en".
- Use a screen reader on an Arabic wiki page and verify it uses Arabic pronunciation rules.

## Risk Assessment

- Directly manipulating `document.documentElement.lang` is a standard pattern used by many React applications for localization.
- The cleanup function (`return () => { document.documentElement.lang = "en"; }`) ensures the attribute is reset when leaving the wiki, preventing English pages from being incorrectly marked as Arabic.
- This approach does not affect the server-rendered HTML. For SSR, the initial `lang="en"` is correct for non-wiki pages and will be updated on the client during hydration for wiki pages.
- No visual changes result from this fix; it only affects assistive technology and search engine behavior.
