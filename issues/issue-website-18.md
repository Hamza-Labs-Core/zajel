# [MEDIUM] No error boundary for wiki page rendering

**Area**: Website
**File**: packages/website/app/routes/wiki.tsx
**Type**: Bug

**Description**: The wiki route renders user-controlled markdown content through `MarkdownRenderer` and `MermaidDiagram`, but there is no React Error Boundary wrapping these components. If `react-markdown` or Mermaid throws an unhandled error during rendering (e.g., malformed markdown that crashes a remark plugin, or a Mermaid diagram that causes a rendering exception not caught by the try/catch in the effect), the entire page will crash and show React's default error screen or a blank page.

The current error handling in the `useEffect` for page loading (lines 101-105) only catches fetch errors, not rendering errors. The Mermaid component has its own try/catch (line 40) but it only catches async rendering errors, not synchronous errors during component mounting or re-rendering.

**Impact**: A single malformed wiki page can crash the entire application for the user, showing an unrecoverable blank page. Users lose all navigation context and must manually navigate back. This can also be triggered intentionally by crafting a malicious wiki page.

**Fix**: Add a React Error Boundary around the content rendering area:
```typescript
import { ErrorBoundary } from 'react-error-boundary';

// In the JSX:
<ErrorBoundary fallback={<div className="wiki-error">Failed to render page content.</div>}>
  {content && <MarkdownRenderer content={content} lang={lang} />}
</ErrorBoundary>
```
React Router v7 also supports route-level `ErrorBoundary` exports that can be used for this purpose.
