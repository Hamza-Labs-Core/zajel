# Issue #39: PWA Support - Research Findings

## Executive Summary

This document provides a comprehensive analysis of Zajel's current PWA implementation status, identifies missing features, compares with major messaging apps (WhatsApp Web, Telegram Web, Discord), and provides actionable recommendations for enhanced offline messaging support.

---

## 1. Current PWA Implementation Status

### 1.1 What Is Already Implemented

Zajel's web client already has a **substantial PWA foundation** in place:

| Component | Status | Location |
|-----------|--------|----------|
| vite-plugin-pwa | Installed | `packages/web-client/package.json` (v1.2.0) |
| Web App Manifest | Configured | `packages/web-client/vite.config.ts` (inline) |
| Service Worker | Auto-generated | via vite-plugin-pwa with Workbox |
| PWA Icons | Present | `packages/web-client/src/public/` |
| Apple Touch Icon | Present | `pwa-192x192.png`, `apple-touch-icon.png` |
| Maskable Icons | Present | `pwa-maskable-192x192.png`, `pwa-maskable-512x512.png` |
| Theme Color | Configured | `#4a90d9` |
| TypeScript Definitions | Present | `packages/web-client/src/vite-env.d.ts` |
| PWA Hook | Created (unused) | `packages/web-client/src/lib/pwa.ts` |

### 1.2 Vite Configuration Analysis

**File**: `/home/meywd/zajel/packages/web-client/vite.config.ts`

```typescript
VitePWA({
  registerType: 'autoUpdate',
  includeAssets: ['favicon.png', 'apple-touch-icon.png', 'dove.svg'],
  manifest: {
    name: 'Zajel - Secure Messaging',
    short_name: 'Zajel',
    description: 'End-to-end encrypted peer-to-peer messaging and file transfer',
    theme_color: '#4a90d9',
    background_color: '#1a1a2e',
    display: 'standalone',
    orientation: 'portrait-primary',
    start_url: '/',
    scope: '/',
    icons: [/* properly configured icons */]
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
    runtimeCaching: [
      {
        urlPattern: /^https:\/\/.*\.(?:png|jpg|jpeg|svg|gif|webp)$/,
        handler: 'CacheFirst',
        options: {
          cacheName: 'images-cache',
          expiration: { maxEntries: 50, maxAgeSeconds: 30 * 24 * 60 * 60 }
        }
      }
    ]
  },
  devOptions: { enabled: false }
})
```

**Assessment**: Good foundation with proper manifest and basic caching. Missing advanced offline strategies for a messaging app.

### 1.3 HTML Meta Tags Analysis

**File**: `/home/meywd/zajel/packages/web-client/src/index.html`

Present meta tags:
- `theme-color` meta tag
- `mobile-web-app-capable` and `apple-mobile-web-app-capable`
- `apple-mobile-web-app-status-bar-style`
- `apple-mobile-web-app-title`
- Apple touch icon link
- Content Security Policy (well-configured)

**Assessment**: All essential PWA meta tags are properly configured.

### 1.4 PWA Hook Analysis

**File**: `/home/meywd/zajel/packages/web-client/src/lib/pwa.ts`

```typescript
import { useRegisterSW } from 'virtual:pwa-register/preact';

export function usePWA() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker
  } = useRegisterSW({
    onRegistered(registration) {
      if (registration) {
        setInterval(() => {
          registration.update();
        }, 60 * 60 * 1000); // Check every hour
      }
    },
    onRegisterError(error) {
      console.error('Service worker registration error:', error);
    }
  });
  // ...
}
```

**Issue**: This hook is **NOT used anywhere in the application**. The `App.tsx` and `main.tsx` do not import or utilize `usePWA()`.

---

## 2. Missing PWA Features

### 2.1 Critical Missing Features

| Feature | Impact | Priority |
|---------|--------|----------|
| PWA Hook Integration | Update prompts not shown to users | HIGH |
| Offline Message Queue | Cannot compose messages offline | HIGH |
| IndexedDB Message Storage | No message persistence | HIGH |
| Background Sync | Messages not sent when back online | HIGH |
| Offline Status Indicator | Users unaware of connection state | MEDIUM |

### 2.2 Nice-to-Have Features

| Feature | Benefit | Priority |
|---------|---------|----------|
| Push Notifications | Incoming message alerts | MEDIUM |
| Share Target API | Receive files from other apps | LOW |
| App Shortcuts | Quick actions from home screen | LOW |
| Periodic Background Sync | Check for missed messages | LOW |
| Install Prompt UI | Custom install experience | MEDIUM |

### 2.3 App Not Using PWA Hook

The `usePWA()` hook exists but is not integrated into the application. Users cannot:
- See when the app is ready for offline use
- Be prompted to refresh when updates are available
- Know if the service worker failed to register

---

## 3. Comparison with Major Messaging Apps

### 3.1 WhatsApp Web

**Source**: [Accubits - Building PWA WhatsApp or Telegram](https://blog.accubits.com/building-pwa-whatsapp-or-pwa-telegram-possibilities-of-pwa/)

| Feature | WhatsApp Web | Zajel Status |
|---------|--------------|--------------|
| PWA Install | Partial (Windows Beta is PWA) | Configured |
| Offline App Shell | Yes | Yes |
| Offline Message Viewing | Yes (cached conversations) | No |
| Offline Message Compose | Queue for sync | No |
| Push Notifications | Yes | No |
| Background Sync | Yes | No |
| Local Storage | SQLite on frontend | None |

**Key Insights**:
- WhatsApp transitioned to full PWA in Windows Beta (v2.2569.0.0) in 2025
- Reports 70% faster loading, 90% less data usage
- Uses SQLite database on frontend for conversation storage
- Messages queued locally and synced when connection restored

### 3.2 Telegram Web

**Source**: [Telegram Web A on SourceForge](https://sourceforge.net/projects/telegram-web-a.mirror/)

| Feature | Telegram Web | Zajel Status |
|---------|--------------|--------------|
| Custom Framework | Teact (React-like) | Preact |
| Protocol Worker | MTProto via Web Workers | WebRTC direct |
| WebAssembly | Yes (performance tasks) | No |
| Multi-level Caching | Yes | Basic |
| Offline Mode | Full PWA compliance | Partial |
| Service Worker | Custom sw-precache | Workbox auto |

**Key Insights**:
- Won first prize in Telegram Lightweight Client Contest
- Uses custom versioned cache keys for invalidation
- 175% boost in user engagement, 50% increase in retention
- Multi-level caching layers for offline/near-offline usability

### 3.3 Discord

**Source**: [Discord PWA Support](https://support.discord.com/hc/en-us/community/posts/360031002972-Discord-as-a-PWA), [GitHub - discord-PWA](https://github.com/NeverDecaf/discord-PWA)

| Feature | Discord | Zajel Status |
|---------|---------|--------------|
| Official PWA | Available at discord.com/app | - |
| Offline Mode | Limited | Limited |
| Push Notifications | Via Electron only | No |
| Push-to-Talk | Not in PWA | N/A |
| Rich Presence | Not possible in PWA | N/A |

**Key Insights**:
- Discord uses Electron for desktop, PWA available but limited
- PWA cannot access Rich Presence, game activity, system audio sharing
- Unread counts only track after PWA starts
- Third-party wrapper exists for enhanced features

### 3.4 Comparison Summary

| Capability | WhatsApp | Telegram | Discord | Zajel |
|------------|----------|----------|---------|-------|
| Installable PWA | Partial | Yes | Yes | Yes |
| Offline App Shell | Yes | Yes | Yes | Yes |
| Offline Message Queue | Yes | Yes | Limited | **No** |
| Message Persistence | SQLite | IndexedDB | Limited | **No** |
| Background Sync | Yes | Yes | No | **No** |
| Push Notifications | Yes | Yes | Electron only | **No** |
| Update Prompts | Yes | Yes | Yes | **No** |

---

## 4. Offline Messaging Strategy Recommendations

### 4.1 Architecture for Offline-First Messaging

Based on research from [LogRocket](https://blog.logrocket.com/offline-first-frontend-apps-2025-indexeddb-sqlite/) and [Microsoft Edge Docs](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/background-syncs):

```
UI Action (Send Message)
    |
    v
+-------------------+
| Write to IndexedDB |  <-- Optimistic write (local-first)
| (messages store)  |
+-------------------+
    |
    +--> If Online: Send via WebRTC
    |         |
    |         +--> Success: Mark as 'sent' in IndexedDB
    |         |
    |         +--> Fail: Queue for retry
    |
    +--> If Offline: Add to sync queue
              |
              v
    +-------------------+
    | IndexedDB         |
    | (outbox store)    |
    +-------------------+
              |
              v (when online)
    +-------------------+
    | Background Sync   |
    | Event Triggered   |
    +-------------------+
              |
              v
    Send queued messages via WebRTC
```

### 4.2 IndexedDB Schema Proposal

```typescript
// Database: zajel-db
// Version: 1

interface MessageStore {
  id: string;           // UUID
  peerCode: string;     // Peer identifier
  content: string;      // Encrypted content
  sender: 'me' | 'peer';
  timestamp: Date;
  status: 'pending' | 'sent' | 'delivered' | 'failed';
}

interface OutboxStore {
  id: string;           // UUID
  peerCode: string;
  encryptedContent: string;
  createdAt: Date;
  retryCount: number;
}

interface SessionStore {
  peerCode: string;
  publicKey: string;
  fingerprint: string;
  lastConnected: Date;
}
```

### 4.3 Caching Strategy Updates

Update `vite.config.ts` workbox configuration:

```typescript
workbox: {
  globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
  runtimeCaching: [
    // Static assets - Cache First
    {
      urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|woff2)$/,
      handler: 'CacheFirst',
      options: {
        cacheName: 'static-assets',
        expiration: {
          maxEntries: 100,
          maxAgeSeconds: 30 * 24 * 60 * 60
        }
      }
    },
    // Signaling server - Network Only (real-time)
    {
      urlPattern: /wss?:\/\/.*/,
      handler: 'NetworkOnly'
    }
  ],
  // Enable background sync for message queue
  // Note: Requires injectManifest for full control
}
```

### 4.4 Background Sync Implementation

For full background sync support, switch to `injectManifest` strategy:

```typescript
// vite.config.ts
VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  injectManifest: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}']
  }
})
```

Custom service worker (`src/sw.ts`):

```typescript
import { precacheAndRoute } from 'workbox-precaching';
import { BackgroundSyncPlugin } from 'workbox-background-sync';
import { registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope;

// Precache app shell
precacheAndRoute(self.__WB_MANIFEST);

// Background sync for message queue
const bgSyncPlugin = new BackgroundSyncPlugin('message-queue', {
  maxRetentionTime: 24 * 60 // 24 hours
});

// Handle sync events
self.addEventListener('sync', (event) => {
  if (event.tag === 'send-messages') {
    event.waitUntil(sendQueuedMessages());
  }
});

async function sendQueuedMessages() {
  // Read from IndexedDB outbox
  // Attempt to send each message
  // Remove from outbox on success
}
```

---

## 5. Implementation Recommendations

### 5.1 Phase 1: Quick Wins (1-2 days)

1. **Integrate PWA Hook in App.tsx**
   ```typescript
   import { usePWA } from './lib/pwa';

   export function App() {
     const { offlineReady, needRefresh, updateServiceWorker } = usePWA();

     // Show update banner when needRefresh is true
     // Show "Ready for offline" toast when offlineReady is true
   }
   ```

2. **Add Offline Status Indicator**
   - Use `navigator.onLine` and `online`/`offline` events
   - Show banner when offline with appropriate messaging

3. **Fix CSP for Service Worker**
   - Current CSP may need `worker-src 'self'` directive

### 5.2 Phase 2: Message Persistence (3-5 days)

1. **Add IndexedDB Integration**
   - Use [idb](https://github.com/jakearchibald/idb) or [Dexie.js](https://dexie.org/)
   - Create message and session stores
   - Persist messages on send/receive

2. **Implement Message History**
   - Load cached messages on reconnect
   - Show previously exchanged messages with peer

3. **Add Offline Message Queue**
   - Queue messages when offline
   - Visual indicator for pending messages
   - Sync when connection restored

### 5.3 Phase 3: Advanced Features (1-2 weeks)

1. **Background Sync**
   - Switch to `injectManifest` strategy
   - Implement custom service worker
   - Handle sync events for message queue

2. **Push Notifications** (Optional)
   - Requires server-side VAPID setup
   - Request permission in context
   - Handle notification clicks

3. **Install Prompt UI**
   - Capture `beforeinstallprompt` event
   - Show custom install button
   - Track installation analytics

---

## 6. iOS Considerations

**Source**: [Brainhub - PWA on iOS](https://brainhub.eu/library/pwa-on-ios)

| Feature | iOS Support |
|---------|-------------|
| Service Workers | Yes (since iOS 11.3) |
| Background Sync | **No** |
| Push Notifications | Yes (iOS 16.4+, PWA only) |
| IndexedDB | Yes (with storage limits) |
| Add to Home Screen | Manual only |

**Implications for Zajel**:
- Background Sync will NOT work on iOS Safari
- Must implement fallback with `online` event listener
- Push notifications require PWA to be installed first
- Cannot prompt users to install (no `beforeinstallprompt`)

---

## 7. Security Considerations

### 7.1 Service Worker Security

- Service workers require HTTPS in production
- Current CSP allows WebSocket connections (`wss:`)
- Cached data should not include unencrypted sensitive information

### 7.2 IndexedDB Security

- IndexedDB is same-origin isolated
- Should store only encrypted message content
- Session keys should remain in memory only
- Consider adding encryption at rest for extra protection

### 7.3 Cache Security

- Do not cache authentication tokens
- Set appropriate cache expiration
- Use versioned cache names for invalidation

---

## 8. Testing Checklist

### 8.1 PWA Compliance

- [ ] Lighthouse PWA audit passes (90+ score)
- [ ] Manifest loads correctly
- [ ] Service worker registers successfully
- [ ] App installable on Android Chrome
- [ ] App installable on iOS Safari (Add to Home Screen)
- [ ] Update prompts appear when new version available

### 8.2 Offline Functionality

- [ ] App shell loads when offline
- [ ] Offline indicator shows correctly
- [ ] Previously sent messages visible offline
- [ ] Can compose messages while offline
- [ ] Messages queue and send when back online
- [ ] WebRTC reconnects automatically

### 8.3 Cross-Browser Testing

- [ ] Chrome (desktop and mobile)
- [ ] Firefox (desktop and mobile)
- [ ] Safari (desktop and iOS)
- [ ] Edge (desktop)

---

## 9. Files Requiring Changes

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/web-client/src/App.tsx` | Modify | Integrate usePWA hook |
| `packages/web-client/src/main.tsx` | Modify | Add offline event listeners |
| `packages/web-client/vite.config.ts` | Modify | Enhance workbox config |
| `packages/web-client/src/lib/storage.ts` | Create | IndexedDB abstraction |
| `packages/web-client/src/lib/messageQueue.ts` | Create | Offline message queue |
| `packages/web-client/src/components/OfflineBanner.tsx` | Create | Offline indicator |
| `packages/web-client/src/components/UpdatePrompt.tsx` | Create | Update notification UI |

---

## 10. References

### Official Documentation
- [vite-plugin-pwa Documentation](https://vite-pwa-org.netlify.app)
- [Workbox Documentation](https://developer.chrome.com/docs/workbox/)
- [MDN Progressive Web Apps](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps)
- [web.dev Learn PWA](https://web.dev/learn/pwa)

### Research Sources
- [Building Offline-First PWA Notes App](https://oluwadaprof.medium.com/building-an-offline-first-pwa-notes-app-with-next-js-indexeddb-and-supabase-f861aa3a06f9)
- [Offline-First Frontend Apps in 2025](https://blog.logrocket.com/offline-first-frontend-apps-2025-indexeddb-sqlite/)
- [Microsoft Edge Background Syncs](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/background-syncs)
- [PWA Offline Capabilities](https://www.zeepalm.com/blog/pwa-offline-capabilities-service-workers-and-web-api-integration/)
- [Progressive Web Apps Guide 2025](https://isitdev.com/progressive-web-apps-pwa-guide-2025/)

### Competitor Analysis
- [Telegram Web A Source](https://sourceforge.net/projects/telegram-web-a.mirror/)
- [Building PWA WhatsApp/Telegram](https://blog.accubits.com/building-pwa-whatsapp-or-pwa-telegram-possibilities-of-pwa/)
- [Discord PWA Discussion](https://support.discord.com/hc/en-us/community/posts/360031002972-Discord-as-a-PWA)
- [Discord PWA Wrapper](https://github.com/NeverDecaf/discord-PWA)

### Vite PWA Resources
- [vite-plugin-pwa GitHub](https://github.com/vite-pwa/vite-plugin-pwa)
- [Workbox Caching Strategies](https://vite-pwa-org.netlify.app/workbox/)
- [Firebase + Vite Push Notifications](https://dmelo.eu/blog/vite_pwa/)

---

## 11. Conclusion

Zajel has a **solid PWA foundation** with proper manifest configuration, icons, and service worker generation. However, the implementation is incomplete for a messaging application:

**Strengths**:
- vite-plugin-pwa properly configured
- All required PWA assets present
- Good manifest configuration
- TypeScript support for PWA

**Critical Gaps**:
1. PWA hook exists but is not integrated into the UI
2. No offline message storage (IndexedDB)
3. No message queue for offline composition
4. No background sync for message delivery
5. No offline status indicator for users

**Recommended Priority**:
1. **Immediate**: Integrate `usePWA()` hook for update prompts
2. **Short-term**: Add offline status indicator and message persistence
3. **Medium-term**: Implement background sync for message queue
4. **Long-term**: Consider push notifications for incoming messages

The existing codebase provides a strong starting point. With the recommended changes, Zajel can achieve feature parity with major messaging PWAs while maintaining its P2P architecture and end-to-end encryption.
