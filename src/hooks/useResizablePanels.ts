import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY_SIDEBAR = "codexmonitor.sidebarWidth";
const STORAGE_KEY_RIGHT_PANEL = "codexmonitor.rightPanelWidth";
const STORAGE_KEY_PLAN_PANEL = "codexmonitor.planPanelHeight";
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_RIGHT_PANEL_WIDTH = 200;
const MAX_RIGHT_PANEL_WIDTH = 420;
const MIN_PLAN_PANEL_HEIGHT = 140;
const MAX_PLAN_PANEL_HEIGHT = 420;
const DEFAULT_SIDEBAR_WIDTH = 280;
const DEFAULT_RIGHT_PANEL_WIDTH = 230;
const DEFAULT_PLAN_PANEL_HEIGHT = 220;

type ResizeState = {
  type: "sidebar" | "right-panel" | "plan-panel";
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
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
  const [planPanelHeight, setPlanPanelHeight] = useState(() =>
    readStoredWidth(
      STORAGE_KEY_PLAN_PANEL,
      DEFAULT_PLAN_PANEL_HEIGHT,
      MIN_PLAN_PANEL_HEIGHT,
      MAX_PLAN_PANEL_HEIGHT,
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
    window.localStorage.setItem(
      STORAGE_KEY_PLAN_PANEL,
      String(planPanelHeight),
    );
  }, [planPanelHeight]);

  useEffect(() => {
    function handleMouseMove(event: MouseEvent) {
      if (!resizeRef.current) {
        return;
      }
      if (resizeRef.current.type === "sidebar") {
        const delta = event.clientX - resizeRef.current.startX;
        const next = clamp(
          resizeRef.current.startWidth + delta,
          MIN_SIDEBAR_WIDTH,
          MAX_SIDEBAR_WIDTH,
        );
        setSidebarWidth(next);
      } else if (resizeRef.current.type === "right-panel") {
        const delta = event.clientX - resizeRef.current.startX;
        const next = clamp(
          resizeRef.current.startWidth - delta,
          MIN_RIGHT_PANEL_WIDTH,
          MAX_RIGHT_PANEL_WIDTH,
        );
        setRightPanelWidth(next);
      } else {
        const delta = event.clientY - resizeRef.current.startY;
        const next = clamp(
          resizeRef.current.startHeight - delta,
          MIN_PLAN_PANEL_HEIGHT,
          MAX_PLAN_PANEL_HEIGHT,
        );
        setPlanPanelHeight(next);
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
        startY: event.clientY,
        startWidth: sidebarWidth,
        startHeight: planPanelHeight,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [planPanelHeight, sidebarWidth],
  );

  const onRightPanelResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      resizeRef.current = {
        type: "right-panel",
        startX: event.clientX,
        startY: event.clientY,
        startWidth: rightPanelWidth,
        startHeight: planPanelHeight,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [planPanelHeight, rightPanelWidth],
  );

  const onPlanPanelResizeStart = useCallback(
    (event: ReactMouseEvent) => {
      resizeRef.current = {
        type: "plan-panel",
        startX: event.clientX,
        startY: event.clientY,
        startWidth: rightPanelWidth,
        startHeight: planPanelHeight,
      };
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [planPanelHeight, rightPanelWidth],
  );

  return {
    sidebarWidth,
    rightPanelWidth,
    planPanelHeight,
    onSidebarResizeStart,
    onRightPanelResizeStart,
    onPlanPanelResizeStart,
  };
}
