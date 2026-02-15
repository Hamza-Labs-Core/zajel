# Plan: Vite dev server filesystem access expanded to parent directory

**Issue**: issue-website-17.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/vite.config.ts`

## Analysis

In `packages/website/vite.config.ts`, lines 12-16, the Vite dev server filesystem access is configured:

```typescript
server: {
  fs: {
    allow: [".", "../wiki"],
  },
},
```

The `"../wiki"` path is a relative path that resolves differently depending on the working directory when Vite is started. The file already imports `path` (line 3) and uses `path.resolve` for the alias (line 9), so the same approach should be used for the fs allow configuration.

This is a development-only concern (the `server.fs.allow` setting only affects the Vite dev server, not production builds), but using an absolute resolved path is more robust and prevents any directory traversal ambiguity.

## Fix Steps

1. **Use `path.resolve` for the wiki directory path** in `packages/website/vite.config.ts`. Replace line 14:

   ```typescript
   allow: [".", "../wiki"],
   ```
   with:
   ```typescript
   allow: [".", path.resolve(__dirname, "../wiki")],
   ```

2. **Full updated config**:
   ```typescript
   import { reactRouter } from "@react-router/dev/vite";
   import { defineConfig } from "vite";
   import path from "path";

   export default defineConfig({
     plugins: [reactRouter()],
     resolve: {
       alias: {
         "~": path.resolve(__dirname, "./app"),
       },
     },
     server: {
       fs: {
         allow: [".", path.resolve(__dirname, "../wiki")],
       },
     },
   });
   ```

3. **Verify that the resolved path** points to `packages/wiki/`, which is the intended sibling directory containing the wiki markdown files. The `import.meta.glob` patterns in `wiki.tsx` (lines 12, 16, 19) also use `"../../../wiki/"` relative paths, confirming the wiki content is at `packages/wiki/`.

## Testing

- Run `npm run dev --workspace=zajel-website` and verify the wiki pages load correctly (markdown content renders from the `packages/wiki/` directory).
- Verify that the dev server does not serve files outside the allowed directories by attempting to access a file from an unrelated parent directory (should return 403).
- Verify the production build (`npm run build --workspace=zajel-website`) is unaffected by this change (the `server.fs` config only applies to dev server).

## Risk Assessment

- This is a minimal, development-only change. The production build is completely unaffected.
- Using `path.resolve(__dirname, "../wiki")` produces an absolute path that unambiguously resolves to the intended `packages/wiki/` directory, eliminating any risk of directory traversal.
- The existing relative path `"../wiki"` likely already resolved correctly in practice (Vite resolves relative to the project root), but the explicit absolute path is more robust and self-documenting.
