# Plan: CSS universal reset with * selector impacts performance and overrides browser defaults

**Issue**: issue-website-22.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/app/styles/global.css`

## Analysis

In `packages/website/app/styles/global.css`, lines 14-18, a universal selector reset is applied:

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
```

While `box-sizing: border-box` on `*` is a widely accepted modern practice, resetting `margin` and `padding` on every element has implications:

1. **Performance**: The universal selector matches every DOM element including pseudo-elements. On wiki pages with many elements (tables, code blocks, lists, Mermaid SVGs), this has a minor performance cost.
2. **Browser defaults overridden**: Semantic elements like `<blockquote>`, `<figure>`, `<fieldset>`, `<details>`, `<summary>` lose their default spacing. The wiki markdown styles (in `wiki.css`) re-add margins for elements like `p`, `ul`, `ol`, `blockquote`, etc., but any new elements used would need explicit styling.
3. **Third-party conflicts**: Mermaid's SVG output relies on certain element spacing. The `margin: 0; padding: 0` reset could affect Mermaid's internal layout, though this is typically not an issue since SVG elements use their own coordinate system.

The existing `body` style at lines 20-25 already sets `margin: 0` via a separate rule. The component-level styles in `global.css` and `wiki.css` re-add margins/padding where needed.

## Fix Steps

1. **Replace the universal reset** in `packages/website/app/styles/global.css`. Replace lines 14-18:

   ```css
   * {
     margin: 0;
     padding: 0;
     box-sizing: border-box;
   }
   ```

   with a more targeted reset:

   ```css
   *, *::before, *::after {
     box-sizing: border-box;
   }

   body {
     margin: 0;
   }
   ```

2. **However**, this change will cause visual regressions because many elements in the existing styles rely on the `margin: 0; padding: 0` reset being applied universally. Elements like `<h1>`, `<h2>`, `<h3>`, `<p>`, `<ul>`, `<ol>`, `<nav>`, `<section>`, `<figure>` all have browser-default margins that are currently being reset by the universal selector and then re-set by component styles.

3. **A safer incremental approach**: Keep the universal reset for now but expand it to explicitly include pseudo-elements and add a comment documenting the tradeoff:

   ```css
   *, *::before, *::after {
     margin: 0;
     padding: 0;
     box-sizing: border-box;
   }
   ```

4. **If pursuing the full refactor**, audit every element used in the site for its expected spacing:
   - Check `global.css` for any element that relies on the reset (headings, paragraphs, lists, nav, sections, etc.)
   - Check `wiki.css` for elements that re-add margins after the reset
   - Add explicit margin/padding to any element that needs it but does not have it in component-level styles
   - This is a significant refactoring effort with high regression risk

## Testing

- For the safe incremental approach (step 3): Compare the visual output of all pages (home, guide, wiki) before and after the change. There should be no visual difference since `*::before` and `*::after` were not previously reset.
- For the full refactor (step 4): Visually inspect every page and compare pixel-by-pixel with the current design. Pay special attention to:
  - Home page hero section spacing
  - Feature cards layout
  - Download cards layout
  - Guide page typography and spacing
  - Wiki page markdown content rendering
  - Wiki sidebar spacing
  - Mermaid diagram rendering

## Risk Assessment

- **Safe incremental approach**: Very low risk. Adding `*::before, *::after` to the existing reset only extends the `box-sizing: border-box` and `margin/padding: 0` to pseudo-elements, which is the standard modern approach.
- **Full refactor**: High risk of visual regressions. Every page would need visual testing. This should only be done with comprehensive visual regression tests in place.
- **Recommendation**: Apply the safe incremental approach (step 3) now. The full refactor to remove `margin: 0; padding: 0` from the universal reset should be deferred until visual regression testing is available, or done as a separate, carefully reviewed change.
- The performance impact of the universal selector on the current site is negligible (the wiki pages have hundreds, not thousands, of DOM elements). This is more of a best-practice concern than a real-world performance issue.
