# Plan: Missing ARIA attributes and keyboard navigation on Nav component

**Issue**: issue-website-11.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/app/components/Nav.tsx`

## Analysis

The `Nav` component at `packages/website/app/components/Nav.tsx` (lines 3-23) uses a `<nav>` element, which is good for semantics. However, it lacks several accessibility attributes:

```tsx
export function Nav() {
  return (
    <nav className="nav">
      <div className="nav-logo">
        <Link to="/">Zajel</Link>
      </div>
      <div className="nav-links">
        <a href="/#features">Features</a>
        <a href="/#download">Download</a>
        <Link to="/guide">User Guide</Link>
        <Link to="/wiki/en">Wiki</Link>
        <a href="https://github.com/..." target="_blank" rel="noopener noreferrer">GitHub</a>
        <a href="https://hamzalabs.dev" target="_blank" rel="noopener noreferrer">HamzaLabs</a>
      </div>
    </nav>
  );
}
```

Issues:
1. No `aria-label` on `<nav>` to distinguish it from the wiki sidebar navigation
2. No `aria-current="page"` on the active link
3. Mixed `<a>` tags (for hash links) and `<Link>` components (for routes)
4. On mobile (768px), nav links wrap without a hamburger menu, potentially overflowing

## Fix Steps

1. **Add `aria-label="Main navigation"`** to the `<nav>` element:
   ```tsx
   <nav className="nav" aria-label="Main navigation">
   ```

2. **Add `aria-current="page"` to the active link** by importing `useLocation` from React Router and comparing the current path:
   ```typescript
   import { Link, useLocation } from "react-router";

   export function Nav() {
     const location = useLocation();

     const isActive = (path: string) => {
       if (path === "/") return location.pathname === "/";
       return location.pathname.startsWith(path);
     };
   ```

3. **Apply `aria-current` to route-based links**:
   ```tsx
   <Link to="/guide" aria-current={isActive("/guide") ? "page" : undefined}>User Guide</Link>
   <Link to="/wiki/en" aria-current={isActive("/wiki") ? "page" : undefined}>Wiki</Link>
   ```

4. **Note on hash links**: The `<a href="/#features">` and `<a href="/#download">` links are hash links to sections on the home page. These do not need `aria-current` since they link to sections within a page, not to separate pages. They should remain as `<a>` tags since they use hash-based scrolling.

5. **Add `aria-label` to external links** that open in new tabs to indicate they open externally (optional enhancement):
   ```tsx
   <a href="https://github.com/..." target="_blank" rel="noopener noreferrer" aria-label="GitHub (opens in new tab)">
     GitHub
   </a>
   ```

## Testing

- Use a screen reader (VoiceOver on macOS, NVDA on Windows) to navigate the site and verify:
  - The main navigation is announced as "Main navigation"
  - The current page link is announced as "current page"
  - External links are distinguishable from internal links
- Tab through the navigation with keyboard and verify all links are reachable.
- Navigate to different pages and verify `aria-current` updates correctly.

## Risk Assessment

- This is a non-breaking change that only adds HTML attributes. No visual changes.
- The `useLocation()` hook is already available via React Router, which is a project dependency.
- The `isActive` function uses `startsWith` for path matching, which works for the current route structure. For example, `/wiki/en/Home` would match `isActive("/wiki")`.
- The mobile hamburger menu is a separate concern that would require significant CSS and component changes. It is documented as a future enhancement but not included in this fix to keep the scope manageable.
