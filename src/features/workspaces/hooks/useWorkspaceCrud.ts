import { useCallback } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import * as Sentry from "@sentry/react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import type {
  AppSettings,
  DebugEntry,
  WorkspaceInfo,
  WorkspaceSettings,
} from "../../../types";
import { isMobilePlatform } from "../../../utils/platformPaths";
import {
  addWorkspace as addWorkspaceService,
  addWorkspaceFromGitUrl as addWorkspaceFromGitUrlService,
  connectWorkspace as connectWorkspaceService,
  isWorkspacePathDir as isWorkspacePathDirService,
  listWorkspaces,
  pickWorkspacePaths,
  removeWorkspace as removeWorkspaceService,
  updateWorkspaceCodexBin as updateWorkspaceCodexBinService,
  updateWorkspaceSettings as updateWorkspaceSettingsService,
} from "../../../services/tauri";

type UseWorkspaceCrudOptions = {
  appSettings?: AppSettings;
  defaultCodexBin?: string | null;
  onDebug?: (entry: DebugEntry) => void;
  workspaces: WorkspaceInfo[];
  setWorkspaces: Dispatch<SetStateAction<WorkspaceInfo[]>>;
  setActiveWorkspaceId: Dispatch<SetStateAction<string | null>>;
  workspaceSettingsRef: MutableRefObject<Map<string, WorkspaceSettings>>;
  setHasLoaded: Dispatch<SetStateAction<boolean>>;
};

function normalizeWorkspacePathKey(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function parseWorkspacePathInput(value: string) {
  return value
    .split(/\r?\n|,|;/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function promptWorkspacePathsForMobileRemote(): string[] {
  if (typeof window === "undefined" || typeof window.prompt !== "function") {
    return [];
  }
  const input = window.prompt(
    "Enter one or more project paths on the connected server.\nUse one path per line (or comma-separated).",
  );
  if (!input) {
    return [];
  }
  return parseWorkspacePathInput(input);
}

export function useWorkspaceCrud({
  appSettings,
  defaultCodexBin,
  onDebug,
  workspaces,
  setWorkspaces,
  setActiveWorkspaceId,
  workspaceSettingsRef,
  setHasLoaded,
}: UseWorkspaceCrudOptions) {
  const refreshWorkspaces = useCallback(async () => {
    try {
      const entries = await listWorkspaces();
      setWorkspaces(entries);
      setActiveWorkspaceId((prev) => {
        if (!prev) {
          return prev;
        }
        return entries.some((entry) => entry.id === prev) ? prev : null;
      });
      setHasLoaded(true);
      return entries;
    } catch (err) {
      console.error("Failed to load workspaces", err);
      setHasLoaded(true);
      return undefined;
    }
  }, [setActiveWorkspaceId, setHasLoaded, setWorkspaces]);

  const addWorkspaceFromPath = useCallback(
    async (path: string, options?: { activate?: boolean }) => {
      const selection = path.trim();
      if (!selection) {
        return null;
      }
      const shouldActivate = options?.activate !== false;
      onDebug?.({
        id: `${Date.now()}-client-add-workspace`,
        timestamp: Date.now(),
        source: "client",
        label: "workspace/add",
        payload: { path: selection },
      });
      try {
        const workspace = await addWorkspaceService(selection, defaultCodexBin ?? null);
        setWorkspaces((prev) => [...prev, workspace]);
        if (shouldActivate) {
          setActiveWorkspaceId(workspace.id);
        }
        Sentry.metrics.count("workspace_added", 1, {
          attributes: {
            workspace_id: workspace.id,
            workspace_kind: workspace.kind ?? "main",
          },
        });
        return workspace;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-add-workspace-error`,
          timestamp: Date.now(),
          source: "error",
          label: "workspace/add error",
          payload: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [defaultCodexBin, onDebug, setActiveWorkspaceId, setWorkspaces],
  );

  const addWorkspaceFromGitUrl = useCallback(
    async (
      url: string,
      destinationPath: string,
      targetFolderName?: string | null,
      options?: { activate?: boolean },
    ) => {
      const trimmedUrl = url.trim();
      const trimmedDestination = destinationPath.trim();
      const trimmedFolderName = targetFolderName?.trim() || null;
      if (!trimmedUrl) {
        throw new Error("Remote Git URL is required.");
      }
      if (!trimmedDestination) {
        throw new Error("Destination folder is required.");
      }
      const shouldActivate = options?.activate !== false;
      onDebug?.({
        id: `${Date.now()}-client-add-workspace-from-url`,
        timestamp: Date.now(),
        source: "client",
        label: "workspace/add-from-url",
        payload: {
          url: trimmedUrl,
          destinationPath: trimmedDestination,
          targetFolderName: trimmedFolderName,
        },
      });
      try {
        const workspace = await addWorkspaceFromGitUrlService(
          trimmedUrl,
          trimmedDestination,
          trimmedFolderName,
          defaultCodexBin ?? null,
        );
        setWorkspaces((prev) => [...prev, workspace]);
        if (shouldActivate) {
          setActiveWorkspaceId(workspace.id);
        }
        return workspace;
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-add-workspace-from-url-error`,
          timestamp: Date.now(),
          source: "error",
          label: "workspace/add-from-url error",
          payload: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [defaultCodexBin, onDebug, setActiveWorkspaceId, setWorkspaces],
  );

  const addWorkspacesFromPaths = useCallback(
    async (paths: string[]) => {
      const existingPaths = new Set(
        workspaces.map((entry) => normalizeWorkspacePathKey(entry.path)),
      );
      const skippedExisting: string[] = [];
      const skippedInvalid: string[] = [];
      const failures: { path: string; message: string }[] = [];
      const added: WorkspaceInfo[] = [];

      const seenSelections = new Set<string>();
      const selections = paths
        .map((path) => path.trim())
        .filter(Boolean)
        .filter((path) => {
          const key = normalizeWorkspacePathKey(path);
          if (seenSelections.has(key)) {
            return false;
          }
          seenSelections.add(key);
          return true;
        });

      for (const selection of selections) {
        const key = normalizeWorkspacePathKey(selection);
        if (existingPaths.has(key)) {
          skippedExisting.push(selection);
          continue;
        }

        let isDir = false;
        try {
          isDir = await isWorkspacePathDirService(selection);
        } catch (error) {
          failures.push({
            path: selection,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        if (!isDir) {
          skippedInvalid.push(selection);
          continue;
        }

        try {
          const workspace = await addWorkspaceFromPath(selection, {
            activate: added.length === 0,
          });
          if (workspace) {
            added.push(workspace);
            existingPaths.add(key);
          }
        } catch (error) {
          failures.push({
            path: selection,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const hasIssues =
        skippedExisting.length > 0 || skippedInvalid.length > 0 || failures.length > 0;
      if (hasIssues) {
        const lines: string[] = [];
        lines.push(`Added ${added.length} workspace${added.length === 1 ? "" : "s"}.`);
        if (skippedExisting.length > 0) {
          lines.push(
            `Skipped ${skippedExisting.length} already added workspace${
              skippedExisting.length === 1 ? "" : "s"
            }.`,
          );
        }
        if (skippedInvalid.length > 0) {
          lines.push(
            `Skipped ${skippedInvalid.length} invalid path${
              skippedInvalid.length === 1 ? "" : "s"
            } (not a folder).`,
          );
        }
        if (failures.length > 0) {
          lines.push(
            `Failed to add ${failures.length} workspace${
              failures.length === 1 ? "" : "s"
            }.`,
          );
          const details = failures
            .slice(0, 3)
            .map(({ path, message }) => `- ${path}: ${message}`);
          if (failures.length > 3) {
            details.push(`- …and ${failures.length - 3} more`);
          }
          lines.push("");
          lines.push("Failures:");
          lines.push(...details);
        }

        const summary = lines.join("\n");
        const title =
          failures.length > 0 ? "Some workspaces failed to add" : "Some workspaces were skipped";
        void message(summary, {
          title,
          kind: failures.length > 0 ? "error" : "warning",
        });
      }

      return added[0] ?? null;
    },
    [addWorkspaceFromPath, workspaces],
  );

  const addWorkspace = useCallback(async () => {
    if (isMobilePlatform() && appSettings?.backendMode === "remote") {
      const manualPaths = promptWorkspacePathsForMobileRemote();
      if (manualPaths.length === 0) {
        return null;
      }
      return addWorkspacesFromPaths(manualPaths);
    }

    const selection = await pickWorkspacePaths();
    if (selection.length === 0) {
      return null;
    }
    return addWorkspacesFromPaths(selection);
  }, [addWorkspacesFromPaths, appSettings?.backendMode]);

  const filterWorkspacePaths = useCallback(async (paths: string[]) => {
    const trimmed = paths.map((path) => path.trim()).filter(Boolean);
    if (trimmed.length === 0) {
      return [];
    }
    const checks = await Promise.all(
      trimmed.map(async (path) => ({
        path,
        isDir: await isWorkspacePathDirService(path),
      })),
    );
    return checks.filter((entry) => entry.isDir).map((entry) => entry.path);
  }, []);

  const connectWorkspace = useCallback(
    async (entry: WorkspaceInfo) => {
      onDebug?.({
        id: `${Date.now()}-client-connect-workspace`,
        timestamp: Date.now(),
        source: "client",
        label: "workspace/connect",
        payload: { workspaceId: entry.id, path: entry.path },
      });
      try {
        await connectWorkspaceService(entry.id);
        setWorkspaces((prev) =>
          prev.map((workspace) =>
            workspace.id === entry.id
              ? { ...workspace, connected: true }
              : workspace,
          ),
        );
      } catch (error) {
        onDebug?.({
          id: `${Date.now()}-client-connect-workspace-error`,
          timestamp: Date.now(),
          source: "error",
          label: "workspace/connect error",
          payload: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [onDebug, setWorkspaces],
  );

  const markWorkspaceConnected = useCallback(
    (id: string) => {
      setWorkspaces((prev) =>
        prev.map((entry) => (entry.id === id ? { ...entry, connected: true } : entry)),
      );
    },
    [setWorkspaces],
  );

  const updateWorkspaceSettings = useCallback(
    async (workspaceId: string, patch: Partial<WorkspaceSettings>) => {
      onDebug?.({
        id: `${Date.now()}-client-update-workspace-settings`,
        timestamp: Date.now(),
        source: "client",
        label: "workspace/settings",
        payload: { workspaceId, patch },
      });
      const currentWorkspace = workspaces.find((entry) => entry.id === workspaceId) ?? null;
      const currentSettings =
        workspaceSettingsRef.current.get(workspaceId) ?? currentWorkspace?.settings ?? null;
      if (!currentWorkspace || !currentSettings) {
        throw new Error("workspace not found");
      }
      const previousSettings = currentSettings;
      const nextSettings = { ...currentSettings, ...patch };
      workspaceSettingsRef.current.set(workspaceId, nextSettings);
      setWorkspaces((prev) =>
        prev.map((entry) => {
          if (entry.id !== workspaceId) {
            return entry;
          }
          return { ...entry, settings: nextSettings };
        }),
      );
      try {
        const updated = await updateWorkspaceSettingsService(workspaceId, nextSettings);
        workspaceSettingsRef.current.set(workspaceId, updated.settings);
        setWorkspaces((prev) =>
          prev.map((entry) => (entry.id === workspaceId ? updated : entry)),
        );
        return updated;
      } catch (error) {
        workspaceSettingsRef.current.set(workspaceId, previousSettings);
        setWorkspaces((prev) =>
          prev.map((entry) =>
            entry.id === workspaceId
              ? { ...entry, settings: previousSettings }
              : entry,
          ),
        );
        onDebug?.({
          id: `${Date.now()}-client-update-workspace-settings-error`,
          timestamp: Date.now(),
          source: "error",
          label: "workspace/settings error",
          payload: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [onDebug, setWorkspaces, workspaces, workspaceSettingsRef],
  );

  const updateWorkspaceCodexBin = useCallback(
    async (workspaceId: string, codexBin: string | null) => {
      onDebug?.({
        id: `${Date.now()}-client-update-workspace-codex-bin`,
        timestamp: Date.now(),
        source: "client",
        label: "workspace/codexBin",
        payload: { workspaceId, codexBin },
      });
      const previous = workspaces.find((entry) => entry.id === workspaceId) ?? null;
      if (previous) {
        setWorkspaces((prev) =>
          prev.map((entry) =>
            entry.id === workspaceId ? { ...entry, codex_bin: codexBin } : entry,
          ),
        );
      }
      try {
        const updated = await updateWorkspaceCodexBinService(workspaceId, codexBin);
        setWorkspaces((prev) =>
          prev.map((entry) => (entry.id === workspaceId ? updated : entry)),
        );
        return updated;
      } catch (error) {
        if (previous) {
          setWorkspaces((prev) =>
            prev.map((entry) => (entry.id === workspaceId ? previous : entry)),
          );
        }
        onDebug?.({
          id: `${Date.now()}-client-update-workspace-codex-bin-error`,
          timestamp: Date.now(),
          source: "error",
          label: "workspace/codexBin error",
          payload: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    [onDebug, setWorkspaces, workspaces],
  );

  const removeWorkspace = useCallback(
    async (workspaceId: string) => {
      const workspace = workspaces.find((entry) => entry.id === workspaceId);
      const workspaceName = workspace?.name || "this workspace";
      const worktreeCount = workspaces.filter(
        (entry) => entry.parentId === workspaceId,
      ).length;
      const childIds = new Set(
        workspaces
          .filter((entry) => entry.parentId === workspaceId)
          .map((entry) => entry.id),
      );
      const detail =
        worktreeCount > 0
          ? `\n\nThis will also delete ${worktreeCount} worktree${
              worktreeCount === 1 ? "" : "s"
            } on disk.`
          : "";

      const confirmed = await ask(
        `Are you sure you want to delete "${workspaceName}"?\n\nThis will remove the workspace from CodexMonitor.${detail}`,
        {
          title: "Delete Workspace",
          kind: "warning",
          okLabel: "Delete",
          cancelLabel: "Cancel",
        },
      );

      if (!confirmed) {
        return;
      }

      onDebug?.({
        id: `${Date.now()}-client-remove-workspace`,
        timestamp: Date.now(),
        source: "client",
        label: "workspace/remove",
        payload: { workspaceId },
      });
      try {
        await removeWorkspaceService(workspaceId);
        setWorkspaces((prev) =>
          prev.filter(
            (entry) =>
              entry.id !== workspaceId && entry.parentId !== workspaceId,
          ),
        );
        setActiveWorkspaceId((prev) =>
          prev && (prev === workspaceId || childIds.has(prev)) ? null : prev,
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        onDebug?.({
          id: `${Date.now()}-client-remove-workspace-error`,
          timestamp: Date.now(),
          source: "error",
          label: "workspace/remove error",
          payload: errorMessage,
        });
        void message(errorMessage, {
          title: "Delete workspace failed",
          kind: "error",
        });
      }
    },
    [onDebug, setActiveWorkspaceId, setWorkspaces, workspaces],
  );

  return {
    addWorkspace,
    addWorkspaceFromPath,
    addWorkspaceFromGitUrl,
    addWorkspacesFromPaths,
    connectWorkspace,
    filterWorkspacePaths,
    markWorkspaceConnected,
    refreshWorkspaces,
    removeWorkspace,
    updateWorkspaceCodexBin,
    updateWorkspaceSettings,
  };
}
