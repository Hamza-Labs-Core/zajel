# Plan: Client-side-only data fetching for release info causes layout shift and no SSR

**Issue**: issue-website-15.md
**Severity**: LOW
**Area**: Website
**Files to modify**: `packages/website/app/routes/home.tsx`

## Analysis

In `packages/website/app/routes/home.tsx`, lines 79-95, the GitHub release data is fetched entirely on the client side using `useEffect` + `fetch`:

```typescript
useEffect(() => {
  setDetectedPlatform(detectPlatform());

  fetch(GITHUB_API)
    .then((res) => res.json())
    .then((data: Release) => {
      setRelease(data);
      if (data.assets) {
        const urls: Record<string, string | null> = {};
        Object.keys(platforms).forEach((p) => {
          urls[p] = findAssetUrl(data.assets, p);
        });
        setDownloadUrls(urls);
      }
    })
    .catch(console.error);
}, []);
```

Problems with this approach:
1. **Layout shift**: Download cards initially show "Coming Soon", then switch to actual download links when data arrives. The hero button gains a version tag after load.
2. **No SSR**: Server-rendered HTML has no release data, so search engines and social crawlers see empty download sections.
3. **Rate limiting**: Every visitor makes an unauthenticated GitHub API request (60 req/hr per IP limit).
4. **No caching**: Each page visit triggers a new API call.

## Fix Steps

1. **Convert to a React Router `loader` function** for server-side data fetching. Add a `loader` export to `packages/website/app/routes/home.tsx`:

   ```typescript
   import type { MetaFunction, LoaderFunctionArgs } from "react-router";
   import { useLoaderData } from "react-router";

   export async function loader({ request }: LoaderFunctionArgs) {
     try {
       const res = await fetch(GITHUB_API, {
         headers: {
           'Accept': 'application/vnd.github.v3+json',
           'User-Agent': 'Zajel-Website',
         },
       });
       if (!res.ok) {
         return { release: null };
       }
       const data = await res.json();
       if (!data.tag_name || !Array.isArray(data.assets)) {
         return { release: null };
       }
       return { release: data as Release };
     } catch {
       return { release: null };
     }
   }
   ```

2. **Use `useLoaderData` in the component** to access server-fetched data:
   ```typescript
   export default function Home() {
     const { release } = useLoaderData<typeof loader>();
     const [detectedPlatform, setDetectedPlatform] = useState<string | null>(null);

     // Pre-compute download URLs from loader data
     const downloadUrls = useMemo(() => {
       const urls: Record<string, string | null> = {};
       if (release?.assets) {
         Object.keys(platforms).forEach((p) => {
           urls[p] = findAssetUrl(release.assets, p);
         });
       }
       return urls;
     }, [release]);

     useEffect(() => {
       setDetectedPlatform(detectPlatform());
     }, []);
   ```

3. **Remove the client-side `useEffect` for fetching** (lines 79-95). Keep only the `detectPlatform()` effect:
   ```typescript
   useEffect(() => {
     setDetectedPlatform(detectPlatform());
   }, []);
   ```

4. **Remove the `downloadUrls` state** and the `release` state since they are now derived from the loader.

5. **Add `useMemo` import** from React.

6. **Consider adding caching headers** to the loader response if using a server-side deployment:
   ```typescript
   export async function loader() {
     // ... fetch logic ...
     return new Response(JSON.stringify({ release: data }), {
       headers: {
         'Content-Type': 'application/json',
         'Cache-Control': 'public, max-age=300', // 5-minute cache
       },
     });
   }
   ```

   However, note that when deploying to Cloudflare Pages as a static site (using `wrangler pages deploy ./build/client`), server-side loaders may not execute. In that case, the `clientLoader` pattern should be used instead, or the site should be deployed with the server build.

7. **Alternative for static deployment**: If the site is deployed as static files to Cloudflare Pages, use `clientLoader` instead:
   ```typescript
   export async function clientLoader() {
     // Same fetch logic but runs on client
     // At least separates concerns and uses React Router's data loading patterns
   }
   ```
   This still runs client-side but integrates with React Router's loading states, providing a better UX with loading indicators.

## Testing

- Build the website and verify the download section renders with data in the initial HTML (view source).
- Verify that the download cards show correct download links on first render without a flash of "Coming Soon".
- Test with the GitHub API rate-limited (return a cached response or mock) and verify graceful degradation.
- Verify the `detectPlatform()` logic still works (platform detection must be client-side since it reads `navigator`).
- Test on Cloudflare Pages deployment to ensure the loader executes correctly.

## Risk Assessment

- **Deployment model dependency**: This fix depends on how the site is deployed. If deployed as a static site to Cloudflare Pages (`wrangler pages deploy ./build/client`), server-side loaders will not execute. The deployment would need to include the server build, or the `clientLoader` alternative should be used.
- **API token**: For server-side fetching, a GitHub API token can be added to increase the rate limit from 60 to 5000 requests/hour. This token should be stored as an environment variable, not in the codebase.
- The `detectPlatform()` function must remain in a client-side effect since it reads `navigator.userAgent` and `navigator.platform`, which are not available on the server.
- Adding `useMemo` for `downloadUrls` is a minor optimization that avoids recomputing URLs on every render.
