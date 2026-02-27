# [LOW] HTML lang attribute hardcoded to "en" even on Arabic wiki pages

**Area**: Website
**File**: packages/website/app/root.tsx:18
**Type**: Best Practice

**Description**: The `<html lang="en">` attribute in the root layout is hardcoded to "en" (line 18). When a user navigates to the Arabic wiki pages (`/wiki/ar/*`), the HTML document still declares `lang="en"`. While the wiki layout adds `dir="rtl"` on a nested `<div>`, the document-level `lang` attribute remains incorrect. The `lang` attribute is used by screen readers to select the correct pronunciation rules, by browsers for hyphenation and other language-specific behaviors, and by search engines for content classification.

**Impact**: Screen readers will use English pronunciation rules when reading Arabic content, making the Arabic wiki pages inaccessible to visually impaired users. Search engines may incorrectly classify Arabic pages as English content. Browser-level text rendering features (hyphenation, quotation marks, etc.) will use English rules.

**Fix**: Dynamically set the `lang` attribute based on the current route. This can be done by:
1. Using a context provider or route-level data to pass the language to the root layout.
2. Using a `useEffect` in the wiki route to update `document.documentElement.lang` when the language changes:
```typescript
useEffect(() => {
  document.documentElement.lang = lang;
  return () => { document.documentElement.lang = 'en'; };
}, [lang]);
```
