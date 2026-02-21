# [MEDIUM] Mermaid module-level mutable state causes issues in SSR and concurrent rendering

**Area**: Website
**File**: packages/website/app/components/wiki/MermaidDiagram.tsx:3-4
**Type**: Bug

**Description**: The `MermaidDiagram` component uses module-level mutable variables `mermaidInitialized` and `idCounter` (lines 3-4). These persist across the entire module lifecycle and present two problems:
1. **SSR leak**: In a server-side rendered environment (React Router supports SSR), these module-level variables persist across all requests on the server, meaning the `idCounter` increments globally across all users' requests and `mermaidInitialized` could be set to true on the server (though the effect only runs client-side, the variable is shared).
2. **Non-deterministic IDs**: The `idCounter` increments on every component instantiation, meaning the same page rendered at different times will generate different element IDs. In React 18+ with concurrent features, components can be instantiated multiple times during rendering, leading to ID mismatches between what is stored in `idRef` and what Mermaid rendered.

**Impact**: In SSR mode, the counter leaks across requests, causing non-deterministic DOM element IDs. In concurrent rendering, duplicate or skipped IDs can cause Mermaid rendering failures or DOM conflicts.

**Fix**: Use `React.useId()` (available in React 18+/19) to generate stable, unique IDs that work correctly in both SSR and concurrent rendering:
```typescript
import { useId } from "react";

export function MermaidDiagram({ chart }: { chart: string }) {
  const id = useId();
  const mermaidId = `mermaid-${id.replace(/:/g, '')}`;
  // Use mermaidId instead of idRef.current
}
```
For the initialization flag, use a ref or a module-level WeakSet keyed on the mermaid module instance.
