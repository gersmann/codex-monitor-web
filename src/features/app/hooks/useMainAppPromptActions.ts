import { useCallback } from "react";
import type { SendMessageResult, WorkspaceInfo } from "@/types";

type PromptPayload = {
  scope: "workspace" | "global";
  name: string;
  description?: string | null;
  argumentHint?: string | null;
  content: string;
};

type PromptUpdatePayload = {
  path: string;
  name: string;
  description?: string | null;
  argumentHint?: string | null;
  content: string;
};

type UseMainAppPromptActionsArgs = {
  activeWorkspace: WorkspaceInfo | null;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  startThreadForWorkspace: (
    workspaceId: string,
    options?: { activate?: boolean },
  ) => Promise<string | null>;
  sendUserMessageToThread: (
    workspace: WorkspaceInfo,
    threadId: string,
    text: string,
    images?: string[],
  ) => Promise<void | SendMessageResult>;
  createPrompt: (data: PromptPayload) => Promise<void>;
  updatePrompt: (data: PromptUpdatePayload) => Promise<void>;
  deletePrompt: (path: string) => Promise<void>;
  movePrompt: (data: { path: string; scope: "workspace" | "global" }) => Promise<void>;
  getWorkspacePromptsDir: () => Promise<string>;
  getGlobalPromptsDir: () => Promise<string | null>;
  alertError: (error: unknown) => void;
};

export function useMainAppPromptActions({
  activeWorkspace,
  connectWorkspace,
  startThreadForWorkspace,
  sendUserMessageToThread,
  createPrompt,
  updatePrompt,
  deletePrompt,
  movePrompt,
  getWorkspacePromptsDir,
  getGlobalPromptsDir,
  alertError,
}: UseMainAppPromptActionsArgs) {
  const handleCreatePrompt = useCallback(
    async (data: PromptPayload) => {
      try {
        await createPrompt(data);
      } catch (error) {
        alertError(error);
      }
    },
    [alertError, createPrompt],
  );

  const handleUpdatePrompt = useCallback(
    async (data: PromptUpdatePayload) => {
      try {
        await updatePrompt(data);
      } catch (error) {
        alertError(error);
      }
    },
    [alertError, updatePrompt],
  );

  const handleDeletePrompt = useCallback(
    async (path: string) => {
      try {
        await deletePrompt(path);
      } catch (error) {
        alertError(error);
      }
    },
    [alertError, deletePrompt],
  );

  const handleMovePrompt = useCallback(
    async (data: { path: string; scope: "workspace" | "global" }) => {
      try {
        await movePrompt(data);
      } catch (error) {
        alertError(error);
      }
    },
    [alertError, movePrompt],
  );

  const handleRevealWorkspacePrompts = useCallback(async () => {
    try {
      const path = await getWorkspacePromptsDir();
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    } catch (error) {
      alertError(error);
    }
  }, [alertError, getWorkspacePromptsDir]);

  const handleRevealGeneralPrompts = useCallback(async () => {
    try {
      const path = await getGlobalPromptsDir();
      if (!path) {
        return;
      }
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    } catch (error) {
      alertError(error);
    }
  }, [alertError, getGlobalPromptsDir]);

  const handleSendPromptToNewAgent = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!activeWorkspace || !trimmed) {
        return;
      }
      if (!activeWorkspace.connected) {
        await connectWorkspace(activeWorkspace);
      }
      const threadId = await startThreadForWorkspace(activeWorkspace.id, {
        activate: false,
      });
      if (!threadId) {
        return;
      }
      await sendUserMessageToThread(activeWorkspace, threadId, trimmed, []);
    },
    [activeWorkspace, connectWorkspace, sendUserMessageToThread, startThreadForWorkspace],
  );

  return {
    handleCreatePrompt,
    handleUpdatePrompt,
    handleDeletePrompt,
    handleMovePrompt,
    handleRevealWorkspacePrompts,
    handleRevealGeneralPrompts,
    handleSendPromptToNewAgent,
  };
}
