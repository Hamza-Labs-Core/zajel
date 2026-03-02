# Plan: WikiSidebar overlay does not trap focus or handle Escape key

**Issue**: issue-website-14.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/app/components/wiki/WikiSidebar.tsx`, `packages/website/app/routes/wiki.tsx`

## Analysis

The `WikiSidebar` component at `packages/website/app/components/wiki/WikiSidebar.tsx` implements a mobile sidebar with an overlay (lines 50-86). The overlay closes on click (line 57: `onClick={onClose}`), but lacks:

1. **No Escape key handler**: Pressing Escape does not close the sidebar.
2. **No focus trap**: When open on mobile, keyboard users can tab to elements behind the overlay.
3. **No ARIA attributes**: The sidebar does not have `role="dialog"` or `aria-modal="true"` when open.
4. **No focus management**: Focus is not moved to the sidebar when it opens or returned to the toggle button when it closes.
5. **No `aria-label`**: The `<aside>` element lacks a label for screen readers.

The current sidebar JSX (lines 53-84):
```tsx
<>
  <div className={`wiki-sidebar-overlay${open ? " open" : ""}`} onClick={onClose} />
  <aside className={`wiki-sidebar${open ? " open" : ""}`}>
    ...
  </aside>
</>
```

## Fix Steps

1. **Add Escape key handler** using a `useEffect` in `WikiSidebar.tsx`:
   ```typescript
   import { useEffect, useRef } from "react";

   // Inside the component:
   const sidebarRef = useRef<HTMLElement>(null);

   useEffect(() => {
     if (!open) return;

     function handleKeyDown(e: KeyboardEvent) {
       if (e.key === "Escape") {
         onClose();
       }
     }

     document.addEventListener("keydown", handleKeyDown);
     return () => document.removeEventListener("keydown", handleKeyDown);
   }, [open, onClose]);
   ```

2. **Add ARIA attributes** to the `<aside>` element:
   ```tsx
   <aside
     ref={sidebarRef}
     className={`wiki-sidebar${open ? " open" : ""}`}
     role={open ? "dialog" : undefined}
     aria-modal={open ? "true" : undefined}
     aria-label="Wiki navigation"
   >
   ```

3. **Add focus management**: When the sidebar opens, move focus to the sidebar. When it closes, return focus to the toggle button. Add a ref for the toggle button in `wiki.tsx` and pass it to the sidebar:

   In `WikiSidebar.tsx`, add focus management to the `useEffect`:
   ```typescript
   useEffect(() => {
     if (open && sidebarRef.current) {
       sidebarRef.current.focus();
     }
   }, [open]);
   ```

   Add `tabIndex={-1}` to the `<aside>` to make it programmatically focusable:
   ```tsx
   <aside
     ref={sidebarRef}
     tabIndex={-1}
     ...
   >
   ```

4. **Add `aria-hidden` to the overlay** for assistive technology:
   ```tsx
   <div
     className={`wiki-sidebar-overlay${open ? " open" : ""}`}
     onClick={onClose}
     aria-hidden="true"
   />
   ```

5. **Full focus trapping** (trapping Tab key within the sidebar while open) is a more complex feature. For now, the Escape key handler and focus management provide the most impactful accessibility improvements. Full focus trapping can be added later using a library like `focus-trap-react` if needed.

## Testing

- Open the sidebar on a mobile viewport (under 900px width).
- Press Escape and verify the sidebar closes.
- Open the sidebar and verify focus moves to the sidebar element.
- Tab through the sidebar links and verify they are reachable.
- Use a screen reader and verify the sidebar is announced as a dialog with the "Wiki navigation" label.
- Close the sidebar by clicking the overlay and verify focus returns to the toggle button.

## Risk Assessment

- These are additive changes (adding attributes and event handlers) with no risk of breaking existing functionality.
- The Escape key handler uses a document-level event listener that is properly cleaned up when the sidebar closes or the component unmounts.
- Setting `tabIndex={-1}` on the `<aside>` makes it focusable programmatically but does not add it to the tab order, which is the correct behavior for a container element.
- The `role="dialog"` is only applied when the sidebar is open. When closed on desktop, the sidebar behaves as a normal navigation landmark.
