import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { WorkspaceInfo } from "../../../types";

type UseRemoteThreadRefreshOnFocusOptions = {
  backendMode: string;
  activeWorkspace: WorkspaceInfo | null;
  activeThreadId: string | null;
  activeThreadIsProcessing?: boolean;
  refreshThread: (workspaceId: string, threadId: string) => Promise<unknown> | unknown;
};

export function useRemoteThreadRefreshOnFocus({
  backendMode,
  activeWorkspace,
  activeThreadId,
  activeThreadIsProcessing = false,
  refreshThread,
}: UseRemoteThreadRefreshOnFocusOptions) {
  const workspaceId = activeWorkspace?.id ?? null;
  const workspaceConnected = Boolean(activeWorkspace?.connected);
  const refreshThreadRef = useRef(refreshThread);

  useEffect(() => {
    refreshThreadRef.current = refreshThread;
  }, [refreshThread]);

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let refreshInFlight = false;
    let didCleanup = false;
    let windowFocused =
      typeof document === "undefined" ? true : document.visibilityState === "visible";
    let unlistenWindowFocus: (() => void) | null = null;
    let unlistenWindowBlur: (() => void) | null = null;

    const canRefresh = () =>
      backendMode === "remote" &&
      workspaceConnected &&
      Boolean(workspaceId) &&
      Boolean(activeThreadId);

    const runRefresh = () => {
      if (!canRefresh() || !workspaceId || !activeThreadId || refreshInFlight) {
        return;
      }
      refreshInFlight = true;
      void Promise.resolve(
        refreshThreadRef.current(workspaceId, activeThreadId),
      )
        .catch(() => {
          // Ignore refresh failures so lifecycle hooks do not surface toast noise.
        })
        .finally(() => {
          refreshInFlight = false;
        });
    };

    const refreshActiveThread = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        runRefresh();
      }, 500);
    };

    const updatePolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (
        !canRefresh() ||
        activeThreadIsProcessing ||
        !windowFocused ||
        document.visibilityState !== "visible"
      ) {
        return;
      }
      const pollIntervalMs = 12000;
      pollTimer = setInterval(() => {
        runRefresh();
      }, pollIntervalMs);
    };

    const handleFocus = () => {
      windowFocused = true;
      refreshActiveThread();
      updatePolling();
    };

    const handleBlur = () => {
      windowFocused = false;
      updatePolling();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        windowFocused = true;
        refreshActiveThread();
      }
      updatePolling();
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    try {
      const windowHandle = getCurrentWindow();
      windowHandle
        .listen("tauri://focus", handleFocus)
        .then((unlisten) => {
          if (didCleanup) {
            unlisten();
            return;
          }
          unlistenWindowFocus = unlisten;
        })
        .catch(() => {
          // Ignore: DOM listeners still handle focus changes when available.
        });
      windowHandle
        .listen("tauri://blur", handleBlur)
        .then((unlisten) => {
          if (didCleanup) {
            unlisten();
            return;
          }
          unlistenWindowBlur = unlisten;
        })
        .catch(() => {
          // Ignore: DOM listeners still handle visibility changes when available.
        });
    } catch {
      // In non-Tauri environments, getCurrentWindow can throw.
    }
    updatePolling();
    return () => {
      didCleanup = true;
      if (unlistenWindowFocus) {
        unlistenWindowFocus();
      }
      if (unlistenWindowBlur) {
        unlistenWindowBlur();
      }
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      if (pollTimer) {
        clearInterval(pollTimer);
      }
    };
  }, [
    activeThreadId,
    activeThreadIsProcessing,
    backendMode,
    workspaceConnected,
    workspaceId,
  ]);
}
