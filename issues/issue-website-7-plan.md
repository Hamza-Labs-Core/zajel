# Plan: Wiki route accepts arbitrary lang parameter without validation

**Issue**: issue-website-7.md
**Severity**: MEDIUM
**Area**: Website
**Files to modify**: `packages/website/app/routes/wiki.tsx`

## Analysis

In `packages/website/app/routes/wiki.tsx`, line 50 accepts any string as the language parameter:

```typescript
const lang = params.lang || "en";
```

The route is defined as `wiki/:lang?/:slug?` in `routes.ts` (line 6), making `lang` a user-controlled URL path segment. While the `isArabic` check on line 52 (`const isArabic = lang === "ar"`) means only "ar" triggers Arabic content, any other value falls through to English content. However, the arbitrary `lang` value is propagated to:

- `LanguageSwitch` component (line 133): generates links like `/wiki/${lang}/${slug}` where `lang` is the arbitrary value
- `WikiSidebar` component (line 126): generates sidebar links like `/wiki/${lang}/${link.slug}`

So if a user visits `/wiki/xyz/Home`, the sidebar and language switch will generate links containing `xyz` as the language prefix, creating a confusing navigation state where every link perpetuates the invalid language parameter.

## Fix Steps

1. **Define a supported languages constant** at the top of `packages/website/app/routes/wiki.tsx` (after the imports):
   ```typescript
   const SUPPORTED_LANGS = ["en", "ar"] as const;
   type SupportedLang = typeof SUPPORTED_LANGS[number];

   function isSupportedLang(lang: string): lang is SupportedLang {
     return (SUPPORTED_LANGS as readonly string[]).includes(lang);
   }
   ```

2. **Validate and redirect** in the existing redirect `useEffect` (lines 60-64). Replace:
   ```typescript
   useEffect(() => {
     if (!params.lang) {
       navigate("/wiki/en", { replace: true });
     }
   }, [params.lang, navigate]);
   ```
   with:
   ```typescript
   useEffect(() => {
     if (!params.lang || !isSupportedLang(params.lang)) {
       navigate(`/wiki/en${slug !== "Home" ? `/${slug}` : ""}`, { replace: true });
     }
   }, [params.lang, navigate, slug]);
   ```

3. **Update the early return** at line 118 to also guard against invalid languages:
   ```typescript
   if (!params.lang || !isSupportedLang(params.lang)) return null; // Will redirect
   ```

## Testing

- Navigate to `/wiki/en/Home` and verify normal behavior.
- Navigate to `/wiki/ar/Home` and verify Arabic wiki loads correctly.
- Navigate to `/wiki/xyz/Home` and verify it redirects to `/wiki/en/Home`.
- Navigate to `/wiki/xyz/Architecture` and verify it redirects to `/wiki/en/Architecture`.
- Navigate to `/wiki` (no lang) and verify it redirects to `/wiki/en`.
- Verify that sidebar links and language switch links use valid language values after redirect.

## Risk Assessment

- The redirect uses `{ replace: true }` so it does not create extra history entries.
- The redirect preserves the slug, so if a user has an invalid language in a bookmarked URL, they are redirected to the English version of the same page.
- This change is backward-compatible: all existing valid URLs (`/wiki/en/*`, `/wiki/ar/*`) continue to work as before.
- Adding new supported languages in the future requires updating the `SUPPORTED_LANGS` array.
