// Phone (Home Screen app) service worker: shows thread notifications pushed by the
// Mac and opens the thread when one is tapped. No fetch handler: nothing is cached.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Marshal", {
      body: data.body || "",
      tag: data.tag,
      icon: "/remote-icon.png",
      badge: "/remote-icon.png",
      data: { sessionId: typeof data.sessionId === "string" ? data.sessionId : null },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows[0];
      if (client) {
        if (sessionId) client.postMessage({ type: "marshal:open-session", sessionId });
        return client.focus();
      }
      return self.clients.openWindow(
        sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/",
      );
    })(),
  );
});
