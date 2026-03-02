# Plan: Guide page uses anchor tags for in-page navigation instead of proper scroll handling

**Issue**: issue-website-19.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/app/styles/global.css`

## Analysis

The guide page at `packages/website/app/routes/guide.tsx` (lines 29-44) uses standard `<a href="#section">` anchor tags for table of contents navigation:

```tsx
<li><a href="#getting-started">Getting Started</a></li>
<li><a href="#features">Features</a></li>
<li><a href="#troubleshooting">Troubleshooting</a></li>
<li><a href="#security">Security</a></li>
<li><a href="#faq">FAQ</a></li>
```

These correspond to headings with matching IDs (e.g., line 47: `<h2 id="getting-started">Getting Started</h2>`).

The browser's native hash scrolling works but:
1. The scroll jump is abrupt with no smooth animation.
2. The sticky nav bar (60px tall, from `.nav` CSS with `position: sticky; top: 0`) may overlap the scroll target since the browser scrolls the target to the very top of the viewport.

The home page Nav component (`Nav.tsx` lines 10-11) uses `<a href="/#features">` and `<a href="/#download">` for cross-page hash links, which have the same scrolling issues.

## Fix Steps

1. **Add `scroll-behavior: smooth`** to the `html` element in `packages/website/app/styles/global.css`. Add after the `*` selector reset (after line 18):

   ```css
   html {
     scroll-behavior: smooth;
   }
   ```

2. **Add `scroll-padding-top`** to account for the sticky navigation bar. The nav bar is approximately 60px tall (from the `.nav` padding of `1rem` = 16px top + 16px bottom = 32px + line height approximately 28px = ~60px). Add to the same `html` rule:

   ```css
   html {
     scroll-behavior: smooth;
     scroll-padding-top: 5rem; /* Accounts for sticky nav bar height */
   }
   ```

3. **This single CSS change** fixes both the guide page in-page navigation and the home page hash links from the Nav component, since `scroll-behavior` and `scroll-padding-top` are inherited properties that affect all hash-based scrolling on the page.

## Testing

- Navigate to the guide page and click a table of contents link (e.g., "Getting Started"). Verify:
  - The page scrolls smoothly to the target section
  - The target heading is not hidden behind the sticky nav bar
- From the wiki or guide page, click the "Features" or "Download" link in the main navigation. Verify:
  - The page navigates to the home page
  - The viewport scrolls smoothly to the target section
  - The target section heading is visible below the nav bar
- Click the browser's back button after hash navigation and verify it scrolls back correctly.

## Risk Assessment

- `scroll-behavior: smooth` is widely supported in modern browsers (94%+ global support).
- The `scroll-padding-top: 5rem` value should be adjusted if the nav bar height changes. Using `rem` units ensures it scales with the user's font size preference.
- Some users prefer reduced motion. Consider adding a media query to respect the user's preference:
  ```css
  @media (prefers-reduced-motion: reduce) {
    html {
      scroll-behavior: auto;
    }
  }
  ```
  This should be added as a follow-up accessibility improvement.
- `scroll-behavior: smooth` affects all scrolling in the document, including programmatic calls to `element.scrollIntoView()`. This is generally desirable but should be noted.
