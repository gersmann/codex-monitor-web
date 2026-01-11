import { useCallback, useEffect, useMemo, useState } from "react";
import type { GitFileDiff, GitFileStatus, WorkspaceInfo } from "../types";
import { getGitDiffs } from "../services/tauri";

type GitDiffState = {
  diffs: GitFileDiff[];
  isLoading: boolean;
  error: string | null;
};

const emptyState: GitDiffState = {
  diffs: [],
  isLoading: false,
  error: null,
};

export function useGitDiffs(
  activeWorkspace: WorkspaceInfo | null,
  files: GitFileStatus[],
  enabled: boolean,
) {
  const [state, setState] = useState<GitDiffState>(emptyState);

  const fileKey = useMemo(
    () =>
      files
        .map(
          (file) =>
            `${file.path}:${file.status}:${file.additions}:${file.deletions}`,
        )
        .sort()
        .join("|"),
    [files],
  );

  const refresh = useCallback(async () => {
    if (!activeWorkspace) {
      setState(emptyState);
      return;
    }
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const diffs = await getGitDiffs(activeWorkspace.id);
      setState({ diffs, isLoading: false, error: null });
    } catch (error) {
      console.error("Failed to load git diffs", error);
      setState({
        diffs: [],
        isLoading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [activeWorkspace]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refresh();
  }, [enabled, fileKey, refresh]);

  const orderedDiffs = useMemo(() => {
    const diffByPath = new Map(
      state.diffs.map((entry) => [entry.path, entry.diff]),
    );
    return files.map((file) => ({
      path: file.path,
      status: file.status,
      diff: diffByPath.get(file.path) ?? "",
    }));
  }, [files, state.diffs]);

  return {
    diffs: orderedDiffs,
    isLoading: state.isLoading,
    error: state.error,
    refresh,
  };
}
