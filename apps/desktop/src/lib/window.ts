import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

const quitEvent = "nautilus://quit-requested";

export async function systemAlert(title: string, body: string): Promise<void> {
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification({ title, body });
}

export function onQuitRequested(shutdown: () => Promise<void>): () => void {
  const unlisten = listen(quitEvent, () => {
    void shutdown().finally(() => {
      void getCurrentWindow().destroy();
    });
  });
  return () => {
    void unlisten.then((stop) => {
      stop();
    });
  };
}
