// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadCodexParams } from "./useThreadCodexParams";

const patchThreadCodexParamsMock = vi.fn();
const clearThreadCodexParamsMock = vi.fn();
const patchWorkspaceComposerDefaultsMock = vi.fn();

vi.mock("@services/tauri", () => ({
  patchThreadCodexParams: (...args: unknown[]) => patchThreadCodexParamsMock(...args),
  clearThreadCodexParams: (...args: unknown[]) => clearThreadCodexParamsMock(...args),
  patchWorkspaceComposerDefaults: (...args: unknown[]) =>
    patchWorkspaceComposerDefaultsMock(...args),
}));

describe("useThreadCodexParams", () => {
  beforeEach(() => {
    patchThreadCodexParamsMock.mockReset().mockResolvedValue({});
    clearThreadCodexParamsMock.mockReset().mockResolvedValue(undefined);
    patchWorkspaceComposerDefaultsMock.mockReset().mockResolvedValue({});
  });

  it("syncs thread-scoped params from backend thread summaries", () => {
    const { result } = renderHook(() =>
      useThreadCodexParams({
        noThreadScopeSuffix: "__no_thread__",
      }),
    );

    act(() => {
      result.current.syncThreadCodexParamsFromBackend(
        {
          "ws-1": [
            {
              id: "thread-1",
              name: "Thread 1",
              updatedAt: 1,
              codexParams: {
                modelId: "gpt-5.1",
                effort: "high",
                serviceTier: "fast",
                accessMode: "full-access",
                collaborationModeId: "plan",
                codexArgsOverride: "--profile dev",
                updatedAt: 10,
              },
            },
          ],
        },
        new Map(),
      );
    });

    expect(result.current.getThreadCodexParams("ws-1", "thread-1")).toEqual({
      modelId: "gpt-5.1",
      effort: "high",
      serviceTier: "fast",
      accessMode: "full-access",
      collaborationModeId: "plan",
      codexArgsOverride: "--profile dev",
      updatedAt: 10,
    });
  });

  it("syncs workspace-home defaults from backend workspace settings", () => {
    const { result } = renderHook(() =>
      useThreadCodexParams({
        noThreadScopeSuffix: "__no_thread__",
      }),
    );

    act(() => {
      result.current.syncThreadCodexParamsFromBackend(
        {},
        new Map([
          [
            "ws-1",
            {
              id: "ws-1",
              name: "Workspace",
              path: "/tmp/ws-1",
              connected: true,
              settings: {
                sidebarCollapsed: false,
                composerDefaults: {
                  modelId: null,
                  effort: null,
                  serviceTier: "fast",
                  accessMode: "current",
                  collaborationModeId: null,
                  codexArgsOverride: "--profile ws",
                  updatedAt: 5,
                },
              },
            },
          ],
        ]),
      );
    });

    expect(result.current.getThreadCodexParams("ws-1", "__no_thread__")).toEqual({
      modelId: null,
      effort: null,
      serviceTier: "fast",
      accessMode: "current",
      collaborationModeId: null,
      codexArgsOverride: "--profile ws",
      updatedAt: 5,
    });
  });

  it("patches per-thread params optimistically and forwards to backend", () => {
    const { result } = renderHook(() =>
      useThreadCodexParams({
        noThreadScopeSuffix: "__no_thread__",
      }),
    );

    act(() => {
      result.current.patchThreadCodexParams("ws-1", "thread-2", {
        modelId: "gpt-5",
        codexArgsOverride: undefined,
      });
    });

    expect(result.current.getThreadCodexParams("ws-1", "thread-2")).toEqual(
      expect.objectContaining({
        modelId: "gpt-5",
      }),
    );
    expect(
      result.current.getThreadCodexParams("ws-1", "thread-2")?.codexArgsOverride,
    ).toBeUndefined();
    expect(patchThreadCodexParamsMock).toHaveBeenCalledWith("ws-1", "thread-2", {
      modelId: "gpt-5",
      codexArgsOverride: undefined,
    });
  });

  it("patches workspace-home defaults through the workspace RPC", () => {
    const { result } = renderHook(() =>
      useThreadCodexParams({
        noThreadScopeSuffix: "__no_thread__",
      }),
    );

    act(() => {
      result.current.patchThreadCodexParams("ws-1", "__no_thread__", {
        serviceTier: "fast",
      });
    });

    expect(patchWorkspaceComposerDefaultsMock).toHaveBeenCalledWith("ws-1", {
      serviceTier: "fast",
    });
  });

  it("clears per-thread overrides", () => {
    const { result } = renderHook(() =>
      useThreadCodexParams({
        noThreadScopeSuffix: "__no_thread__",
      }),
    );

    act(() => {
      result.current.patchThreadCodexParams("ws-1", "thread-3", {
        modelId: "gpt-5",
      });
    });

    act(() => {
      result.current.deleteThreadCodexParams("ws-1", "thread-3");
    });

    expect(result.current.getThreadCodexParams("ws-1", "thread-3")).toBeNull();
    expect(clearThreadCodexParamsMock).toHaveBeenCalledWith("ws-1", "thread-3");
  });
});
