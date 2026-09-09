const CACHE_NAME = 'wrongstack-hq-mobile-v1';
const SHELL_URL = '/mobile';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([SHELL_URL, '/wrongstack.svg'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Auth, telemetry, transcript and control data are never cached. The mobile
  // PWA is an offline shell, not an offline copy of sensitive HQ state.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  if (
    request.mode === 'navigate' &&
    (url.pathname === '/mobile' || url.pathname.startsWith('/mobile/'))
  ) {
    event.respondWith(fetch(request).catch(() => caches.match(SHELL_URL)));
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname === '/wrongstack.svg') {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const mobile = clients.find((client) => new URL(client.url).pathname.startsWith('/mobile'));
      if (mobile) return mobile.focus();
      return self.clients.openWindow('/mobile');
    }),
  );
});
