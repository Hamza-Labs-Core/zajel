# [LOW] Missing ARIA attributes and keyboard navigation on Nav component

**Area**: Website
**File**: packages/website/app/components/Nav.tsx:5-22
**Type**: Best Practice

**Description**: The `Nav` component uses a `<nav>` element (which is good for semantics) but lacks several accessibility best practices:
1. No `aria-label` on the `<nav>` element to distinguish it from other potential navigation landmarks (e.g., the sidebar navigation in the wiki).
2. The navigation links do not indicate which page is currently active (no `aria-current="page"` attribute).
3. On mobile (768px breakpoint), the nav links wrap but there is no hamburger menu or collapsible behavior -- all links are always visible and can overflow, which is a usability issue on small screens.
4. The mixed use of `<a>` tags and `<Link>` components means some navigation uses hash-based scrolling (`/#features`, `/#download`) while others use client-side routing, which can be confusing for screen readers.

**Impact**: Screen reader users cannot identify which page they are on from the navigation. Multiple `<nav>` landmarks without labels make navigation confusing. Mobile users may experience layout overflow issues.

**Fix**:
1. Add `aria-label="Main navigation"` to the `<nav>` element.
2. Add `aria-current="page"` to the active link based on the current route.
3. Consider implementing a responsive hamburger menu for mobile viewports.
4. Use consistent navigation patterns (all `Link` or handle hash scrolling programmatically).
