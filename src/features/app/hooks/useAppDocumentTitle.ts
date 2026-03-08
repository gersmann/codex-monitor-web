import { useEffect } from "react";
import type { WorkspaceInfo } from "@/types";

const APP_TITLE = "Codex Monitor Web";

export function buildAppDocumentTitle(activeWorkspace: WorkspaceInfo | null) {
  const workspaceName = activeWorkspace?.name?.trim();
  if (!workspaceName) {
    return APP_TITLE;
  }
  return `${workspaceName} · ${APP_TITLE}`;
}

export function useAppDocumentTitle(activeWorkspace: WorkspaceInfo | null) {
  useEffect(() => {
    document.title = buildAppDocumentTitle(activeWorkspace);
  }, [activeWorkspace]);
}
