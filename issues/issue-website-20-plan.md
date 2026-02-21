# Plan: MarkdownRenderer code component shadows outer lang variable

**Issue**: issue-website-20.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/app/components/wiki/MarkdownRenderer.tsx`

## Analysis

In `packages/website/app/components/wiki/MarkdownRenderer.tsx`, the `code` handler inside the `components` object (lines 31-48) declares a local variable `lang` on line 33:

```typescript
code({ className, children }) {
  const match = /language-(\w+)/.exec(className || "");
  const lang = match ? match[1] : "";  // <-- shadows outer `lang` prop
  const codeStr = String(children).replace(/\n$/, "");

  if (lang === "mermaid") {  // Here `lang` refers to code language, not locale
    return <MermaidDiagram chart={codeStr} />;
  }
```

The outer `lang` parameter of the `MarkdownRenderer` component (line 11) is the locale string ("en" or "ar"):

```typescript
export function MarkdownRenderer({ content, lang }: { content: string; lang: string }) {
```

The inner `lang` (code block language identifier like "javascript", "mermaid") shadows the outer `lang` (locale). While this has no current functional impact (the inner `lang` is only used for code language detection, and the outer `lang` is only used in the `a` handler for wiki links), it creates a maintenance hazard.

## Fix Steps

1. **Rename the inner variable** in `packages/website/app/components/wiki/MarkdownRenderer.tsx`. Replace lines 32-33:

   ```typescript
   const match = /language-(\w+)/.exec(className || "");
   const lang = match ? match[1] : "";
   ```
   with:
   ```typescript
   const match = /language-(\w+)/.exec(className || "");
   const codeLang = match ? match[1] : "";
   ```

2. **Update all references** to the renamed variable within the `code` handler. Replace line 36:
   ```typescript
   if (lang === "mermaid") {
   ```
   with:
   ```typescript
   if (codeLang === "mermaid") {
   ```

3. **Replace line 40**:
   ```typescript
   if (lang) {
   ```
   with:
   ```typescript
   if (codeLang) {
   ```

## Testing

- Render a wiki page with code blocks (both fenced with language identifiers and inline code) and verify they render correctly.
- Render a wiki page with a Mermaid diagram and verify it still triggers the MermaidDiagram component.
- Render a wiki page with inline code (no language identifier) and verify it renders as inline `<code>`.
- Verify that wiki links inside markdown still navigate correctly (the outer `lang` prop is still accessible).

## Risk Assessment

- This is a pure rename with no behavioral change. The code functions identically before and after the change.
- The risk is effectively zero since all usages of the variable within the `code` handler are updated consistently.
- This prevents future bugs where a developer might reference `lang` inside the `code` handler expecting the locale and getting the code language instead.
