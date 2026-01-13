import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { confirm, message } from "@tauri-apps/plugin-dialog";
import type { DebugEntry } from "../types";

type UseUpdaterOptions = {
  enabled?: boolean;
  onDebug?: (entry: DebugEntry) => void;
};

export function useUpdater({ enabled = true, onDebug }: UseUpdaterOptions) {
  useEffect(() => {
    if (!enabled || import.meta.env.DEV || !isTauri()) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      let update: Awaited<ReturnType<typeof check>> | null = null;
      try {
        update = await check();
        if (!update || cancelled) {
          return;
        }

        const shouldUpdate = await confirm(
          `A new version (${update.version}) is available. Update now?`,
          {
            title: "CodexMonitor",
            okLabel: "Update",
            cancelLabel: "Later",
          },
        );
        if (!shouldUpdate || cancelled) {
          return;
        }

        await update.downloadAndInstall();
        if (cancelled) {
          return;
        }
        await message("Update installed. Restarting CodexMonitor.", {
          title: "CodexMonitor",
        });
        await relaunch();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : JSON.stringify(error);
        onDebug?.({
          id: `${Date.now()}-client-updater-error`,
          timestamp: Date.now(),
          source: "error",
          label: "updater/error",
          payload: message,
        });
      } finally {
        await update?.close();
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [enabled, onDebug]);
}
