import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION || process.env.VERCEL_GIT_COMMIT_SHA || 'tenda-sw-v1';
  return new NextResponse(serviceWorkerSource(version), {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Service-Worker-Allowed': '/',
    },
  });
}

function serviceWorkerSource(version: string): string {
  return `
const SW_VERSION = ${JSON.stringify(version)};
const CACHE_PREFIX = 'tenda-v';
const ASSETS_CACHE = CACHE_PREFIX + 'assets';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== ASSETS_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/' || url.pathname === '/login' || url.pathname === '/setup' || url.pathname === '/sw.js') {
    return;
  }
  if (/\\.(png|ico|webp|woff2?)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(event.request));
  }
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(ASSETS_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 503 });
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Tenda Monitor', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Tenda Monitor';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'tenda-monitor',
    data: { url: cleanUrl(data.url || '/') },
  };
  if (data.image && typeof data.image === 'string' && data.image.startsWith('/')) {
    options.image = data.image;
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(cleanUrl(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil((async () => {
    const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        if (client.url !== targetUrl && 'navigate' in client) return client.navigate(targetUrl);
        return client;
      }
    }
    return clients.openWindow(targetUrl);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      let nextSub = event.newSubscription || null;
      if (!nextSub) {
        const response = await fetch('/api/push/vapid-key', { credentials: 'include' });
        if (!response.ok) return;
        const data = await response.json();
        if (!data.publicKey) return;
        nextSub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(data.publicKey),
        });
      }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(nextSub.toJSON()),
      });
    } catch {
      // Subscription rotation is best-effort; the page will retry on next open.
    }
  })());
});

function cleanUrl(raw) {
  if (typeof raw !== 'string') return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  try {
    const parsed = new URL(raw, self.location.origin);
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return '/';
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
`;
}
