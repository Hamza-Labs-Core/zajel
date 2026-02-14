# Plan: No error boundary for wiki page rendering

**Issue**: issue-website-18.md
**Severity**: MEDIUM
**Area**: Website
**Files to modify**: `packages/website/app/routes/wiki.tsx`

## Analysis

In `packages/website/app/routes/wiki.tsx`, the wiki route renders user-controlled markdown content through `MarkdownRenderer` (line 147) and `MermaidDiagram` (called from within MarkdownRenderer). There is no React Error Boundary wrapping these components.

The current rendering section (lines 144-148):
```tsx
{loading ? (
  <div className="wiki-loading">Loading...</div>
) : (
  content && <MarkdownRenderer content={content} lang={lang} />
)}
```

If `react-markdown` or a remark plugin throws an unhandled error during rendering (e.g., from malformed markdown, unexpected content structure, or a bug in a plugin), the entire page crashes. The Mermaid component has a try/catch in its `useEffect` (line 40), but this only catches async errors -- synchronous rendering errors would still propagate.

React Router v7 supports route-level `ErrorBoundary` exports, which is the idiomatic way to handle route errors. Additionally, a more localized Error Boundary around just the content area would provide a better user experience (sidebar and navigation remain functional).

## Fix Steps

1. **Add a React Error Boundary component** for the content rendering area. Since React 19 does not have a built-in functional component Error Boundary, create a class component or use the `react-error-boundary` package. For minimal dependencies, use a class component.

   Add a local Error Boundary at the top of `packages/website/app/routes/wiki.tsx` (after imports):

   ```typescript
   import { Component } from "react";

   class WikiErrorBoundary extends Component<
     { children: React.ReactNode },
     { hasError: boolean }
   > {
     constructor(props: { children: React.ReactNode }) {
       super(props);
       this.state = { hasError: false };
     }

     static getDerivedStateFromError(): { hasError: boolean } {
       return { hasError: true };
     }

     componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
       console.error("Wiki content rendering error:", error, errorInfo);
     }

     render() {
       if (this.state.hasError) {
         return (
           <div className="wiki-markdown">
             <h1>Rendering Error</h1>
             <p>This page could not be rendered. The content may be malformed.</p>
             <p>
               <a href="/wiki/en">Return to Wiki Home</a>
             </p>
           </div>
         );
       }
       return this.props.children;
     }
   }
   ```

2. **Wrap the content rendering** with the Error Boundary. Replace lines 144-148:
   ```tsx
   {loading ? (
     <div className="wiki-loading">Loading...</div>
   ) : (
     <WikiErrorBoundary>
       {content && <MarkdownRenderer content={content} lang={lang} />}
     </WikiErrorBoundary>
   )}
   ```

3. **Add `Component` to the React import** at line 1:
   ```typescript
   import { useEffect, useState, Component } from "react";
   ```

4. **Optionally, also add a route-level ErrorBoundary export** for handling loader/routing errors:
   ```typescript
   export function ErrorBoundary() {
     return (
       <>
         <Nav />
         <div className="wiki-layout">
           <main className="wiki-content">
             <div className="wiki-markdown">
               <h1>Something went wrong</h1>
               <p>An unexpected error occurred. Please try again later.</p>
               <p>
                 <a href="/wiki/en">Return to Wiki Home</a>
               </p>
             </div>
           </main>
         </div>
         <Footer />
       </>
     );
   }
   ```

## Testing

- Navigate to a normal wiki page and verify it renders correctly (Error Boundary should be invisible).
- To test the Error Boundary, temporarily add a component that throws during rendering inside the MarkdownRenderer and verify the fallback UI appears.
- Verify that when the error boundary catches an error, the sidebar and navigation remain functional.
- Verify that navigating to a different wiki page after an error resets the error state.
- Check the browser console for the logged error information.

## Risk Assessment

- Adding an Error Boundary is a purely additive change. Normal rendering behavior is unaffected.
- The Error Boundary only catches rendering errors (during the React render phase). It does not catch errors in event handlers, async code, or server-side rendering. The existing try/catch in the `useEffect` (for page loading) and in MermaidDiagram (for diagram rendering) continue to handle those cases.
- The class component pattern is necessary because React does not support Error Boundaries as functional components. This is a standard React pattern.
- The Error Boundary's `hasError` state persists until the component is remounted. When navigating to a different wiki page, React Router remounts the route component, which resets the Error Boundary state.
