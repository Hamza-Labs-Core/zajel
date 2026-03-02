# [LOW] Guide page uses anchor tags for in-page navigation instead of proper scroll handling

**Area**: Website
**File**: packages/website/app/routes/guide.tsx:29-44
**Type**: Bug

**Description**: The guide page table of contents uses standard `<a href="#section">` anchor tags for in-page navigation. In a React Router SPA, hash-based navigation can be unreliable because:
1. React Router's `ScrollRestoration` component (used in `root.tsx` line 27) may interfere with hash scrolling behavior.
2. The browser's native hash scrolling happens before React has finished rendering, which can cause the scroll target to be missed if the content is rendered asynchronously.
3. There is no smooth scrolling behavior configured -- the browser will jump abruptly to the section.
4. The same issue exists on the home page (`Nav.tsx` lines 10-11) where `/#features` and `/#download` use hash links that rely on cross-page hash navigation, which React Router may not handle consistently.

**Impact**: Users clicking table of contents links may not be scrolled to the correct section, especially on initial page load or when navigating from another route. The navigation experience is jarring without smooth scrolling.

**Fix**:
1. Add `scroll-behavior: smooth` to the CSS for the html element.
2. For cross-page hash links (from Nav), consider using React Router's `useNavigate` with a programmatic scroll after navigation.
3. For in-page anchors in the guide, the current approach works but add smooth scrolling:
```css
html {
  scroll-behavior: smooth;
}
```
