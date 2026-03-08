// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWorkspaceIn } from "../../../services/tauri";
import { useFileLinkOpener } from "./useFileLinkOpener";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

vi.mock("../../../services/tauri", () => ({
  openWorkspaceIn: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

vi.mock("@sentry/react", () => ({
  captureException: vi.fn(),
}));

vi.mock("../../../services/toasts", () => ({
  pushErrorToast: vi.fn(),
}));

describe("useFileLinkOpener", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens a managed web menu for file links and copies the resolved file URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
    });

    const { result } = renderHook(() =>
      useFileLinkOpener("/Users/me/CodexMonitor", [], ""),
    );

    await act(async () => {
      await result.current.showFileLinkMenu(
        {
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          clientX: 32,
          clientY: 48,
        } as unknown as React.MouseEvent,
        "/workspace/src/App.tsx:12:3",
      );
    });

    expect(result.current.fileLinkMenu).toMatchObject({
      rawPath: "/workspace/src/App.tsx:12:3",
      resolvedPath: "/Users/me/CodexMonitor/src/App.tsx",
      line: 12,
      column: 3,
    });
    expect(result.current.fileLinkMenuOpenLabel).toBe("Open in Visual Studio Code");

    await act(async () => {
      await result.current.copyLinkedFileLink();
    });

    expect(writeText).toHaveBeenCalledWith(
      "file:///Users/me/CodexMonitor/src/App.tsx#L12C3",
    );
    expect(result.current.fileLinkMenu).toBeNull();
  });

  it("reveals the linked file from the managed web menu", async () => {
    const { result } = renderHook(() =>
      useFileLinkOpener("/Users/me/CodexMonitor", [], ""),
    );

    await act(async () => {
      await result.current.showFileLinkMenu(
        {
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          clientX: 32,
          clientY: 48,
        } as unknown as React.MouseEvent,
        "/workspace/src/App.tsx",
      );
    });

    await act(async () => {
      await result.current.revealLinkedFile();
    });

    expect(vi.mocked(revealItemInDir)).toHaveBeenCalledWith(
      "/Users/me/CodexMonitor/src/App.tsx",
    );
  });

  it("maps /workspace root-relative paths to the active workspace path", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink("/workspace/src/features/messages/components/Markdown.tsx");
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor/src/features/messages/components/Markdown.tsx",
      expect.objectContaining({ appName: "Visual Studio Code", args: [] }),
    );
  });

  it("maps /workspace/<workspace-name>/... paths to the active workspace path", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink("/workspace/CodexMonitor/LICENSE");
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor/LICENSE",
      expect.objectContaining({ appName: "Visual Studio Code", args: [] }),
    );
  });

  it("maps nested /workspaces/.../<workspace-name>/... paths to the active workspace path", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink("/workspaces/team/CodexMonitor/src");
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor/src",
      expect.objectContaining({ appName: "Visual Studio Code", args: [] }),
    );
  });

  it("preserves file link line and column metadata for editor opens", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink(
        "/workspace/src/features/messages/components/Markdown.tsx:33:7",
      );
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor/src/features/messages/components/Markdown.tsx",
      expect.objectContaining({
        appName: "Visual Studio Code",
        args: [],
        line: 33,
        column: 7,
      }),
    );
  });

  it("parses #L line anchors before opening the editor", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink("/workspace/src/App.tsx#L33");
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor/src/App.tsx",
      expect.objectContaining({
        appName: "Visual Studio Code",
        args: [],
        line: 33,
      }),
    );
  });

  it("normalizes line ranges to the starting line before opening the editor", async () => {
    const workspacePath = "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor";
    const openWorkspaceInMock = vi.mocked(openWorkspaceIn);
    const { result } = renderHook(() => useFileLinkOpener(workspacePath, [], ""));

    await act(async () => {
      await result.current.openFileLink(
        "/workspace/src/features/messages/components/Markdown.tsx:366-369",
      );
    });

    expect(openWorkspaceInMock).toHaveBeenCalledWith(
      "/Users/sotiriskaniras/Documents/Development/Forks/CodexMonitor/src/features/messages/components/Markdown.tsx",
      expect.objectContaining({
        appName: "Visual Studio Code",
        args: [],
        line: 366,
      }),
    );
  });
});
