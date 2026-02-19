# [LOW] MarkdownRenderer code component shadows outer lang variable

**Area**: Website
**File**: packages/website/app/components/wiki/MarkdownRenderer.tsx:33
**Type**: Bug

**Description**: Inside the `MarkdownRenderer` component, the `code` handler function declares a local variable `const lang = match ? match[1] : ""` (line 33) which shadows the outer `lang` prop parameter of the `MarkdownRenderer` component (line 11). While this does not currently cause any functional issues because the inner `lang` is only used to check for the `"mermaid"` language identifier and the outer `lang` is used for wiki link routing, it creates a maintenance hazard. If a future developer adds wiki-link handling inside code blocks or uses `lang` inside the code handler expecting the language locale, they will get the code language identifier instead.

**Impact**: No current functional impact, but creates a maintenance hazard. A future code change inside the `code` handler that references `lang` expecting the locale string ("en", "ar") will instead receive the code block language identifier ("javascript", "mermaid", etc.), leading to subtle bugs.

**Fix**: Rename the inner variable to avoid shadowing:
```typescript
code({ className, children }) {
  const match = /language-(\w+)/.exec(className || "");
  const codeLang = match ? match[1] : "";
  const codeStr = String(children).replace(/\n$/, "");

  if (codeLang === "mermaid") {
    return <MermaidDiagram chart={codeStr} />;
  }
  // ...
}
```
