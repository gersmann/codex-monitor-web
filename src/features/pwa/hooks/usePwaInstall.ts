import { useEffect, useMemo, useState } from "react";
import {
  applyPwaUpdate,
  dismissPwaUpdateNotice,
  getPwaState,
  subscribePwaState,
} from "@services/pwa";
import { isWebCompanionRuntime } from "@services/runtime";

type BeforeInstallPromptChoice = {
  outcome: "accepted" | "dismissed";
  platform: string;
};

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<BeforeInstallPromptChoice>;
};

type NavigatorStandalone = Navigator & {
  standalone?: boolean;
};

function detectStandaloneMode() {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as NavigatorStandalone).standalone === true
  );
}

export function usePwaInstall() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState(false);
  const [standalone, setStandalone] = useState(() => detectStandaloneMode());
  const [updateAvailable, setUpdateAvailable] = useState(() => getPwaState().updateAvailable);

  useEffect(() => {
    if (!isWebCompanionRuntime() || typeof window === "undefined") {
      return;
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
      setInstallDismissed(false);
    };

    const handleAppInstalled = () => {
      setInstallEvent(null);
      setInstallDismissed(true);
      setStandalone(true);
    };

    const mediaQuery = window.matchMedia("(display-mode: standalone)");
    const handleDisplayModeChange = () => {
      setStandalone(detectStandaloneMode());
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    mediaQuery.addEventListener("change", handleDisplayModeChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
      mediaQuery.removeEventListener("change", handleDisplayModeChange);
    };
  }, []);

  useEffect(() => {
    if (!isWebCompanionRuntime()) {
      return;
    }
    return subscribePwaState((state) => {
      setUpdateAvailable(state.updateAvailable);
    });
  }, []);

  const showInstallPrompt = useMemo(
    () => isWebCompanionRuntime() && !standalone && !installDismissed && installEvent !== null,
    [installDismissed, installEvent, standalone],
  );

  return {
    showInstallPrompt,
    updateAvailable,
    standalone,
    installApp: async () => {
      if (!installEvent) {
        return;
      }
      await installEvent.prompt();
      const result = await installEvent.userChoice;
      if (result.outcome === "accepted") {
        setInstallDismissed(true);
      }
      setInstallEvent(null);
    },
    dismissInstallPrompt: () => {
      setInstallDismissed(true);
    },
    applyUpdate: async () => {
      await applyPwaUpdate();
    },
    dismissUpdate: () => {
      dismissPwaUpdateNotice();
    },
  };
}
