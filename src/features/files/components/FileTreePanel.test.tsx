// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileTreePanel } from "./FileTreePanel";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [
      { index: 0, key: "row-0", start: 0 },
      { index: 1, key: "row-1", start: 28 },
    ],
    getTotalSize: () => 56,
    measureElement: () => undefined,
  }),
}));

vi.mock("../../../services/runtime", () => ({
  isWebCompanionRuntime: () => true,
}));

describe("FileTreePanel", () => {
  it("opens a web popover menu for file rows and copies the project-relative path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const onFilePanelModeChange = vi.fn();
    const onInsertText = vi.fn();
    const onSelectOpenAppId = vi.fn();

    render(
      <FileTreePanel
        workspaceId="ws-1"
        workspacePath="/tmp/workspace"
        files={["src/sample.ts"]}
        modifiedFiles={[]}
        isLoading={false}
        filePanelMode="files"
        onFilePanelModeChange={onFilePanelModeChange}
        onInsertText={onInsertText}
        canInsertText
        openTargets={[]}
        openAppIconById={{}}
        selectedOpenAppId=""
        onSelectOpenAppId={onSelectOpenAppId}
      />,
    );

    await act(async () => {
      fireEvent.contextMenu(screen.getByRole("button", { name: "sample.ts" }), {
        clientX: 48,
        clientY: 64,
      });
    });

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to chat" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /show in/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy file path" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy file path" }));
    });

    expect(writeText).toHaveBeenCalledWith("src/sample.ts");
  });
});
