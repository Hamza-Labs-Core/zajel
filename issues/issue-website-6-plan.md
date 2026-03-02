# Plan: Mermaid securityLevel not set to strict

**Issue**: issue-website-6.md
**Severity**: MEDIUM
**Area**: Website
**Files to modify**: `packages/website/app/components/wiki/MermaidDiagram.tsx`

## Analysis

In `packages/website/app/components/wiki/MermaidDiagram.tsx`, the Mermaid library is initialized at lines 19-32:

```typescript
mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  themeVariables: {
    darkMode: true,
    background: "#1e293b",
    primaryColor: "#6366f1",
    // ...
  },
});
```

The `securityLevel` option is not explicitly set. While Mermaid v11 defaults to `'strict'`, the project uses `"mermaid": "^11.12.2"` with a caret range, meaning future minor or patch versions could theoretically change this default. Explicitly setting `securityLevel: 'strict'` ensures that:
- Click interactions on diagram nodes are disabled
- HTML labels are sanitized
- The XSS attack surface is minimized regardless of Mermaid version

This fix is closely related to issue-website-1 (innerHTML injection) and should be applied together for defense-in-depth.

## Fix Steps

1. **Add `securityLevel: 'strict'`** to the `mermaid.initialize()` call in `MermaidDiagram.tsx` at line 19. Update to:
   ```typescript
   mermaid.initialize({
     startOnLoad: false,
     securityLevel: 'strict',
     theme: "dark",
     themeVariables: {
       darkMode: true,
       background: "#1e293b",
       primaryColor: "#6366f1",
       primaryTextColor: "#f8fafc",
       primaryBorderColor: "#4f46e5",
       lineColor: "#94a3b8",
       secondaryColor: "#334155",
       tertiaryColor: "#0f172a",
     },
   });
   ```

2. The change is a single line addition at the beginning of the configuration object.

## Testing

- Render wiki pages with various Mermaid diagram types (flowchart, sequence, class, gantt, state) and verify they all render correctly.
- Verify that click interactions on diagram nodes are disabled (clicking a node should do nothing).
- Test a Mermaid diagram with HTML labels (e.g., `A["<b>Bold</b>"]`) and verify the HTML is sanitized or rendered as text.
- Check the browser console for any Mermaid warnings about the security level.

## Risk Assessment

- This is a minimal change with very low risk. The `strict` security level is the default in Mermaid v11+ and is the recommended setting.
- In strict mode, node click events are disabled. The wiki does not use Mermaid's click interaction feature, so this has no functional impact.
- HTML labels in diagrams will be sanitized. If any wiki diagrams use HTML formatting in node labels, they may render differently (as plain text instead of formatted HTML). This is acceptable for security.
