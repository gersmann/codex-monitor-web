// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../../../types";
import { getGitStatus } from "../../../services/tauri";
import { useGitStatus } from "./useGitStatus";

vi.mock("../../../services/tauri", () => ({
  getGitStatus: vi.fn(),
}));

const workspace: WorkspaceInfo = {
  id: "workspace-1",
  name: "CodexMonitor",
  path: "/tmp/codex",
  connected: true,
  settings: { sidebarCollapsed: false },
};

const makeStatus = (branchName: string, additions = 0, deletions = 0) => ({
  branchName,
  files: [],
  stagedFiles: [],
  unstagedFiles: [],
  totalAdditions: additions,
  totalDeletions: deletions,
});

describe("useGitStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("polls on interval and updates status", async () => {
    const getGitStatusMock = vi.mocked(getGitStatus);
    getGitStatusMock
      .mockResolvedValueOnce(makeStatus("main", 2, 1))
      .mockResolvedValueOnce(makeStatus("next", 3, 4));

    const { result, unmount } = renderHook(
      ({ active }: { active: WorkspaceInfo | null }) => useGitStatus(active),
      { initialProps: { active: workspace } },
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(getGitStatusMock).toHaveBeenCalledTimes(1);
    expect(result.current.status.branchName).toBe("main");
    expect(result.current.status.totalAdditions).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getGitStatusMock).toHaveBeenCalledTimes(2);
    expect(result.current.status.branchName).toBe("next");
    expect(result.current.status.totalDeletions).toBe(4);

    unmount();
  });

  it("refresh triggers a new fetch", async () => {
    const getGitStatusMock = vi.mocked(getGitStatus);
    getGitStatusMock
      .mockResolvedValueOnce(makeStatus("main", 1, 0))
      .mockResolvedValueOnce(makeStatus("manual", 5, 6));

    const { result, unmount } = renderHook(
      ({ active }: { active: WorkspaceInfo | null }) => useGitStatus(active),
      { initialProps: { active: workspace } },
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.status.branchName).toBe("main");

    await act(async () => {
      await result.current.refresh();
    });

    expect(getGitStatusMock).toHaveBeenCalledTimes(2);
    expect(result.current.status.branchName).toBe("manual");
    expect(result.current.status.totalAdditions).toBe(5);

    unmount();
  });
});
