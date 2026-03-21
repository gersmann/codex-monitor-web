import { isWebCompanionRuntime } from "./runtime";

type PwaState = {
  updateAvailable: boolean;
};

type PwaListener = (state: PwaState) => void;

const listeners = new Set<PwaListener>();
let pwaState: PwaState = {
  updateAvailable: false,
};
let updateServiceWorker:
  | ((reloadPage?: boolean) => Promise<void>)
  | null = null;
let registrationStarted = false;

function emitPwaState() {
  for (const listener of listeners) {
    listener(pwaState);
  }
}

export function getPwaState() {
  return pwaState;
}

export function subscribePwaState(listener: PwaListener) {
  listeners.add(listener);
  listener(pwaState);
  return () => {
    listeners.delete(listener);
  };
}

export async function registerPwaServiceWorker() {
  if (
    registrationStarted ||
    !isWebCompanionRuntime() ||
    !import.meta.env.PROD ||
    typeof window === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return;
  }
  registrationStarted = true;

  const { registerSW } = await import("virtual:pwa-register");
  updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      pwaState = {
        ...pwaState,
        updateAvailable: true,
      };
      emitPwaState();
    },
  });
}

export async function applyPwaUpdate() {
  if (!updateServiceWorker) {
    return;
  }
  await updateServiceWorker(true);
}

export function dismissPwaUpdateNotice() {
  if (!pwaState.updateAvailable) {
    return;
  }
  pwaState = {
    ...pwaState,
    updateAvailable: false,
  };
  emitPwaState();
}
