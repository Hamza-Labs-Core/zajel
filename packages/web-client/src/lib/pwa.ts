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
    if (typeof setOfflineReady === 'function') {
      setOfflineReady(false);
    }
    if (typeof setNeedRefresh === 'function') {
      setNeedRefresh(false);
    }
  };

  return {
    offlineReady,
    needRefresh,
    updateServiceWorker,
    close
  };
}
