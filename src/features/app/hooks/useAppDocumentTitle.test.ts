import { describe, expect, it } from "vitest";
import { buildAppDocumentTitle } from "./useAppDocumentTitle";
import type { WorkspaceInfo } from "@/types";

function buildWorkspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    id: "ws-1",
    name: "Alpha Project",
    path: "/tmp/alpha",
    connected: true,
    kind: "main",
    settings: {
      sidebarCollapsed: false,
    },
    ...overrides,
  };
}

describe("buildAppDocumentTitle", () => {
  it("uses the app title when no workspace is active", () => {
    expect(buildAppDocumentTitle(null)).toBe("Codex Monitor Web");
  });

  it("includes the active workspace name in the document title", () => {
    expect(buildAppDocumentTitle(buildWorkspace())).toBe(
      "Alpha Project · Codex Monitor Web",
    );
  });

  it("falls back to the app title when the workspace name is blank", () => {
    expect(buildAppDocumentTitle(buildWorkspace({ name: "   " }))).toBe(
      "Codex Monitor Web",
    );
  });
});

