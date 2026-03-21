// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useThreadStorage } from "./useThreadStorage";

describe("useThreadStorage", () => {
  it("derives pinned threads and custom names from backend thread summaries", () => {
    const { result } = renderHook(() =>
      useThreadStorage({
        threadsByWorkspace: {
          "ws-1": [
            {
              id: "thread-1",
              name: "Custom",
              storedName: "Custom",
              updatedAt: 101,
              pinnedAt: 202,
            },
          ],
        },
      }),
    );

    expect(result.current.getCustomName("ws-1", "thread-1")).toBe("Custom");
    expect(result.current.isThreadPinned("ws-1", "thread-1")).toBe(true);
    expect(result.current.getPinTimestamp("ws-1", "thread-1")).toBe(202);
    expect(result.current.threadActivityRef.current).toEqual({
      "ws-1": { "thread-1": 101 },
    });
  });

  it("records thread activity in memory", () => {
    const { result } = renderHook(() =>
      useThreadStorage({
        threadsByWorkspace: {},
      }),
    );

    act(() => {
      result.current.recordThreadActivity("ws-2", "thread-9", 999);
    });

    expect(result.current.threadActivityRef.current).toEqual({
      "ws-2": { "thread-9": 999 },
    });
  });

  it("bumps pinned version when backend pin state changes", () => {
    const { result, rerender } = renderHook(
      ({ threadsByWorkspace }: { threadsByWorkspace: Parameters<typeof useThreadStorage>[0]["threadsByWorkspace"] }) =>
        useThreadStorage({ threadsByWorkspace }),
      {
        initialProps: {
          threadsByWorkspace: {},
        },
      },
    );

    const versionBefore = result.current.pinnedThreadsVersion;

    rerender({
      threadsByWorkspace: {
        "ws-1": [
          {
            id: "thread-2",
            name: "Pinned",
            updatedAt: 1,
            pinnedAt: 456,
          },
        ],
      },
    });

    expect(result.current.pinnedThreadsVersion).toBeGreaterThan(versionBefore);
    expect(result.current.isThreadPinned("ws-1", "thread-2")).toBe(true);
  });
});
