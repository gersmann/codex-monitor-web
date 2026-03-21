import { useCallback, useEffect, useState } from "react";

export const STORAGE_KEY_TERMINAL_PANEL = "codexmonitor.terminalPanelOpen";

export function readTerminalPanelOpenState() {
  if (typeof window === "undefined") {
    return {} as Record<string, boolean>;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_TERMINAL_PANEL);
    if (!raw) {
      return {} as Record<string, boolean>;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {} as Record<string, boolean>;
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {} as Record<string, boolean>;
  }
}

export function writeTerminalPanelOpenState(value: Record<string, boolean>) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY_TERMINAL_PANEL, JSON.stringify(value));
}

type UsePanelVisibilityOptions = {
  isCompact: boolean;
  activeWorkspaceId: string | null;
  terminalSupported?: boolean | null;
  setActiveTab: (tab: "home" | "codex" | "git" | "log" | "projects") => void;
  setDebugOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
};

export function usePanelVisibility({
  isCompact,
  activeWorkspaceId,
  terminalSupported = true,
  setActiveTab,
  setDebugOpen,
}: UsePanelVisibilityOptions) {
  const [terminalOpen, setTerminalOpen] = useState(false);

  useEffect(() => {
    if (!activeWorkspaceId || terminalSupported === null) {
      return;
    }
    if (!terminalSupported) {
      setTerminalOpen(false);
      return;
    }
    const stored = readTerminalPanelOpenState();
    setTerminalOpen(stored[activeWorkspaceId] === true);
  }, [activeWorkspaceId, terminalSupported]);

  useEffect(() => {
    if (!activeWorkspaceId || terminalSupported === null) {
      return;
    }
    const stored = readTerminalPanelOpenState();
    if (!terminalSupported) {
      if (!(activeWorkspaceId in stored)) {
        return;
      }
      const { [activeWorkspaceId]: _removed, ...rest } = stored;
      writeTerminalPanelOpenState(rest);
      return;
    }
    writeTerminalPanelOpenState({
      ...stored,
      [activeWorkspaceId]: terminalOpen,
    });
  }, [activeWorkspaceId, terminalOpen, terminalSupported]);

  const onToggleDebug = useCallback(() => {
    if (isCompact) {
      setActiveTab("log");
      return;
    }
    setDebugOpen((prev) => !prev);
  }, [isCompact, setActiveTab, setDebugOpen]);

  const onToggleTerminal = useCallback(() => {
    if (!activeWorkspaceId || !terminalSupported) {
      return;
    }
    setTerminalOpen((prev) => !prev);
  }, [activeWorkspaceId, terminalSupported]);

  const openTerminal = useCallback(() => {
    if (!activeWorkspaceId || !terminalSupported) {
      return;
    }
    setTerminalOpen(true);
  }, [activeWorkspaceId, terminalSupported]);

  const closeTerminal = useCallback(() => {
    setTerminalOpen(false);
  }, []);

  return {
    terminalOpen,
    onToggleDebug,
    onToggleTerminal,
    openTerminal,
    closeTerminal,
  };
}
