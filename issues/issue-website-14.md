# [LOW] WikiSidebar overlay does not trap focus or handle Escape key

**Area**: Website
**File**: packages/website/app/components/wiki/WikiSidebar.tsx:50-85
**Type**: Best Practice

**Description**: The mobile sidebar implementation has an overlay (`wiki-sidebar-overlay`) that closes the sidebar when clicked, but it lacks proper accessibility patterns for modal-like behavior:
1. **No focus trap**: When the sidebar opens on mobile, keyboard focus is not trapped within it. Users can tab to elements behind the overlay, which is confusing.
2. **No Escape key handler**: Pressing Escape does not close the sidebar, which is the expected behavior for overlay/modal components.
3. **No `role` or `aria-modal` attributes**: The sidebar when open acts as a modal on mobile but is not announced as such to assistive technology.
4. **No focus management**: When the sidebar opens, focus is not moved to the sidebar. When it closes, focus is not returned to the toggle button.

**Impact**: Keyboard-only users and screen reader users cannot effectively interact with the mobile sidebar. They may get trapped behind the overlay or be unable to close it without clicking, which is not possible for keyboard-only users via the overlay (they must find the toggle button).

**Fix**:
1. Add an `onKeyDown` handler to close on Escape: `onKeyDown={(e) => e.key === 'Escape' && onClose()}`.
2. Add `role="dialog"` and `aria-modal="true"` to the sidebar when open.
3. Implement focus trapping using a library like `focus-trap-react` or a custom implementation.
4. Move focus to the sidebar when it opens and return focus to the toggle button when it closes.
5. Add `aria-label="Wiki navigation"` to the `<aside>` element.
