// TermHub service worker — Web Push 수신 및 알림 클릭 처리 전용 (오프라인 캐시 없음)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: 'TermHub', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'TermHub', {
    body: data.body || '',
    // 같은 워커의 알림은 하나로 합친다 (tag 동일 → 교체)
    tag: data.tag || 'termhub',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: data.data || {}
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const info = e.notification.data || {};
  const targetUrl = new URL(info.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      client.focus();
      client.postMessage({ type: 'focus-worker', workerId: info.workerId || null });
      return;
    }
    return self.clients.openWindow(targetUrl);
  }));
});
