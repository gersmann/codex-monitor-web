import { isWebCompanionRuntime } from "./runtime";

export type DragDropPayload = {
  type: "enter" | "over" | "leave" | "drop";
  position: { x: number; y: number };
  paths?: string[];
};

export type DragDropEvent = {
  payload: DragDropPayload;
};

type Listener = (event: DragDropEvent) => void;

type SubscriptionOptions = {
  onError?: (error: unknown) => void;
};

let unlisten: (() => void) | null = null;
let listenPromise: Promise<() => void> | null = null;
const listeners = new Set<Listener>();

function start(options?: SubscriptionOptions) {
  if (unlisten || listenPromise) {
    return;
  }
  if (isWebCompanionRuntime()) {
    return;
  }
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      listenPromise = getCurrentWindow()
      .onDragDropEvent((event) => {
        for (const listener of listeners) {
          try {
            listener(event as DragDropEvent);
          } catch (error) {
            console.error("[drag-drop] listener failed", error);
          }
        }
          }) as Promise<() => void>;
      return listenPromise;
    })
    .then((handler) => {
      if (!handler) {
        return;
      }
      listenPromise = null;
      if (listeners.size === 0) {
        handler();
        return;
      }
      unlisten = handler;
    })
    .catch((error) => {
      listenPromise = null;
      options?.onError?.(error);
    });
}

function stop() {
  if (!unlisten) {
    return;
  }
  try {
    unlisten();
  } catch {
    // Ignore double-unlisten when tearing down.
  }
  unlisten = null;
}

export function subscribeWindowDragDrop(
  onEvent: Listener,
  options?: SubscriptionOptions,
) {
  listeners.add(onEvent);
  start(options);
  return () => {
    listeners.delete(onEvent);
    if (listeners.size === 0) {
      stop();
    }
  };
}
