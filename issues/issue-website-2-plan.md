# Plan: Slug parameter injection in wiki "Page Not Found" and error messages

**Issue**: issue-website-2.md
**Severity**: HIGH
**Area**: Website
**Files to modify**: `packages/website/app/routes/wiki.tsx`

## Analysis

In `packages/website/app/routes/wiki.tsx`, the `slug` parameter from `useParams()` is directly interpolated into markdown strings at two locations:

- **Line 86**: `setContent(\`# Page Not Found\n\nThe page **${slug}** does not exist.\`)`
- **Line 103**: `setContent(\`# Error\n\nFailed to load **${slug}**.\`)`

The `slug` value comes from the URL path (`/wiki/:lang?/:slug?`) and is entirely attacker-controlled. While `react-markdown` does not execute raw HTML by default (it strips HTML tags), a crafted slug can inject markdown formatting. For example, a slug like `foo**injected [click here](https://evil.com)` would produce:

```markdown
The page **foo**injected [click here](https://evil.com)** does not exist.
```

This renders a clickable phishing link inside what appears to be a legitimate wiki error page. If `rehype-raw` is ever added as a plugin, this becomes a full XSS vulnerability.

## Fix Steps

1. **Replace markdown-based error messages with direct JSX rendering** in `packages/website/app/routes/wiki.tsx`. This completely eliminates the injection vector since React's JSX escapes all interpolated values automatically.

2. **For the "not found" case** (lines 84-89), instead of setting content as a markdown string, set a separate state flag. Replace:
   ```typescript
   if (!loader) {
     if (!cancelled) {
       setContent(`# Page Not Found\n\nThe page **${slug}** does not exist.`);
       setLoading(false);
     }
     return;
   }
   ```
   with:
   ```typescript
   if (!loader) {
     if (!cancelled) {
       setContent(null);
       setLoading(false);
     }
     return;
   }
   ```

3. **For the error case** (lines 101-105), similarly avoid interpolating slug into markdown. Replace:
   ```typescript
   } catch {
     if (!cancelled) {
       setContent(`# Error\n\nFailed to load **${slug}**.`);
       setLoading(false);
     }
   }
   ```
   with:
   ```typescript
   } catch {
     if (!cancelled) {
       setContent(null);
       setIsFallback(false);
       setLoading(false);
     }
   }
   ```

4. **Add a new state variable** to track the error/not-found condition:
   ```typescript
   const [pageError, setPageError] = useState<"not-found" | "load-error" | null>(null);
   ```
   Set `setPageError("not-found")` and `setPageError("load-error")` in the respective cases above. Reset it to `null` at the start of `loadPage()`.

5. **Render error states with JSX** in the return block (around lines 144-148), before the content rendering:
   ```tsx
   {pageError === "not-found" && (
     <div className="wiki-markdown">
       <h1>Page Not Found</h1>
       <p>The page <strong>{slug}</strong> does not exist.</p>
     </div>
   )}
   {pageError === "load-error" && (
     <div className="wiki-markdown">
       <h1>Error</h1>
       <p>Failed to load <strong>{slug}</strong>.</p>
     </div>
   )}
   ```

## Testing

- Navigate to `/wiki/en/nonexistent-page` and verify the "Page Not Found" message displays correctly with the slug shown in bold.
- Navigate to `/wiki/en/foo**[click](https://evil.com)` and verify the slug is displayed as literal text, not as a markdown link.
- Verify that the error message for a failed page load also displays correctly with the slug escaped.
- Test that normal wiki page navigation still works (loading existing pages, fallback from Arabic to English).

## Risk Assessment

- This change modifies the rendering path for error states only. Normal page content continues to go through `MarkdownRenderer`.
- The JSX approach is inherently safe because React escapes all string interpolations in JSX.
- Minor visual difference: the error pages will no longer be styled by `react-markdown`'s rendering but will use the `.wiki-markdown` CSS class directly, so the appearance should remain consistent.
