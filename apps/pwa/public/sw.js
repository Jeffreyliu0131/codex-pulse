const CACHE_NAME = "codexpulse-shell-v2";
const SHELL = ["/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const rootResponse = await fetch("/", { cache: "no-cache" });
    await cache.put("/", rootResponse.clone());
    const html = await rootResponse.text();
    const builtAssets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
      .map((match) => match[1]);
    await cache.addAll([...SHELL, ...new Set(builtAssets)]);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request)) || (await caches.match("/"))),
  );
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    payload = null;
  }
  const notification = payload?.notification;
  const data = notification?.data;
  if (!notification?.title || !data?.url) {
    event.waitUntil(
      self.registration.showNotification("CodexPulse 有新的任务状态", {
        body: "打开应用查看安全详情",
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        data: { url: "/" },
      }),
    );
    return;
  }
  event.waitUntil(
    self.registration.showNotification(notification.title, {
      body: notification.body || "打开应用查看详情",
      lang: notification.lang || "zh-CN",
      silent: false,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: data.eventId || "codexpulse-event",
      renotify: false,
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const requested = event.notification.data?.url || "/";
  let target;
  try {
    const candidate = new URL(requested, self.location.origin);
    target = candidate.origin === self.location.origin
      ? candidate
      : new URL("/", self.location.origin);
  } catch {
    target = new URL("/", self.location.origin);
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      for (const client of windows) {
        if ("navigate" in client) await client.navigate(target.href);
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
