import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY_SIDEBAR = "codexmonitor.sidebarWidth";
const STORAGE_KEY_RIGHT_PANEL = "codexmonitor.rightPanelWidth";
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_RIGHT_PANEL_WIDTH = 200;
const MAX_RIGHT_PANEL_WIDTH = 420;
const DEFAULT_SIDEBAR_WIDTH = 280;
const DEFAULT_RIGHT_PANEL_WIDTH = 230;

type ResizeState = {
  type: "sidebar" | "right-panel";
  startX: number;
  startWidth: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readStoredWidth(key: string, fallback: number, min: number, max: number) {
  if (typeof window === "undefined") {
    return fallback;
  }
  const raw = window.localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clamp(parsed, min, max);
}

export function useResizablePanels() {
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredWidth(
      STORAGE_KEY_SIDEBAR,
      DEFAULT_SIDEBAR_WIDTH,
      MIN_SIDEBAR_WIDTH,
      MAX_SIDEBAR_WIDTH,
    ),
  );
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    readStoredWidth(
      STORAGE_KEY_RIGHT_PANEL,
      DEFAULT_RIGHT_PANEL_WIDTH,
      MIN_RIGHT_PANEL_WIDTH,
      MAX_RIGHT_PANEL_WIDTH,
    ),
  );
  const resizeRef = useRef<ResizeState | null>(null);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY_SIDEBAR, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_KEY_RIGHT_PANEL,
      String(rightPanelWidth),
    );
  }, [rightPanelWidth]);

  useEffect(() => {
    function handleMouseMove(event: MouseEvent) {
      if (!resizeRef.current) {
        return;
      }
      const delta = event.clientX - resizeRef.current.startX;
      if (resizeRef.current.type === "sidebar") {
        const next = clamp(
          resizeRef.current.startWidth + delta,
          MIN_SIDEBAR_WIDTH,
          MAX_SIDEBAR_WIDTH,
        );
        setSidebarWidth(next);
      } else {
        const next = clamp(
          resizeRef.current.startWidth - delta,
          MIN_RIGHT_PANEL_WIDTH,
          MAX_RIGHT_PANEL_WIDTH,
        );
        setRightPanelWidth(next);
      }
    }

    function handleMouseUp() {
      if (!resizeRef.current) {
        return;
      }
      resizeRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const onSidebarResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      resizeRef.current = {
        type: "sidebar",
        startX: event.clientX,
        startWidth: sidebarWidth,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth],
  );

  const onRightPanelResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      resizeRef.current = {
        type: "right-panel",
        startX: event.clientX,
        startWidth: rightPanelWidth,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [rightPanelWidth],
  );

  return {
    sidebarWidth,
    rightPanelWidth,
    onSidebarResizeStart,
    onRightPanelResizeStart,
  };
}
