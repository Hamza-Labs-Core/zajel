# [HIGH] Slug parameter injection in wiki "Page Not Found" and error messages

**Area**: Website
**File**: packages/website/app/routes/wiki.tsx:86,103
**Type**: Security

**Description**: When a wiki page is not found, the `slug` URL parameter is directly interpolated into markdown content that is then rendered: `setContent(\`# Page Not Found\n\nThe page **${slug}** does not exist.\`)` and similarly for the error case: `setContent(\`# Error\n\nFailed to load **${slug}**.\`)`. The `slug` comes from `useParams()` which extracts it from the URL path. This markdown string is then passed to `<MarkdownRenderer>` which renders it using `react-markdown`. While `react-markdown` does not execute raw HTML by default (it strips HTML tags), a crafted slug could still inject markdown formatting to mislead users (e.g., phishing links via markdown link syntax). If `rehype-raw` is ever added in the future, this becomes a direct XSS.

**Impact**: Currently limited to markdown injection that could create misleading content or phishing links within the page. If `rehype-raw` or similar HTML-passthrough plugins are ever added, this becomes a full XSS vulnerability. The slug value is attacker-controlled via the URL.

**Fix**: Sanitize or escape the `slug` parameter before interpolating it into the markdown string. At minimum, escape markdown special characters (`*`, `[`, `]`, `(`, `)`, etc.). Better yet, render the "not found" message using JSX components directly instead of constructing a markdown string from user input:
```tsx
if (!loader) {
  return <div><h1>Page Not Found</h1><p>The page <strong>{slug}</strong> does not exist.</p></div>;
}
```
