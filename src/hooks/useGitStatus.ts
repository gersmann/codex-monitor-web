import { useEffect, useState } from "react";
import type { GitFileStatus, WorkspaceInfo } from "../types";
import { getGitStatus } from "../services/tauri";

type GitStatusState = {
  branchName: string;
  files: GitFileStatus[];
  totalAdditions: number;
  totalDeletions: number;
  error: string | null;
};

const emptyStatus: GitStatusState = {
  branchName: "",
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  error: null,
};

export function useGitStatus(activeWorkspace: WorkspaceInfo | null) {
  const [status, setStatus] = useState<GitStatusState>(emptyStatus);

  useEffect(() => {
    if (!activeWorkspace) {
      setStatus(emptyStatus);
      return;
    }

    getGitStatus(activeWorkspace.id)
      .then((data) => setStatus({ ...data, error: null }))
      .catch((err) => {
        console.error("Failed to load git status", err);
        setStatus({
          ...emptyStatus,
          branchName: "unknown",
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [activeWorkspace]);

  return status;
}
