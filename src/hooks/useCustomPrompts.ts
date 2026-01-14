import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CustomPromptOption, DebugEntry, WorkspaceInfo } from "../types";
import { getPromptsList } from "../services/tauri";

type UseCustomPromptsOptions = {
  activeWorkspace: WorkspaceInfo | null;
  onDebug?: (entry: DebugEntry) => void;
};

export function useCustomPrompts({ activeWorkspace, onDebug }: UseCustomPromptsOptions) {
  const [prompts, setPrompts] = useState<CustomPromptOption[]>([]);
  const lastFetchedWorkspaceId = useRef<string | null>(null);
  const inFlight = useRef(false);

  const workspaceId = activeWorkspace?.id ?? null;
  const isConnected = Boolean(activeWorkspace?.connected);

  const refreshPrompts = useCallback(async () => {
    if (!workspaceId || !isConnected) {
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    onDebug?.({
      id: `${Date.now()}-client-prompts-list`,
      timestamp: Date.now(),
      source: "client",
      label: "prompts/list",
      payload: { workspaceId },
    });
    try {
      const response = await getPromptsList(workspaceId);
      onDebug?.({
        id: `${Date.now()}-server-prompts-list`,
        timestamp: Date.now(),
        source: "server",
        label: "prompts/list response",
        payload: response,
      });
      const rawPrompts = Array.isArray(response)
        ? response
        : Array.isArray((response as any)?.prompts)
          ? (response as any).prompts
          : Array.isArray((response as any)?.result?.prompts)
            ? (response as any).result.prompts
            : Array.isArray((response as any)?.result)
              ? (response as any).result
              : [];
      const data: CustomPromptOption[] = rawPrompts.map((item: any) => ({
        name: String(item.name ?? ""),
        path: String(item.path ?? ""),
        description: item.description ? String(item.description) : undefined,
        argumentHint: item.argumentHint
          ? String(item.argumentHint)
          : item.argument_hint
            ? String(item.argument_hint)
            : undefined,
        content: String(item.content ?? ""),
      }));
      setPrompts(data);
      lastFetchedWorkspaceId.current = workspaceId;
    } catch (error) {
      onDebug?.({
        id: `${Date.now()}-client-prompts-list-error`,
        timestamp: Date.now(),
        source: "error",
        label: "prompts/list error",
        payload: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight.current = false;
    }
  }, [isConnected, onDebug, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !isConnected) {
      return;
    }
    if (lastFetchedWorkspaceId.current === workspaceId) {
      return;
    }
    refreshPrompts();
  }, [isConnected, refreshPrompts, workspaceId]);

  const promptOptions = useMemo(
    () => prompts.filter((prompt) => prompt.name),
    [prompts],
  );

  return {
    prompts: promptOptions,
    refreshPrompts,
  };
}
