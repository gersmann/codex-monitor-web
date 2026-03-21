import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { ThreadSummary } from "@/types";
import {
  type CustomNamesMap,
  type PinnedThreadsMap,
  type ThreadActivityMap,
  makeCustomNameKey,
  makePinKey,
} from "@threads/utils/threadStorage";

type UseThreadStorageResult = {
  customNamesRef: MutableRefObject<CustomNamesMap>;
  pinnedThreadsRef: MutableRefObject<PinnedThreadsMap>;
  threadActivityRef: MutableRefObject<ThreadActivityMap>;
  pinnedThreadsVersion: number;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  recordThreadActivity: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  getPinTimestamp: (workspaceId: string, threadId: string) => number | null;
};

type UseThreadStorageParams = {
  threadsByWorkspace: Record<string, ThreadSummary[]>;
};

export function useThreadStorage({
  threadsByWorkspace,
}: UseThreadStorageParams): UseThreadStorageResult {
  const derived = useMemo(() => {
    const nextCustomNames: CustomNamesMap = {};
    const nextPinnedThreads: PinnedThreadsMap = {};
    const nextThreadActivity: ThreadActivityMap = {};

    Object.entries(threadsByWorkspace).forEach(([workspaceId, threads]) => {
      const activityForWorkspace: Record<string, number> = {};
      threads.forEach((thread) => {
        if (thread.storedName?.trim()) {
          nextCustomNames[makeCustomNameKey(workspaceId, thread.id)] = thread.storedName;
        }
        if (typeof thread.pinnedAt === "number") {
          nextPinnedThreads[makePinKey(workspaceId, thread.id)] = thread.pinnedAt;
        }
        activityForWorkspace[thread.id] = thread.updatedAt;
      });
      nextThreadActivity[workspaceId] = activityForWorkspace;
    });

    return {
      customNames: nextCustomNames,
      pinnedThreads: nextPinnedThreads,
      threadActivity: nextThreadActivity,
    };
  }, [threadsByWorkspace]);

  const threadActivityRef = useRef<ThreadActivityMap>(derived.threadActivity);
  const pinnedThreadsRef = useRef<PinnedThreadsMap>(derived.pinnedThreads);
  const [pinnedThreadsVersion, setPinnedThreadsVersion] = useState(0);
  const customNamesRef = useRef<CustomNamesMap>(derived.customNames);

  useEffect(() => {
    customNamesRef.current = derived.customNames;
  }, [derived.customNames]);

  const getCustomName = useCallback((workspaceId: string, threadId: string) => {
    const key = makeCustomNameKey(workspaceId, threadId);
    return customNamesRef.current[key];
  }, []);

  const recordThreadActivity = useCallback(
    (workspaceId: string, threadId: string, timestamp = Date.now()) => {
      const nextForWorkspace = {
        ...(threadActivityRef.current[workspaceId] ?? {}),
        [threadId]: timestamp,
      };
      const next = {
        ...threadActivityRef.current,
        [workspaceId]: nextForWorkspace,
      };
      threadActivityRef.current = next;
    },
    [],
  );

  useEffect(() => {
    const previous = pinnedThreadsRef.current;
    pinnedThreadsRef.current = derived.pinnedThreads;
    threadActivityRef.current = {
      ...derived.threadActivity,
      ...threadActivityRef.current,
    };
    if (JSON.stringify(previous) !== JSON.stringify(derived.pinnedThreads)) {
      setPinnedThreadsVersion((version) => version + 1);
    }
  }, [derived.pinnedThreads, derived.threadActivity]);

  const isThreadPinned = useCallback(
    (workspaceId: string, threadId: string): boolean => {
      const key = makePinKey(workspaceId, threadId);
      return key in pinnedThreadsRef.current;
    },
    [],
  );

  const getPinTimestamp = useCallback(
    (workspaceId: string, threadId: string): number | null => {
      const key = makePinKey(workspaceId, threadId);
      return pinnedThreadsRef.current[key] ?? null;
    },
    [],
  );

  return {
    customNamesRef,
    pinnedThreadsRef,
    threadActivityRef,
    pinnedThreadsVersion,
    getCustomName,
    recordThreadActivity,
    isThreadPinned,
    getPinTimestamp,
  };
}
