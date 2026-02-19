# Plan: Mermaid module-level mutable state causes issues in SSR and concurrent rendering

**Issue**: issue-website-9.md
**Severity**: MEDIUM
**Area**: Website
**Files to modify**: `packages/website/app/components/wiki/MermaidDiagram.tsx`

## Analysis

In `packages/website/app/components/wiki/MermaidDiagram.tsx`, lines 3-4 declare module-level mutable state:

```typescript
let mermaidInitialized = false;
let idCounter = 0;
```

And line 9 uses the counter in a ref:
```typescript
const idRef = useRef(`mermaid-${++idCounter}`);
```

These variables present two problems:

1. **SSR leak**: In SSR mode (React Router supports SSR), module-level variables persist across all requests on the server. The `idCounter` increments globally across all users' requests, and the IDs become non-deterministic, potentially causing hydration mismatches.

2. **Concurrent rendering**: In React 19 (which this project uses, per `"react": "^19.0.0"`), components can be rendered multiple times during concurrent rendering. Each instantiation increments `idCounter`, leading to ID values that may not match between the render and commit phases.

The `mermaidInitialized` flag is less problematic since the initialization code only runs inside a `useEffect` (client-side only), but it's still module-level mutable state that should be avoided.

## Fix Steps

1. **Replace `idCounter` with `useId()`** from React 19. The `useId()` hook generates stable, unique IDs that work correctly in both SSR and concurrent rendering.

2. **Remove the module-level variables** (`mermaidInitialized` and `idCounter`) from lines 3-4.

3. **Refactor the component**. Replace the entire file content:

   ```typescript
   import { useEffect, useRef, useState, useId } from "react";

   let mermaidInitialized = false;

   export function MermaidDiagram({ chart }: { chart: string }) {
     const containerRef = useRef<HTMLDivElement>(null);
     const [error, setError] = useState(false);
     const reactId = useId();
     const mermaidId = `mermaid-${reactId.replace(/:/g, '')}`;

     useEffect(() => {
       let cancelled = false;

       async function render() {
         try {
           const mermaid = (await import("mermaid")).default;

           if (!mermaidInitialized) {
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
             mermaidInitialized = true;
           }

           const { svg } = await mermaid.render(mermaidId, chart.trim());
           if (!cancelled && containerRef.current) {
             containerRef.current.innerHTML = svg;
           }
         } catch {
           if (!cancelled) setError(true);
         }
       }

       render();
       return () => { cancelled = true; };
     }, [chart, mermaidId]);

     if (error) {
       return <pre className="wiki-mermaid-error">{chart}</pre>;
     }

     return <div ref={containerRef} className="wiki-mermaid" />;
   }
   ```

4. **Key changes**:
   - Import `useId` from React (line 1)
   - Remove `let idCounter = 0;` (previously line 4)
   - Replace `const idRef = useRef(\`mermaid-${++idCounter}\`)` with `useId()` and string transformation
   - The `:` characters in React's `useId()` output (e.g., `:r1:`) are stripped because Mermaid uses the ID as a CSS selector and colons have special meaning in CSS
   - `mermaidInitialized` is kept as module-level state since it's only accessed inside `useEffect` (client-side) and serves as a genuine singleton initialization guard

5. **Add `mermaidId` to the `useEffect` dependency array** since it's now derived from `useId()` and is stable per component instance.

## Testing

- Render multiple Mermaid diagrams on the same wiki page and verify they each render correctly with unique IDs.
- Check the generated DOM to verify that each Mermaid diagram has a unique container ID.
- If SSR is enabled, verify that the server-rendered HTML does not contain Mermaid diagrams (they are client-side only due to `useEffect`) and that hydration completes without warnings.
- Test navigation between wiki pages with Mermaid diagrams and verify diagrams re-render correctly.

## Risk Assessment

- `useId()` is available in React 18+ and the project uses React 19, so this is safe.
- The `replace(/:/g, '')` transformation on the ID is necessary because Mermaid uses the ID as a CSS selector. React's `useId()` returns IDs like `:r1:` which contain colons that are special characters in CSS selectors.
- Keeping `mermaidInitialized` as module-level state is acceptable because it's a client-side initialization guard that should only run once per page load. It will not leak across SSR requests because it's only set inside `useEffect`.
- The `mermaidId` in the dependency array of `useEffect` is stable (same value across re-renders for the same component instance), so it will not cause unnecessary re-renders.
