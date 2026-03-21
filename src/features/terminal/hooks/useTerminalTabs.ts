import { useCallback, useEffect, useMemo, useState } from "react";

export type TerminalTab = {
  id: string;
  title: string;
};

type TerminalTabRecord = TerminalTab & {
  autoNamed: boolean;
};

type UseTerminalTabsOptions = {
  activeWorkspaceId: string | null;
  onCloseTerminal?: (workspaceId: string, terminalId: string) => void;
};

export type StoredTerminalWorkspaceState = {
  tabs: TerminalTabRecord[];
  activeTerminalId: string | null;
};

export const STORAGE_KEY_TERMINAL_TABS = "codexmonitor.terminalTabs";

function createTerminalId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function renumberAutoNamedTabs(tabs: TerminalTabRecord[]): TerminalTabRecord[] {
  let autoNamedIndex = 1;
  let changed = false;
  const nextTabs = tabs.map((tab) => {
    if (!tab.autoNamed) {
      return tab;
    }
    const nextTitle = `Terminal ${autoNamedIndex}`;
    autoNamedIndex += 1;
    if (tab.title === nextTitle) {
      return tab;
    }
    changed = true;
    return {
      ...tab,
      title: nextTitle,
    };
  });
  return changed ? nextTabs : tabs;
}

export function readStoredTerminalTabs() {
  if (typeof window === "undefined") {
    return {} as Record<string, StoredTerminalWorkspaceState>;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_TERMINAL_TABS);
    if (!raw) {
      return {} as Record<string, StoredTerminalWorkspaceState>;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {} as Record<string, StoredTerminalWorkspaceState>;
    }
    const next: Record<string, StoredTerminalWorkspaceState> = {};
    for (const [workspaceId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      const record = value as {
        tabs?: unknown;
        activeTerminalId?: unknown;
      };
      const tabs = Array.isArray(record.tabs)
        ? record.tabs
            .filter((entry): entry is TerminalTabRecord => {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return false;
              }
              const tab = entry as {
                id?: unknown;
                title?: unknown;
                autoNamed?: unknown;
              };
              return (
                typeof tab.id === "string" &&
                tab.id.trim().length > 0 &&
                typeof tab.title === "string" &&
                typeof tab.autoNamed === "boolean"
              );
            })
            .map((tab) => ({
              id: tab.id,
              title: tab.title,
              autoNamed: tab.autoNamed,
            }))
        : [];
      next[workspaceId] = {
        tabs,
        activeTerminalId:
          typeof record.activeTerminalId === "string" &&
          record.activeTerminalId.trim().length > 0
            ? record.activeTerminalId
            : null,
      };
    }
    return next;
  } catch {
    return {} as Record<string, StoredTerminalWorkspaceState>;
  }
}

export function writeStoredTerminalTabs(
  tabsByWorkspace: Record<string, TerminalTabRecord[]>,
  activeTerminalIdByWorkspace: Record<string, string | null>,
) {
  if (typeof window === "undefined") {
    return;
  }
  const next: Record<string, StoredTerminalWorkspaceState> = {};
  for (const [workspaceId, tabs] of Object.entries(tabsByWorkspace)) {
    if (tabs.length === 0) {
      continue;
    }
    next[workspaceId] = {
      tabs,
      activeTerminalId: activeTerminalIdByWorkspace[workspaceId] ?? null,
    };
  }
  window.localStorage.setItem(STORAGE_KEY_TERMINAL_TABS, JSON.stringify(next));
}

export function useTerminalTabs({
  activeWorkspaceId,
  onCloseTerminal,
}: UseTerminalTabsOptions) {
  const [tabsByWorkspace, setTabsByWorkspace] = useState<Record<string, TerminalTabRecord[]>>(() => {
    const stored = readStoredTerminalTabs();
    return Object.fromEntries(
      Object.entries(stored).map(([workspaceId, record]) => [workspaceId, record.tabs]),
    );
  });
  const [activeTerminalIdByWorkspace, setActiveTerminalIdByWorkspace] = useState<
    Record<string, string | null>
  >(() => {
    const stored = readStoredTerminalTabs();
    return Object.fromEntries(
      Object.entries(stored).map(([workspaceId, record]) => [workspaceId, record.activeTerminalId]),
    );
  });
  const [restoredTerminalIdsByWorkspace, setRestoredTerminalIdsByWorkspace] = useState<
    Record<string, string[]>
  >(() => {
    const stored = readStoredTerminalTabs();
    return Object.fromEntries(
      Object.entries(stored).map(([workspaceId, record]) => [
        workspaceId,
        record.tabs.map((tab) => tab.id),
      ]),
    );
  });

  useEffect(() => {
    writeStoredTerminalTabs(tabsByWorkspace, activeTerminalIdByWorkspace);
  }, [activeTerminalIdByWorkspace, tabsByWorkspace]);

  const createTerminal = useCallback((workspaceId: string) => {
    const id = createTerminalId();
    setTabsByWorkspace((prev) => {
      const existing = prev[workspaceId] ?? [];
      const nextTabs = renumberAutoNamedTabs([
        ...existing,
        { id, title: "", autoNamed: true },
      ]);
      return {
        ...prev,
        [workspaceId]: nextTabs,
      };
    });
    setActiveTerminalIdByWorkspace((prev) => ({ ...prev, [workspaceId]: id }));
    setRestoredTerminalIdsByWorkspace((prev) => {
      const existing = prev[workspaceId] ?? [];
      if (existing.length === 0) {
        return prev;
      }
      return {
        ...prev,
        [workspaceId]: existing.filter((entry) => entry !== id),
      };
    });
    return id;
  }, []);

  const ensureTerminalWithTitle = useCallback(
    (workspaceId: string, terminalId: string, title: string) => {
      setTabsByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        const index = existing.findIndex((tab) => tab.id === terminalId);
        if (index === -1) {
          const nextTabs = renumberAutoNamedTabs([
            ...existing,
            { id: terminalId, title, autoNamed: false },
          ]);
          return {
            ...prev,
            [workspaceId]: nextTabs,
          };
        }
        if (!existing[index].autoNamed && existing[index].title === title) {
          return prev;
        }
        const nextTabs = existing.slice();
        nextTabs[index] = {
          ...existing[index],
          title,
          autoNamed: false,
        };
        return {
          ...prev,
          [workspaceId]: renumberAutoNamedTabs(nextTabs),
        };
      });
      setActiveTerminalIdByWorkspace((prev) => ({ ...prev, [workspaceId]: terminalId }));
      setRestoredTerminalIdsByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        if (!existing.includes(terminalId)) {
          return prev;
        }
        return {
          ...prev,
          [workspaceId]: existing.filter((entry) => entry !== terminalId),
        };
      });
      return terminalId;
    },
    [],
  );

  const closeTerminal = useCallback(
    (workspaceId: string, terminalId: string) => {
      setTabsByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        const nextTabs = renumberAutoNamedTabs(
          existing.filter((tab) => tab.id !== terminalId),
        );
        setActiveTerminalIdByWorkspace((prevActive) => {
          const active = prevActive[workspaceId];
          if (active !== terminalId) {
            return prevActive;
          }
          const nextActive = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1].id : null;
          if (!nextActive) {
            const { [workspaceId]: _, ...rest } = prevActive;
            return rest;
          }
          return { ...prevActive, [workspaceId]: nextActive };
        });
        if (nextTabs.length === 0) {
          const { [workspaceId]: _, ...rest } = prev;
          return rest;
        }
        return { ...prev, [workspaceId]: nextTabs };
      });
      setRestoredTerminalIdsByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        const nextIds = existing.filter((entry) => entry !== terminalId);
        if (nextIds.length === existing.length) {
          return prev;
        }
        if (nextIds.length === 0) {
          const { [workspaceId]: _removed, ...rest } = prev;
          return rest;
        }
        return {
          ...prev,
          [workspaceId]: nextIds,
        };
      });
      onCloseTerminal?.(workspaceId, terminalId);
    },
    [onCloseTerminal],
  );

  const setActiveTerminal = useCallback((workspaceId: string, terminalId: string) => {
    setActiveTerminalIdByWorkspace((prev) => ({ ...prev, [workspaceId]: terminalId }));
  }, []);

  const ensureTerminal = useCallback(
    (workspaceId: string) => {
      const active = activeTerminalIdByWorkspace[workspaceId];
      if (active) {
        return active;
      }
      return createTerminal(workspaceId);
    },
    [activeTerminalIdByWorkspace, createTerminal],
  );

  const terminals = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    return (tabsByWorkspace[activeWorkspaceId] ?? []).map(({ id, title }) => ({
      id,
      title,
    }));
  }, [activeWorkspaceId, tabsByWorkspace]);

  const activeTerminalId = useMemo(() => {
    if (!activeWorkspaceId) {
      return null;
    }
    return activeTerminalIdByWorkspace[activeWorkspaceId] ?? null;
  }, [activeTerminalIdByWorkspace, activeWorkspaceId]);

  return {
    terminals,
    activeTerminalId,
    createTerminal,
    ensureTerminalWithTitle,
    closeTerminal,
    setActiveTerminal,
    ensureTerminal,
    isRestoredTerminal: (workspaceId: string, terminalId: string) =>
      (restoredTerminalIdsByWorkspace[workspaceId] ?? []).includes(terminalId),
    markTerminalRestored: (workspaceId: string, terminalId: string) => {
      setRestoredTerminalIdsByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        if (!existing.includes(terminalId)) {
          return prev;
        }
        const nextIds = existing.filter((entry) => entry !== terminalId);
        if (nextIds.length === 0) {
          const { [workspaceId]: _removed, ...rest } = prev;
          return rest;
        }
        return {
          ...prev,
          [workspaceId]: nextIds,
        };
      });
    },
  };
}
