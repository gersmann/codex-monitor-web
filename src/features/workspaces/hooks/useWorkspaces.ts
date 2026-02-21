import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  DebugEntry,
  WorkspaceInfo,
  WorkspaceSettings,
} from "../../../types";
import {
  RESERVED_GROUP_NAME,
  buildGroupedWorkspaces,
  buildWorkspaceById,
  buildWorkspaceGroupById,
  getWorkspaceGroupNameById,
  sortWorkspaceGroups,
} from "../domain/workspaceGroups";
import { useWorkspaceCrud } from "./useWorkspaceCrud";
import { useWorkspaceGroupOps } from "./useWorkspaceGroupOps";
import { useWorktreeOps } from "./useWorktreeOps";

export type UseWorkspacesOptions = {
  onDebug?: (entry: DebugEntry) => void;
  defaultCodexBin?: string | null;
  appSettings?: AppSettings;
  onUpdateAppSettings?: (next: AppSettings) => Promise<AppSettings>;
};

export function useWorkspaces(options: UseWorkspacesOptions = {}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const workspaceSettingsRef = useRef<Map<string, WorkspaceSettings>>(new Map());
  const { onDebug, defaultCodexBin, appSettings, onUpdateAppSettings } = options;

  const {
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
  } = useWorkspaceCrud({
    appSettings,
    defaultCodexBin,
    onDebug,
    workspaces,
    setWorkspaces,
    setActiveWorkspaceId,
    workspaceSettingsRef,
    setHasLoaded,
  });

  useEffect(() => {
    void refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(() => {
    const next = new Map<string, WorkspaceSettings>();
    workspaces.forEach((entry) => {
      next.set(entry.id, entry.settings);
    });
    workspaceSettingsRef.current = next;
  }, [workspaces]);

  const activeWorkspace = useMemo(
    () => workspaces.find((entry) => entry.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );

  const workspaceById = useMemo(() => buildWorkspaceById(workspaces), [workspaces]);

  const workspaceGroups = useMemo(
    () => sortWorkspaceGroups(appSettings?.workspaceGroups ?? []),
    [appSettings?.workspaceGroups],
  );

  const workspaceGroupById = useMemo(
    () => buildWorkspaceGroupById(workspaceGroups),
    [workspaceGroups],
  );

  const groupedWorkspaces = useMemo(
    () => buildGroupedWorkspaces(workspaces, workspaceGroups),
    [workspaceGroups, workspaces],
  );

  const getWorkspaceGroupName = useCallback(
    (workspaceId: string) =>
      getWorkspaceGroupNameById(workspaceId, workspaceById, workspaceGroupById),
    [workspaceById, workspaceGroupById],
  );

  const {
    addCloneAgent,
    addWorktreeAgent,
    deletingWorktreeIds,
    removeWorktree,
    renameWorktree,
    renameWorktreeUpstream,
  } = useWorktreeOps({
    onDebug,
    workspaces,
    setWorkspaces,
    setActiveWorkspaceId,
  });

  const {
    assignWorkspaceGroup,
    createWorkspaceGroup,
    deleteWorkspaceGroup,
    moveWorkspaceGroup,
    renameWorkspaceGroup,
  } = useWorkspaceGroupOps({
    appSettings,
    onUpdateAppSettings,
    workspaceGroups,
    workspaceGroupById,
    workspaces,
    updateWorkspaceSettings,
  });

  return {
    workspaces,
    workspaceGroups,
    groupedWorkspaces,
    getWorkspaceGroupName,
    ungroupedLabel: RESERVED_GROUP_NAME,
    activeWorkspace,
    activeWorkspaceId,
    setActiveWorkspaceId,
    addWorkspace,
    addWorkspaceFromPath,
    addWorkspaceFromGitUrl,
    addWorkspacesFromPaths,
    filterWorkspacePaths,
    addCloneAgent,
    addWorktreeAgent,
    connectWorkspace,
    markWorkspaceConnected,
    updateWorkspaceSettings,
    updateWorkspaceCodexBin,
    createWorkspaceGroup,
    renameWorkspaceGroup,
    moveWorkspaceGroup,
    deleteWorkspaceGroup,
    assignWorkspaceGroup,
    removeWorkspace,
    removeWorktree,
    renameWorktree,
    renameWorktreeUpstream,
    deletingWorktreeIds,
    hasLoaded,
    refreshWorkspaces,
  };
}
