import { Notification } from "electron";

// Electron does not retain a strong V8 reference to Notification objects, so
// keep each instance alive or its click handler can be lost. Electron #29461
// means Windows Action Center clicks do not emit "click"; closing on a banner
// click removes the notification from Action Center after interaction.
const liveNotifications = new Set<Electron.Notification>();

export function sendOSNotification(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;

  const notification = new Notification({ title, body });
  liveNotifications.add(notification);
  notification.on("click", () => {
    liveNotifications.delete(notification);
    notification.close();
    onClick?.();
  });
  notification.show();
}
