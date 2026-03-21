import { describe, expect, it, vi } from "vitest";
import { handleCompanionRuntimeRpc, type RuntimeRpcContext } from "./codexRpcRuntime.js";
import type { StoredWorkspace } from "../types.js";

type ContextOverrides = Partial<RuntimeRpcContext>;

const workspace: StoredWorkspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/tmp/workspace",
  settings: {
    sidebarCollapsed: false,
  },
};

function createContext(overrides: ContextOverrides = {}): RuntimeRpcContext {
  const openSession = vi.fn().mockResolvedValue({ id: "term-1" });
  const writeSession = vi.fn().mockResolvedValue(undefined);
  const resizeSession = vi.fn().mockResolvedValue(undefined);
  const closeSession = vi.fn().mockResolvedValue(undefined);
  const terminalRuntime = {
    openSession,
    writeSession,
    resizeSession,
    closeSession,
  };

  return {
    terminalRuntime,
    getWorkspace: (workspaceId) => (workspaceId === "ws-1" ? workspace : null),
    getLocalUsageSnapshot: vi.fn().mockResolvedValue({ days: 7 }),
    runCodexDoctor: vi.fn().mockResolvedValue({ ok: true }),
    badRequest: (message) => ({ error: { status: 400, message } }),
    notFound: (message) => ({ error: { status: 404, message } }),
    ...overrides,
  };
}

describe("codexRpcRuntime", () => {
  it("delegates local usage snapshot with normalized args", async () => {
    const getLocalUsageSnapshot = vi.fn().mockResolvedValue({ ok: true });
    const context = createContext({ getLocalUsageSnapshot });

    const result = await handleCompanionRuntimeRpc(
      context,
      "local_usage_snapshot",
      { days: 14, workspacePath: " /tmp/workspace " },
    );

    expect(result).toEqual({ ok: true });
    expect(getLocalUsageSnapshot).toHaveBeenCalledWith(14, "/tmp/workspace");
  });

  it("delegates codex doctor", async () => {
    const runCodexDoctor = vi.fn().mockResolvedValue({ ok: true, version: "1.2.3" });
    const context = createContext({ runCodexDoctor });

    const result = await handleCompanionRuntimeRpc(
      context,
      "codex_doctor",
      { codexBin: "codex", codexArgs: "--profile web" },
    );

    expect(result).toEqual({ ok: true, version: "1.2.3" });
    expect(runCodexDoctor).toHaveBeenCalledWith("codex", "--profile web");
  });

  it("returns unsupported errors for non-web runtime methods", async () => {
    const context = createContext();

    const result = await handleCompanionRuntimeRpc(context, "menu_set_accelerators", {});

    expect(result).toEqual({
      error: {
        status: 400,
        message: "menu_set_accelerators is not supported in the web companion.",
      },
    });
  });

  it("handles terminal open", async () => {
    const context = createContext();

    const result = await handleCompanionRuntimeRpc(
      context,
      "terminal_open",
      { workspaceId: "ws-1", terminalId: "term-1", cols: 100, rows: 30 },
    );

    expect(result).toEqual({ id: "term-1" });
  });

  it("handles terminal write", async () => {
    const context = createContext();

    await expect(
      handleCompanionRuntimeRpc(
        context,
        "terminal_write",
        { workspaceId: "ws-1", terminalId: "term-1", data: "echo hi" },
      ),
    ).resolves.toBeNull();
  });

  it("returns notFound when terminal methods target an unknown workspace", async () => {
    const context = createContext({ getWorkspace: () => null });

    const result = await handleCompanionRuntimeRpc(
      context,
      "terminal_write",
      { workspaceId: "missing", terminalId: "term-1", data: "echo hi" },
    );

    expect(result).toEqual({
      error: {
        status: 404,
        message: "Workspace not found.",
      },
    });
  });

  it("returns undefined for methods it does not own", async () => {
    const context = createContext();

    const result = await handleCompanionRuntimeRpc(context, "ping", {});

    expect(result).toBeUndefined();
  });
});
