# [HIGH] XSS via Mermaid SVG innerHTML injection

**Area**: Website
**File**: packages/website/app/components/wiki/MermaidDiagram.tsx:38
**Type**: Security

**Description**: The `MermaidDiagram` component sets `containerRef.current.innerHTML = svg` with the SVG output from `mermaid.render()`. While Mermaid itself performs some sanitization, the use of `innerHTML` is a dangerous pattern. If a malicious or crafted Mermaid diagram definition can trigger Mermaid to produce SVG containing event handlers (e.g., `onload`, `onclick`) or embedded `<script>` tags, this becomes a stored XSS vector. The Mermaid library has had multiple CVEs related to XSS through crafted diagram definitions (e.g., CVE-2023-45809, CVE-2023-46316). The wiki content is loaded from markdown files in the repository, and if the wiki accepts contributions or if an attacker compromises a markdown file, they can inject arbitrary JavaScript.

**Impact**: An attacker who can modify wiki markdown content (e.g., via a malicious PR or compromised contributor) can execute arbitrary JavaScript in visitors' browsers. This enables session hijacking, credential theft, phishing overlays, and defacement.

**Fix**: Replace `innerHTML` with a safer approach:
1. Use DOMPurify to sanitize the SVG output before injection: `containerRef.current.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } })`.
2. Alternatively, configure Mermaid's `securityLevel` to `'strict'` during initialization to enforce its built-in sanitization: `mermaid.initialize({ securityLevel: 'strict', ... })`.
3. Both approaches should be combined for defense-in-depth.
