import { useCallback, useMemo, useRef, useState } from "react";
import type { ThreadCodexParams, ThreadSummary, WorkspaceInfo } from "@/types";
import {
  clearThreadCodexParams as clearThreadCodexParamsService,
  patchThreadCodexParams as patchThreadCodexParamsService,
  patchWorkspaceComposerDefaults as patchWorkspaceComposerDefaultsService,
} from "@services/tauri";
import { makeThreadCodexParamsKey } from "@threads/utils/threadStorage";

type ThreadCodexParamsPatch = Partial<
  Pick<
    ThreadCodexParams,
    | "modelId"
    | "effort"
    | "serviceTier"
    | "accessMode"
    | "collaborationModeId"
    | "codexArgsOverride"
  >
>;

type UseThreadCodexParamsParams = {
  noThreadScopeSuffix: string;
  onError?: (error: unknown, context: string) => void;
};

type UseThreadCodexParamsResult = {
  version: number;
  syncThreadCodexParamsFromBackend: (
    threadsByWorkspace: Record<string, ThreadSummary[]>,
    workspacesById: Map<string, WorkspaceInfo>,
  ) => void;
  getThreadCodexParams: (workspaceId: string, threadId: string) => ThreadCodexParams | null;
  patchThreadCodexParams: (
    workspaceId: string,
    threadId: string,
    patch: ThreadCodexParamsPatch,
  ) => void;
  deleteThreadCodexParams: (workspaceId: string, threadId: string) => void;
};

function buildThreadCodexParamsMap(options: {
  threadsByWorkspace: Record<string, ThreadSummary[]>;
  workspacesById: Map<string, WorkspaceInfo>;
  noThreadScopeSuffix: string;
}) {
  const next = new Map<string, ThreadCodexParams>();
  options.workspacesById.forEach((workspace, workspaceId) => {
    if (workspace?.settings.composerDefaults) {
      next.set(
        makeThreadCodexParamsKey(workspaceId, options.noThreadScopeSuffix),
        workspace.settings.composerDefaults,
      );
    }
  });
  Object.entries(options.threadsByWorkspace).forEach(([workspaceId, threads]) => {
    threads.forEach((thread) => {
      if (thread.codexParams) {
        next.set(makeThreadCodexParamsKey(workspaceId, thread.id), thread.codexParams);
      }
    });
  });
  return next;
}

export function useThreadCodexParams({
  noThreadScopeSuffix,
  onError,
}: UseThreadCodexParamsParams): UseThreadCodexParamsResult {
  const paramsRef = useRef<Map<string, ThreadCodexParams>>(new Map());
  const [version, setVersion] = useState(0);

  const syncThreadCodexParamsFromBackend = useCallback(
    (
      threadsByWorkspace: Record<string, ThreadSummary[]>,
      workspacesById: Map<string, WorkspaceInfo>,
    ) => {
      const next = buildThreadCodexParamsMap({
        threadsByWorkspace,
        workspacesById,
        noThreadScopeSuffix,
      });
      const previous = JSON.stringify(Array.from(paramsRef.current.entries()));
      const nextSerialized = JSON.stringify(Array.from(next.entries()));
      paramsRef.current = next;
      if (previous !== nextSerialized) {
        setVersion((value) => value + 1);
      }
    },
    [noThreadScopeSuffix],
  );

  const getThreadCodexParams = useCallback(
    (workspaceId: string, threadId: string): ThreadCodexParams | null =>
      paramsRef.current.get(makeThreadCodexParamsKey(workspaceId, threadId)) ?? null,
    [],
  );

  const patchThreadCodexParams = useCallback(
    (workspaceId: string, threadId: string, patch: ThreadCodexParamsPatch) => {
      const key = makeThreadCodexParamsKey(workspaceId, threadId);
      const current = paramsRef.current.get(key) ?? {
        modelId: null,
        effort: null,
        accessMode: null,
        collaborationModeId: null,
        updatedAt: 0,
      };
      const nextEntry: ThreadCodexParams = {
        ...current,
        ...patch,
        updatedAt: Date.now(),
      };
      const next = new Map(paramsRef.current);
      next.set(key, nextEntry);
      paramsRef.current = next;
      setVersion((value) => value + 1);
      const promise =
        threadId === noThreadScopeSuffix
          ? patchWorkspaceComposerDefaultsService(workspaceId, patch)
          : patchThreadCodexParamsService(workspaceId, threadId, patch);
      void promise.catch((error) => {
        onError?.(error, "patchThreadCodexParams");
      });
    },
    [noThreadScopeSuffix, onError],
  );

  const deleteThreadCodexParams = useCallback(
    (workspaceId: string, threadId: string) => {
      const key = makeThreadCodexParamsKey(workspaceId, threadId);
      if (!paramsRef.current.has(key)) {
        return;
      }
      const next = new Map(paramsRef.current);
      next.delete(key);
      paramsRef.current = next;
      setVersion((value) => value + 1);
      const promise =
        threadId === noThreadScopeSuffix
          ? patchWorkspaceComposerDefaultsService(workspaceId, {
              modelId: null,
              effort: null,
              serviceTier: undefined,
              accessMode: null,
              collaborationModeId: null,
              codexArgsOverride: undefined,
            })
          : clearThreadCodexParamsService(workspaceId, threadId);
      void promise.catch((error) => {
        onError?.(error, "deleteThreadCodexParams");
      });
    },
    [noThreadScopeSuffix, onError],
  );

  return useMemo(
    () => ({
      version,
      syncThreadCodexParamsFromBackend,
      getThreadCodexParams,
      patchThreadCodexParams,
      deleteThreadCodexParams,
    }),
    [
      deleteThreadCodexParams,
      getThreadCodexParams,
      patchThreadCodexParams,
      syncThreadCodexParamsFromBackend,
      version,
    ],
  );
}
