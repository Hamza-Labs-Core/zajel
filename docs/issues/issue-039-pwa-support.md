# Issue #39: No PWA Support

## Summary

The web client (`packages/web-client`) lacks Progressive Web App (PWA) features including service worker, web app manifest, and offline support. This prevents users from installing the app on their devices and using it offline.

## Current PWA Status

### Files Analyzed

**`/home/meywd/zajel/packages/web-client/src/index.html`**
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Zajel Web</title>
    <link rel="icon" type="image/svg+xml" href="/dove.svg" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

**`/home/meywd/zajel/packages/web-client/vite.config.ts`**
```typescript
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  root: 'src',
  build: {
    outDir: '../dist',
    emptyDirFirst: true,
  },
  server: {
    port: 3847,
  },
});
```

### Current Deficiencies

| PWA Feature | Status | Notes |
|-------------|--------|-------|
| Web App Manifest | Missing | No manifest.json or manifest link in HTML |
| Service Worker | Missing | No service worker registration |
| Offline Support | Missing | No caching strategy implemented |
| Install Prompt | Missing | Cannot be installed as standalone app |
| Icons (PWA) | Missing | Only dove.svg favicon, no PWA icons |
| Theme Color | Missing | No theme-color meta tag |
| Apple Touch Icon | Missing | No iOS homescreen icon |
| Description Meta | Missing | No description meta tag |

### Existing Assets (From Flutter App)

The Flutter app (`packages/app/web`) already has PWA icons that can be reused:
- `/packages/app/web/icons/Icon-192.png` (5.2 KB)
- `/packages/app/web/icons/Icon-512.png` (8.3 KB)
- `/packages/app/web/icons/Icon-maskable-192.png` (5.6 KB)
- `/packages/app/web/icons/Icon-maskable-512.png` (21 KB)
- `/packages/app/web/favicon.png` (0.9 KB)

---

## Recommended Solution: vite-plugin-pwa

### Why vite-plugin-pwa?

1. **Zero-config setup** - Works out of the box with sensible defaults
2. **Framework agnostic** - Works seamlessly with Preact
3. **Workbox integration** - Built-in service worker generation with Workbox
4. **Auto-update support** - Handles service worker updates gracefully
5. **Manifest generation** - Automatically generates and injects manifest
6. **Development support** - Service worker can be tested during development
7. **TypeScript support** - Full type definitions included

### Documentation Reference

- Official docs: https://vite-pwa-org.netlify.app
- Preact integration: https://vite-pwa-org.netlify.app/frameworks/preact

---

## Implementation Plan

### Phase 1: Install Dependencies

```bash
cd packages/web-client
npm install -D vite-plugin-pwa
```

### Phase 2: Create PWA Assets

Create a `public` directory in `packages/web-client/src/` and add the following files:

```
packages/web-client/src/
  public/
    favicon.ico
    favicon.png
    apple-touch-icon.png (180x180)
    pwa-192x192.png
    pwa-512x512.png
    pwa-maskable-192x192.png
    pwa-maskable-512x512.png
```

**Option A**: Copy icons from Flutter app:
```bash
mkdir -p packages/web-client/src/public
cp packages/app/web/icons/Icon-192.png packages/web-client/src/public/pwa-192x192.png
cp packages/app/web/icons/Icon-512.png packages/web-client/src/public/pwa-512x512.png
cp packages/app/web/icons/Icon-maskable-192.png packages/web-client/src/public/pwa-maskable-192x192.png
cp packages/app/web/icons/Icon-maskable-512.png packages/web-client/src/public/pwa-maskable-512x512.png
cp packages/app/web/favicon.png packages/web-client/src/public/
```

**Option B**: Generate icons using `@vite-pwa/assets-generator`:
```bash
npm install -D @vite-pwa/assets-generator
npx pwa-assets-generator --preset minimal public/logo.svg
```

### Phase 3: Update Vite Configuration

Update `/home/meywd/zajel/packages/web-client/vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Zajel - Secure Messaging',
        short_name: 'Zajel',
        description: 'End-to-end encrypted peer-to-peer messaging and file transfer',
        theme_color: '#0175C2',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.(?:png|jpg|jpeg|svg|gif|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'images-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 30 * 24 * 60 * 60 // 30 days
              }
            }
          }
        ]
      },
      devOptions: {
        enabled: false // Set to true to test SW in development
      }
    })
  ],
  root: 'src',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyDirFirst: true,
  },
  server: {
    port: 3847,
  },
});
```

### Phase 4: Update HTML Head

Update `/home/meywd/zajel/packages/web-client/src/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Zajel - Secure Messaging</title>
    <meta name="description" content="End-to-end encrypted peer-to-peer messaging and file transfer" />

    <!-- Favicons -->
    <link rel="icon" type="image/png" href="/favicon.png" />
    <link rel="icon" type="image/svg+xml" href="/dove.svg" />

    <!-- Apple Touch Icon -->
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />

    <!-- Theme Color -->
    <meta name="theme-color" content="#0175C2" />

    <!-- Mobile Web App Capable -->
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="Zajel" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

### Phase 5: Add Service Worker Registration (Optional - For Custom Handling)

For periodic updates and custom behavior, create `/home/meywd/zajel/packages/web-client/src/lib/pwa.ts`:

```typescript
import { useRegisterSW } from 'virtual:pwa-register/preact';

// Check for updates every hour
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export function usePWA() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker
  } = useRegisterSW({
    onRegistered(registration) {
      if (registration) {
        // Check for updates periodically
        setInterval(() => {
          registration.update();
        }, UPDATE_INTERVAL_MS);
      }
    },
    onRegisterError(error) {
      console.error('Service worker registration error:', error);
    }
  });

  const close = () => {
    setOfflineReady(false);
    setNeedRefresh(false);
  };

  return {
    offlineReady,
    needRefresh,
    updateServiceWorker,
    close
  };
}
```

### Phase 6: Add TypeScript Definitions

Create `/home/meywd/zajel/packages/web-client/src/vite-env.d.ts` (or update if exists):

```typescript
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module 'virtual:pwa-register/preact' {
  import type { StateUpdater } from 'preact/hooks';

  export interface RegisterSWOptions {
    immediate?: boolean;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
    onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
    onRegisterError?: (error: Error) => void;
  }

  export function useRegisterSW(options?: RegisterSWOptions): {
    needRefresh: [boolean, StateUpdater<boolean>];
    offlineReady: [boolean, StateUpdater<boolean>];
    updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
  };
}
```

---

## Offline Strategy Considerations

### What Should Work Offline

| Feature | Offline Behavior | Notes |
|---------|-----------------|-------|
| App Shell | Cached | HTML, CSS, JS should be available |
| Static Assets | Cached | Icons, fonts, images |
| Code Display | Cached | Show last known code |
| WebRTC Connection | Requires Internet | Core functionality needs network |
| Signaling Server | Requires Internet | Cannot establish new connections |

### Recommended Caching Strategy

```typescript
workbox: {
  // Precache app shell and static assets
  globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],

  // Network-first for API calls (if any)
  runtimeCaching: [
    {
      urlPattern: /\/api\/.*/,
      handler: 'NetworkFirst',
      options: {
        cacheName: 'api-cache',
        networkTimeoutSeconds: 10,
        expiration: {
          maxEntries: 50,
          maxAgeSeconds: 5 * 60 // 5 minutes
        }
      }
    }
  ]
}
```

### Offline UI Considerations

Since Zajel is a peer-to-peer messaging app, the offline experience should:

1. **Show cached UI** - Display the app interface immediately
2. **Indicate offline status** - Show a banner when offline
3. **Queue messages** - Allow typing messages that send when back online (if implementing)
4. **Graceful degradation** - Show clear messaging about limited functionality

---

## Testing Plan

### Manual Testing

1. **Build and serve production build**:
   ```bash
   cd packages/web-client
   npm run build
   npm run preview
   ```

2. **Check DevTools > Application tab**:
   - Verify manifest is loaded
   - Verify service worker is registered
   - Check cached assets

3. **Test installability**:
   - Look for install prompt in browser
   - Test on Android Chrome
   - Test on iOS Safari (Add to Home Screen)

4. **Test offline behavior**:
   - Go offline in DevTools
   - Reload the app
   - Verify app shell loads

### Lighthouse Audit

Run Lighthouse PWA audit to verify:
- Installable
- PWA Optimized
- Best Practices

```bash
npx lighthouse http://localhost:4173 --only-categories=pwa
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/web-client/package.json` | Modify | Add vite-plugin-pwa dependency |
| `packages/web-client/vite.config.ts` | Modify | Add VitePWA plugin configuration |
| `packages/web-client/src/index.html` | Modify | Add PWA meta tags and links |
| `packages/web-client/src/public/` | Create | Directory for PWA assets |
| `packages/web-client/src/public/*.png` | Create | PWA icons (copy from app or generate) |
| `packages/web-client/src/vite-env.d.ts` | Create/Modify | TypeScript definitions |
| `packages/web-client/src/lib/pwa.ts` | Create | (Optional) PWA registration hook |

---

## Estimated Effort

| Task | Time Estimate |
|------|---------------|
| Install dependencies | 5 minutes |
| Create/copy PWA icons | 15 minutes |
| Update vite.config.ts | 30 minutes |
| Update index.html | 15 minutes |
| Add TypeScript definitions | 10 minutes |
| Testing and debugging | 1 hour |
| **Total** | **~2.5 hours** |

---

## Additional Considerations

### Future Enhancements

1. **Push Notifications**: Add web push support for incoming message notifications
2. **Background Sync**: Queue messages when offline and sync when back online
3. **Share Target**: Allow the app to receive shared content from other apps
4. **Shortcuts**: Add app shortcuts for quick actions

### Security Considerations

- Service workers require HTTPS in production
- The signaling server URL must be HTTPS
- Cached data should not include sensitive information

### Browser Support

vite-plugin-pwa generates service workers using Workbox which supports:
- Chrome 60+
- Firefox 55+
- Safari 11.1+
- Edge 17+

---

## References

- [vite-plugin-pwa Documentation](https://vite-pwa-org.netlify.app)
- [Workbox Documentation](https://developer.chrome.com/docs/workbox/)
- [Web App Manifest Spec](https://www.w3.org/TR/appmanifest/)
- [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)

---

## Research: How Other Apps Solve This

This section documents how major messaging apps and industry-leading PWAs implement Progressive Web App features, providing insights and best practices for Zajel's PWA implementation.

---

### 1. Telegram Web

**Source**: [Telegram Web A on SourceForge](https://sourceforge.net/projects/telegram-web-a.mirror/), [Accubits Blog](https://blog.accubits.com/building-pwa-whatsapp-or-pwa-telegram-possibilities-of-pwa/)

#### Architecture Overview
Telegram Web A is a full-featured web client built from scratch as a lightweight, modern single-page application. It won first prize in the Telegram Lightweight Client Contest and serves as the codebase behind the official web client at `web.telegram.org/a`.

#### Key Technical Features
- **Custom Frontend Framework**: Uses "Teact" - a custom framework that re-implements React-style paradigms
- **MTProto via Web Workers**: Uses a custom GramJS worker implementation for the Telegram protocol
- **WebAssembly**: Leverages WASM for performance-critical tasks
- **Multi-Level Caching**: Implements sophisticated caching layers for offline usability

#### PWA Implementation
- Full PWA compliance with HTTPS, manifest, service workers, and offline mode
- The manifest at `web.telegram.org/manifest.json` defines the app for installation
- Service workers handle caching of application assets and enable offline functionality
- Corrupt service workers can be unregistered via DevTools > Application > Service Workers

#### Caching Strategy
- Uses versioned cache keys: `sw-precache-<version>-<cacheId>-<scope>`
- Implements cache invalidation for outdated assets
- Stores static assets locally for offline access

#### Known Limitations
- Service Workers do not function in Telegram Mini Apps on iOS devices ([GitHub Issue](https://github.com/Telegram-Mini-Apps/issues/issues/27))
- Media loading can fail with corrupted service workers

---

### 2. WhatsApp Web

**Source**: [Accubits Blog](https://blog.accubits.com/building-pwa-whatsapp-or-pwa-telegram-possibilities-of-pwa/), [ITDaily](https://itdaily.com/news/software/whatsapp-pwa-windows/)

#### Evolution to PWA
WhatsApp introduced WhatsApp Web in 2015, embracing PWA technology to improve user experience across platforms. Recently (2025), WhatsApp Beta on Windows (version 2.2569.0.0) transitioned to a full PWA rather than a native Windows app.

#### Performance Results
The PWA approach delivered:
- **70% increase** in website loading speed
- **90% reduction** in data usage per megabyte sent
- **30% decrease** in user support queries regarding connectivity
- **20% improvement** in message delivery time
- **50% decrease** in bounce rate

#### Technical Architecture
- Uses SQLite database on the frontend for storing conversations
- XMPP protocol (modified) over Ejabberd server for messaging
- SSL socket connections for real-time communication
- Backend uses Erlang for concurrency and FreeBSD for performance

#### Offline Approach
- Implements app shell architecture: minimum UI loaded initially, then cached
- Previously loaded content accessible even when offline
- Messages queued locally and synced when connection restored

---

### 3. Signal Desktop: Electron vs PWA

**Source**: [Clean Commit](https://cleancommit.io/blog/pwa-vs-electron-which-architecture-wins/), [Privacy Guides Discussion](https://discuss.privacyguides.net/t/how-feasible-would-a-signal-pwa-be-compared-to-signal-desktop/29298)

#### Current State
Signal Desktop currently uses Electron. Community discussions have explored whether a PWA implementation could provide better sandboxing and reduced resource usage.

#### PWA vs Electron Comparison

| Aspect | PWA | Electron |
|--------|-----|----------|
| **Size** | Typically < 1 MB | Usually > 50 MB |
| **Performance** | Better first load, cached subsequent loads | Consistent but heavier |
| **Security** | Browser sandbox, auto-updated core | Manual updates, own Chromium binary |
| **Resource Usage** | Shares browser process | Each app has own Chromium instance |
| **Native APIs** | Limited to browser-exposed APIs | Full access to OS APIs |
| **Updates** | Seamless, automatic | Manual installation required |
| **Offline** | Service worker caching | Full desktop capabilities |

#### Key Insight
> "The PWA is safer than an Electron App, as it runs in your browser sandbox without a need for an external binary and relies on a core that is kept up-to-date with your browser auto-update." - [SimiCart](https://simicart.com/blog/pwa-vs-electron/)

#### Industry Trend
Major apps like Slack, Skype, and Teams are moving from Electron to PWAs, suggesting PWA architecture is becoming the preferred approach for messaging applications.

---

### 4. Twitter Lite PWA

**Source**: [web.dev Case Study](https://web.dev/case-studies/twitter), [Paul Armstrong on Medium](https://medium.com/@paularmstrong/twitter-lite-and-high-performance-react-progressive-web-apps-at-scale-d28a00e780a3)

#### Overview
Twitter Lite launched in 2017 as a PWA to provide a "truly good" experience for every type of device, especially in emerging markets with slow networks.

#### Service Worker Strategy

**Deferred Registration**:
```javascript
// Don't register SW immediately - it blocks network requests
// Wait until initial page load completes
```
By delaying ServiceWorker registration until after API requests, CSS, and image assets loaded, Twitter allowed the page to finish rendering and be responsive.

**Incremental Offline Support**:
1. Started with a special offline page when network unavailable
2. Added basic offline API retry support
3. Cached application shell for instant subsequent boots
4. Pre-cached common assets like emojis

#### Performance Results
- **App Size**: 600KB over the wire vs 23.5MB for native Android app (97% smaller)
- **First Load**: Under 5 seconds on 3G networks
- **Subsequent Loads**: Nearly instant, even on flaky networks
- **Boot Time**: Under 3 seconds for return visitors

#### Business Impact
- **65% boost** in pages per session
- **75% more** Tweets sent
- **20% decrease** in bounce rate

#### Technical Implementation
- Uses PRPL pattern (Push, Render, Pre-cache, Lazy-load)
- Service Worker, Web Push Notifications, IndexedDB
- Web App Install Banners for installation prompts

---

### 5. Starbucks PWA

**Source**: [Mixed Media Ventures Case Study](https://www.mixedmediaventures.com/wp-content/uploads/2018/04/Starbucks.pdf), [Tigren Blog](https://www.tigren.com/blog/starbucks-pwa/)

#### Problem Addressed
Customers in areas with poor connectivity needed to browse menus and customize orders. Traditional web apps failed in low-bandwidth scenarios.

#### Solution
Starbucks developed a PWA that allows:
- Browsing menus offline
- Customizing orders offline
- Viewing nutrition information offline
- Syncing orders when connection restored

#### Technical Approach
- **GraphQL**: Used for organizing complex data and logic
- **Aggressive Caching**: High priority for offline purposes
- **Service Worker**: Searches cache for matches, falls back to network

#### Performance Results
- **App Size**: 233KB (99.84% smaller than iOS app)
- **Daily Active Users**: 2x increase compared to native app
- **Faster than native**: Web app outperformed iOS app

#### Key Takeaway
For apps that need to function in unreliable network conditions, aggressive caching with cache-first strategy provides the best user experience.

---

### 6. Slack PWA

**Source**: [Slack Engineering Blog](https://slack.engineering/service-workers-at-slack-our-quest-for-faster-boot-times-and-offline-support/)

#### Origin Story
The rewrite began as a prototype called "speedy boots" - aiming to boot Slack as quickly as possible. Using a CDN-cached HTML file, persisted Redux store, and Service Worker, they achieved sub-second boot times.

#### Service Worker Implementation

**Manifest Generation**:
- Custom webpack plugin generates a manifest of files with unique hashes
- This triggers SW updates when any relevant JS/CSS/HTML file changes
- Even if SW implementation unchanged, asset changes trigger updates

**Cache Management**:
```javascript
// In activate event:
// - Look at cached assets
// - Invalidate cache buckets more than 7 days old
// - Prevents clients booting with stale assets
```

**Three Key Events**:
1. `install` - First visit, cache initial assets
2. `fetch` - Intercept network requests, serve from cache
3. `activate` - Clean up old caches

#### Current Offline Capabilities
- Boot the application offline
- Read messages from previously visited conversations
- Set unread markers to sync when back online

#### Scale Achieved
Less than a month after public release:
- Tens of millions of requests per day
- Millions of installed Service Workers

---

### 7. Discord PWA Considerations

**Source**: [GitHub - NeverDecaf/discord-PWA](https://github.com/NeverDecaf/discord-PWA), [Discord Support](https://support.discord.com/hc/en-us/community/posts/360031002972-Discord-as-a-PWA)

#### Current State
Discord can be used as a PWA by visiting `discord.com/app` on mobile devices. A third-party Chrome extension exists to enhance the PWA experience.

#### PWA Limitations for Rich Apps
Features that CANNOT work in a PWA:
- Rich Presence (game activity)
- Game Activity detection
- Application Screen Sharing with audio (at least on Linux)

These require native capabilities that browsers don't expose.

#### Takeaway for Zajel
If your messaging app needs deep OS integration (like detecting other running apps), PWA may not be sufficient. For pure messaging with file transfer, PWA should work well.

---

### 8. Best Practices Summary

#### Manifest Configuration for Messaging Apps

**Source**: [web.dev Learn PWA](https://web.dev/learn/pwa), [MDN display_override](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/display_override)

```json
{
  "name": "Your Messaging App",
  "short_name": "Messenger",
  "description": "Secure messaging and file transfer",
  "display": "standalone",
  "display_override": ["standalone", "minimal-ui"],
  "orientation": "portrait-primary",
  "start_url": "/",
  "scope": "/",
  "theme_color": "#0175C2",
  "background_color": "#ffffff",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "icon-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "screenshots": [
    { "src": "screenshot1.png", "sizes": "1280x720", "type": "image/png" }
  ]
}
```

**Key Points**:
- `display: standalone` makes it feel like a native app
- `display_override` provides fallback chain for browser compatibility
- Include `screenshots` for enhanced Android install dialog
- `orientation: portrait-primary` is typical for messaging apps

#### Service Worker Strategies

**Source**: [Vaadin Caching Strategies](https://vaadin.com/pwa/learn/caching-strategies), [dev.to Service Workers Guide](https://dev.to/paco_ita/service-workers-and-caching-strategies-explained-step-3-m4f)

| Strategy | Use Case | Messaging App Application |
|----------|----------|---------------------------|
| **Cache-First** | Static assets | App shell, icons, fonts, CSS, JS |
| **Network-First** | Dynamic data | Message history, user data |
| **Stale-While-Revalidate** | Semi-static data | Contact list, settings |
| **Cache-Only** | Immutable assets | App logo, versioned bundles |
| **Network-Only** | Real-time data | WebRTC signaling, live status |

**Recommended Hybrid Approach for Messaging Apps**:
```javascript
workbox: {
  // Precache app shell
  globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],

  runtimeCaching: [
    // Cache-first for static assets
    {
      urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|woff2)$/,
      handler: 'CacheFirst',
      options: {
        cacheName: 'static-assets',
        expiration: { maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 }
      }
    },
    // Network-first for API calls
    {
      urlPattern: /\/api\/.*/,
      handler: 'NetworkFirst',
      options: {
        cacheName: 'api-cache',
        networkTimeoutSeconds: 10,
        expiration: { maxEntries: 50, maxAgeSeconds: 5 * 60 }
      }
    }
  ]
}
```

#### Offline Functionality Scope

**Source**: [MDN Offline Guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation), [Microsoft Edge Docs](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/background-syncs)

For a P2P messaging app like Zajel:

| Feature | Offline Capability | Notes |
|---------|-------------------|-------|
| App Shell | Full offline | Cache HTML, CSS, JS |
| Display Connection Code | Cached | Show last known code |
| View Previous Messages | If cached | Use IndexedDB for message storage |
| Send New Messages | Queue for sync | Use Background Sync API |
| Establish New Connection | Requires network | WebRTC needs signaling |
| File Transfer | Requires network | P2P needs active connection |

**Background Sync for Message Queuing**:
```javascript
// Register sync when user sends message while offline
navigator.serviceWorker.ready.then(registration => {
  registration.sync.register('send-messages');
});

// In service worker
self.addEventListener('sync', event => {
  if (event.tag === 'send-messages') {
    event.waitUntil(sendQueuedMessages());
  }
});
```

#### Push Notification Implementation

**Source**: [MagicBell PWA Push Guide](https://www.magicbell.com/blog/using-push-notifications-in-pwas), [Learning Tree Blog](https://www.learningtree.com/blog/utilizing-push-notifications-progressive-web-app-pwa/)

**Requirements**:
1. HTTPS (required for service workers)
2. Service Worker registered
3. Web App Manifest
4. VAPID keys for push subscription
5. Push service integration (FCM, custom server)

**iOS Considerations** (iOS 16.4+):
- Push only works from installed PWA (not browser tab)
- Permission must be requested from user gesture handler
- Limited compared to Android support

**Best Practices**:
- Request permission in context (after user action, not on page load)
- Allow users to control notification preferences
- Limit to < 5 notifications per week
- Avoid early morning/late night notifications

#### Install Prompt UX

**Source**: [web.dev Installation Prompt](https://web.dev/learn/pwa/installation-prompt), [MDN Trigger Install Prompt](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt)

**Implementation Pattern**:
```javascript
let deferredPrompt;

// Capture the event
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  showInstallButton(); // Show your custom UI
});

// Trigger when user clicks install button
installButton.addEventListener('click', async () => {
  if (!deferredPrompt) return;

  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  console.log(`User ${outcome} the install`);
  deferredPrompt = null;
});

// Track successful installations
window.addEventListener('appinstalled', () => {
  console.log('PWA was installed');
  hideInstallButton();
});
```

**UX Best Practices**:
1. Don't show install prompt immediately
2. Show after meaningful user engagement
3. Provide context about benefits of installing
4. Place install hints strategically (after sign-up, in menu)
5. Handle iOS separately (show "Add to Home Screen" instructions)

---

### 9. Key Recommendations for Zajel

Based on this research, here are specific recommendations for Zajel's PWA implementation:

#### Immediate Implementation (Phase 1)
1. **Use vite-plugin-pwa** - Already recommended in this document
2. **Manifest with standalone display** - Messaging apps should feel native
3. **Cache-first for app shell** - Ensure instant boot times
4. **Custom offline page** - Show "You're offline" with cached UI

#### Medium-Term Enhancements (Phase 2)
1. **Deferred SW registration** - Follow Twitter's pattern to not block initial load
2. **IndexedDB for message cache** - Store recently viewed messages
3. **Background Sync** - Queue messages sent while offline
4. **Install prompt UI** - Custom install button with context

#### Long-Term Features (Phase 3)
1. **Push notifications** - For incoming message alerts
2. **Periodic background sync** - Check for missed messages
3. **Share target** - Allow sharing files to Zajel from other apps

#### What NOT to Expect from PWA
- Cannot detect running games/apps (like Discord)
- WebRTC signaling requires network (core functionality)
- File transfer requires active P2P connection
- iOS support more limited than Android

---

### 10. Research Sources

- [Telegram Web A - SourceForge](https://sourceforge.net/projects/telegram-web-a.mirror/)
- [Slack Engineering - Service Workers](https://slack.engineering/service-workers-at-slack-our-quest-for-faster-boot-times-and-offline-support/)
- [Twitter Lite Case Study - web.dev](https://web.dev/case-studies/twitter)
- [Starbucks PWA Case Study](https://www.mixedmediaventures.com/wp-content/uploads/2018/04/Starbucks.pdf)
- [web.dev Learn PWA](https://web.dev/learn/pwa)
- [MDN Progressive Web Apps](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps)
- [PWA vs Electron - Clean Commit](https://cleancommit.io/blog/pwa-vs-electron-which-architecture-wins/)
- [Vaadin Caching Strategies](https://vaadin.com/pwa/learn/caching-strategies)
- [MDN Offline and Background Operation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)
- [Microsoft Edge - Background Syncs](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/background-syncs)
- [web.dev PWA Checklist](https://web.dev/articles/pwa-checklist)
- [MagicBell Push Notifications Guide](https://www.magicbell.com/blog/using-push-notifications-in-pwas)
