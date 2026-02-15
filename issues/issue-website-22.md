# [LOW] CSS universal reset with * selector impacts performance and overrides browser defaults

**Area**: Website
**File**: packages/website/app/styles/global.css:14-18
**Type**: Best Practice

**Description**: The global CSS uses a universal selector reset on lines 14-18:
```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
```
While `box-sizing: border-box` on `*` is a widely accepted modern practice, resetting `margin` and `padding` on every element has performance and maintenance implications:
1. The universal selector applies to every DOM element including pseudo-elements, which has a minor performance cost on large pages (wiki pages with many elements).
2. It removes browser default styling from semantic elements like `<blockquote>`, `<figure>`, `<fieldset>`, `<details>`, etc., which then need to be re-styled manually.
3. It can conflict with third-party component styles (e.g., Mermaid's SVG output may rely on default margins).

**Impact**: Minor performance cost on pages with many DOM nodes. Potential visual regressions when new semantic HTML elements are used without re-applying their expected spacing. The Mermaid diagrams may have unexpected spacing behavior.

**Fix**: Use a more targeted reset approach:
```css
*, *::before, *::after {
  box-sizing: border-box;
}

body {
  margin: 0;
}
```
This preserves the useful `box-sizing` reset while leaving element-specific margins and padding to be handled by component-level styles. Consider using a modern CSS reset like Josh Comeau's custom reset or Andy Bell's modern reset.
