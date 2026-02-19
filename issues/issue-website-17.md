# [LOW] Vite dev server filesystem access expanded to parent directory

**Area**: Website
**File**: packages/website/vite.config.ts:13-15
**Type**: Security

**Description**: The Vite configuration explicitly allows the dev server filesystem access to `"../wiki"` in addition to the current directory (line 14). While this is necessary for the wiki to load markdown files from the sibling `packages/wiki` directory, it expands the dev server's file-serving scope beyond the website package. The `server.fs.allow` setting controls which files the Vite dev server is allowed to serve. By allowing `"../wiki"`, any file within the `packages/wiki` directory (and potentially parent directories depending on resolution) becomes accessible through the dev server's file-serving mechanism.

**Impact**: In development mode only, the expanded filesystem access could allow serving files from the wiki directory that were not intended to be publicly accessible (e.g., draft documents, notes, or any files placed in the wiki directory). This does not affect production builds. The risk is limited to development environments.

**Fix**: This is an acceptable configuration for development but should be documented. Ensure that:
1. The `../wiki` path resolves exactly to the intended directory using `path.resolve`:
```typescript
server: {
  fs: {
    allow: [".", path.resolve(__dirname, "../wiki")],
  },
},
```
2. The production build (Cloudflare Pages deployment) does not serve raw wiki markdown files -- verify that only the bundled assets are deployed.
3. Consider adding a `strict: true` option if Vite supports it to prevent directory traversal.
