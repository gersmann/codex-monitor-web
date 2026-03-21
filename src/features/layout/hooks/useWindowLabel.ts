import { useEffect, useState } from "react";

export function useWindowLabel(defaultLabel = "main") {
  const [label, setLabel] = useState(defaultLabel);

  useEffect(() => {
    let cancelled = false;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (cancelled) {
          return;
        }
        const window = getCurrentWindow();
        setLabel(window.label ?? defaultLabel);
      })
      .catch(() => {
        if (!cancelled) {
          setLabel(defaultLabel);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [defaultLabel]);

  return label;
}
