# Plan: XSS via Mermaid SVG innerHTML injection

**Issue**: issue-website-1.md
**Severity**: HIGH
**Area**: Website
**Files to modify**: `packages/website/app/components/wiki/MermaidDiagram.tsx`, `packages/website/package.json`

## Analysis

The `MermaidDiagram` component at line 38 sets `containerRef.current.innerHTML = svg` with the SVG output from `mermaid.render()`. The Mermaid library has had multiple CVEs (CVE-2023-45809, CVE-2023-46316) where crafted diagram definitions produce SVG containing event handlers (`onload`, `onclick`) or embedded `<script>` tags. While the project uses Mermaid `^11.12.2` which has some built-in sanitization, the `innerHTML` assignment bypasses any React-level protection and trusts the raw SVG string entirely.

The current code (lines 36-38):
```typescript
const { svg } = await mermaid.render(idRef.current, chart.trim());
if (!cancelled && containerRef.current) {
  containerRef.current.innerHTML = svg;
}
```

There is no DOMPurify or any other sanitization step between Mermaid output and DOM injection.

## Fix Steps

1. **Install DOMPurify**: Add `dompurify` and `@types/dompurify` as dependencies in `packages/website/package.json`.
   ```
   npm install dompurify --workspace=zajel-website
   npm install -D @types/dompurify --workspace=zajel-website
   ```

2. **Import DOMPurify** in `MermaidDiagram.tsx`:
   ```typescript
   import DOMPurify from "dompurify";
   ```

3. **Sanitize the SVG output** before assigning to innerHTML at line 38. Replace:
   ```typescript
   containerRef.current.innerHTML = svg;
   ```
   with:
   ```typescript
   containerRef.current.innerHTML = DOMPurify.sanitize(svg, {
     USE_PROFILES: { svg: true, svgFilters: true },
     ADD_TAGS: ['foreignObject'],
   });
   ```

4. **Also set Mermaid securityLevel to strict** (this is covered in issue-website-6, but should be done together for defense-in-depth). At line 19, add `securityLevel: 'strict'` to the `mermaid.initialize()` call.

## Testing

- Render a wiki page containing a standard Mermaid diagram (flowchart, sequence diagram) and verify it still renders correctly after sanitization.
- Attempt to render a Mermaid diagram with injected event handlers (e.g., a node label containing `<img onerror=alert(1)>`) and verify the handler is stripped.
- Verify DOMPurify is included in the production bundle by checking the build output.

## Risk Assessment

- DOMPurify's SVG profile may strip some legitimate Mermaid SVG elements. The `ADD_TAGS: ['foreignObject']` option is included to allow Mermaid's use of foreignObject for text rendering, but some advanced diagram features may need additional tags allowed.
- Adding DOMPurify increases the bundle size by approximately 15-20KB (minified). This is acceptable for a security fix.
- If DOMPurify is too aggressive, test with specific Mermaid diagram types (flowchart, sequence, gantt, class, state) and adjust the sanitization config as needed.
