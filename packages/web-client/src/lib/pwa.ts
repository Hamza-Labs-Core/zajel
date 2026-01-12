import { useRegisterSW } from 'virtual:pwa-register/preact';
import { handleError, ErrorCodes } from './errors';

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
      // Use centralized error handling - SW registration errors are recoverable
      handleError(error, 'pwa.serviceWorkerRegistration', ErrorCodes.INITIALIZATION_FAILED);
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
