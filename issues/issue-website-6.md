# [MEDIUM] Mermaid securityLevel not set to strict

**Area**: Website
**File**: packages/website/app/components/wiki/MermaidDiagram.tsx:19-33
**Type**: Security

**Description**: The Mermaid library is initialized without setting the `securityLevel` configuration option. The default value for `securityLevel` in Mermaid is `'strict'` in recent versions, but older versions default to `'loose'`. Given that the project uses `"mermaid": "^11.12.2"` with a caret range, minor version updates could potentially change behavior. Explicitly setting `securityLevel: 'strict'` ensures that Mermaid's built-in XSS protections are always active regardless of version changes. In strict mode, Mermaid disables click interactions and sanitizes HTML labels, reducing the XSS attack surface.

**Impact**: Without explicitly enforcing strict security level, crafted Mermaid diagrams could potentially execute JavaScript through click handlers or HTML labels, depending on the Mermaid version resolved.

**Fix**: Add `securityLevel: 'strict'` to the Mermaid initialization configuration:
```typescript
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: "dark",
  // ... rest of config
});
```
