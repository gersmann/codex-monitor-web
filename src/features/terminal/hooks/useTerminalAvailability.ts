import { useEffect, useState } from "react";
import { isWebCompanionRuntime } from "@services/runtime";
import { getDaemonInfo } from "@services/tauri";

export function useTerminalAvailability() {
  const [terminalAvailable, setTerminalAvailable] = useState<boolean | null>(
    isWebCompanionRuntime() ? null : true,
  );

  useEffect(() => {
    if (!isWebCompanionRuntime()) {
      setTerminalAvailable(true);
      return;
    }

    let cancelled = false;

    void getDaemonInfo()
      .then((info) => {
        if (cancelled) {
          return;
        }
        setTerminalAvailable(info.capabilities?.terminal === true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setTerminalAvailable(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return terminalAvailable;
}
