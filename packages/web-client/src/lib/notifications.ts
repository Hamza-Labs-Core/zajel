import { logger } from './logger';

let swRegistration: ServiceWorkerRegistration | null = null;

/** Register the service worker for notifications. */
export async function registerServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) {
    logger.warn('[Notifications] Service workers not supported');
    return false;
  }

  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
    logger.info('[Notifications] Service worker registered');
    return true;
  } catch (err) {
    logger.error('[Notifications] SW registration failed:', err);
    return false;
  }
}

/** Request notification permission. Returns true if granted. */
export async function requestPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;

  const result = await Notification.requestPermission();
  return result === 'granted';
}

/** Show a notification using the Notification API. */
export function showNotification(
  title: string,
  body: string,
  options?: { tag?: string; data?: unknown },
): void {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  // Use service worker registration if available for persistence
  if (swRegistration) {
    swRegistration.showNotification(title, {
      body,
      icon: '/favicon.ico',
      tag: options?.tag || 'zajel',
      data: options?.data,
    });
  } else {
    new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag: options?.tag || 'zajel',
    });
  }
}

/** Show message notification when tab is not focused. */
export function notifyMessage(peerName: string, content: string): void {
  if (document.hasFocus()) return;
  showNotification(peerName, content, { tag: `msg-${peerName}` });
}

/** Show incoming call notification when tab is not focused. */
export function notifyIncomingCall(peerName: string, withVideo: boolean): void {
  if (document.hasFocus()) return;
  const callType = withVideo ? 'Video' : 'Voice';
  showNotification(`Incoming ${callType} Call`, peerName, {
    tag: `call-${peerName}`,
  });
}
