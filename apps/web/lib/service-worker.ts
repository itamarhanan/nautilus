export function setUpServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (process.env.NODE_ENV === "production") {
    const version = encodeURIComponent(process.env.NAUTILUS_BUILD_ID ?? "dev");
    void navigator.serviceWorker.register(`/sw.js?v=${version}`);
    return;
  }

  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => Promise.all(registrations.map((one) => one.unregister())))
    .then(() => caches.keys())
    .then((keys) => Promise.all(keys.map((key) => caches.delete(key))));
}
