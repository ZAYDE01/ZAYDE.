// /sw.js — Service worker de ZAYDE
//
// Dos trabajos:
// 1) Permitir que el sitio se pueda "instalar" como app (PWA) en el
//    celular/computadora del cliente.
// 2) Mostrar las notificaciones push reales cuando llega un aviso (por
//    ejemplo, "el Drop en vivo ya comenzó").
//
// A propósito NO se cachea todo el sitio de forma agresiva (el sitio ya
// cambia seguido desde el panel admin y usa datos en vivo de Firestore),
// así que este service worker es intencionalmente ligero: no interfiere
// con las peticiones normales, solo habilita instalación + push.

const CACHE_NAME = 'zayde-shell-v1';
const SHELL_FILES = ['/', '/manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estrategia "network first, cache de respaldo" SOLO para la página de
// inicio — así el sitio abre rápido incluso con mala conexión, pero sigue
// mostrando siempre la versión más reciente cuando hay internet.
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
  }
});

/* ================= NOTIFICACIONES PUSH ================= */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: 'ZAYDE', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'ZAYDE';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
    vibrate: [100, 50, 100]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) { client.focus(); return; }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
