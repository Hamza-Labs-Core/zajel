# [MEDIUM] Wiki route accepts arbitrary lang parameter without validation

**Area**: Website
**File**: packages/website/app/routes/wiki.tsx:50,6 (routes.ts line 6)
**Type**: Security

**Description**: The wiki route is defined as `wiki/:lang?/:slug?` in `routes.ts`, and the `lang` parameter is used directly without validation on line 50: `const lang = params.lang || "en"`. Any arbitrary string can be passed as the language parameter. While the code uses `isArabic` (line 52) to decide which page set to load, the `lang` parameter is also passed to `LanguageSwitch` and `WikiSidebar` where it is interpolated into URL paths like `/wiki/${lang}/${link.slug}`. This means an attacker could craft URLs with a malicious `lang` value that, while not causing XSS directly (React Router's `Link` component handles encoding), creates misleading navigation paths and could be used in social engineering attacks.

**Impact**: Arbitrary values in the `lang` parameter create wiki URLs with unexpected path segments. While the page content falls back correctly (non-Arabic loads English), the generated sidebar and language switch links will contain the arbitrary lang value, potentially confusing users or being used in phishing scenarios.

**Fix**: Validate the `lang` parameter against an allowlist of supported languages and redirect to the default if invalid:
```typescript
const SUPPORTED_LANGS = ['en', 'ar'];
useEffect(() => {
  if (params.lang && !SUPPORTED_LANGS.includes(params.lang)) {
    navigate(`/wiki/en/${slug}`, { replace: true });
  }
}, [params.lang]);
```
