type Listener = () => void;

const resumeListeners = new Set<Listener>();
const offlineListeners = new Set<Listener>();

function subscribe(listeners: Set<Listener>, listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function onResume(listener: Listener): () => void {
  return subscribe(resumeListeners, listener);
}

export function onOffline(listener: Listener): () => void {
  return subscribe(offlineListeners, listener);
}

export function emitResume() {
  for (const listener of resumeListeners) listener();
}

export function emitOffline() {
  for (const listener of offlineListeners) listener();
}
