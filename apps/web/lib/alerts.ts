let unseen = 0;

let baseTitle: string | null = null;

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function requestAlertPermission(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => undefined);
}

export type Alert = {
  title: string;
  body: string;

  tag: string;

  url: string;
};

export function showAlert(alert: Alert): void {
  if (!isHidden()) return;
  unseen += 1;
  baseTitle ??= document.title;
  document.title = `(${String(unseen)}) ${baseTitle}`;

  if ("setAppBadge" in navigator) void navigator.setAppBadge(unseen).catch(() => undefined);
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const options: NotificationOptions = {
    body: alert.body,
    tag: alert.tag,
    data: { url: alert.url },
  };

  if (!("serviceWorker" in navigator)) {
    new Notification(alert.title, options);
    return;
  }
  void navigator.serviceWorker.ready
    .then((registration) => registration.showNotification(alert.title, options))
    .catch(() => {
      new Notification(alert.title, options);
    });
}

export function clearAlerts(): void {
  if (unseen === 0) return;
  unseen = 0;
  if (baseTitle !== null) document.title = baseTitle;
  baseTitle = null;
  if ("clearAppBadge" in navigator) void navigator.clearAppBadge().catch(() => undefined);
}
