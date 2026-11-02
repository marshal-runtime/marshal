/** Registers the phone's notification service worker and routes notification taps. */
export function registerRemoteServiceWorker(
  onOpenSession: (sessionId: string) => void,
): () => void {
  if (window.marshalCloudRemote || !("serviceWorker" in navigator)) return () => {};
  void navigator.serviceWorker.register("/remote-sw.js").catch(() => {
    /* Notifications stay unavailable; the app itself does not depend on it. */
  });
  const onMessage = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      data.type === "marshal:open-session" &&
      "sessionId" in data &&
      typeof data.sessionId === "string"
    )
      onOpenSession(data.sessionId);
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
