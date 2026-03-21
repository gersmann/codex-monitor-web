import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleScopedFileRpc, handleWorkspaceFileRpc } from "./codexFileRpc.js";
import type { StoredWorkspace } from "../types.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-file-rpc-"));
  tempDirs.push(dir);
  return dir;
}

function createWorkspace(workspacePath: string): StoredWorkspace {
  return {
    id: "ws-1",
    name: "Workspace",
    path: workspacePath,
    settings: {
      sidebarCollapsed: false,
    },
  };
}

function createContext(workspacePath: string) {
  const workspace = createWorkspace(workspacePath);
  const globalAgentsPath = path.join(workspacePath, "global", "agents.toml");
  const globalConfigPath = path.join(workspacePath, "global", "config.toml");
  const workspaceAgentsPath = path.join(workspacePath, "workspace", "agents.toml");
  const workspaceConfigPath = path.join(workspacePath, "workspace", "config.toml");

  return {
    storage: {
      globalAgentsPath: () => globalAgentsPath,
      globalConfigPath: () => globalConfigPath,
      readTextFile: async (filePath: string) => ({
        content: await fs.readFile(filePath, "utf8"),
        truncated: false,
      }),
      writeTextFile: async (filePath: string, content: string) => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
      },
      workspaceAgentsPath: () => workspaceAgentsPath,
      workspaceConfigPath: () => workspaceConfigPath,
    },
    getWorkspace: (workspaceId: string) => (workspaceId === workspace.id ? workspace : null),
    notFound: (message: string) => ({ error: { status: 404, message } }),
    badRequest: (message: string) => ({ error: { status: 400, message } }),
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("codexFileRpc", () => {
  it("reads and writes scoped files for workspace and global paths", async () => {
    const root = await makeTempDir();
    const context = createContext(root);

    await expect(
      handleScopedFileRpc(context, "file_write", {
        scope: "workspace",
        kind: "config",
        workspaceId: "ws-1",
        content: "workspace config",
      }),
    ).resolves.toBeNull();
    await expect(
      handleScopedFileRpc(context, "file_write", {
        scope: "global",
        kind: "agents",
        workspaceId: "ws-1",
        content: "global agents",
      }),
    ).resolves.toBeNull();

    await expect(
      handleScopedFileRpc(context, "file_read", {
        scope: "workspace",
        kind: "config",
        workspaceId: "ws-1",
      }),
    ).resolves.toEqual({
      content: "workspace config",
      truncated: false,
    });
    await expect(
      handleScopedFileRpc(context, "file_read", {
        scope: "global",
        kind: "agents",
        workspaceId: "ws-1",
      }),
    ).resolves.toEqual({
      content: "global agents",
      truncated: false,
    });
  });

  it("reads workspace files and rejects invalid workspace paths", async () => {
    const root = await makeTempDir();
    const context = createContext(root);
    await fs.writeFile(path.join(root, "notes.txt"), "hello", "utf8");
    await fs.writeFile(path.join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await expect(
      handleWorkspaceFileRpc(context, "list_workspace_files", { workspaceId: "ws-1" }),
    ).resolves.toEqual(["image.png", "notes.txt"]);
    await expect(
      handleWorkspaceFileRpc(context, "read_workspace_file", {
        workspaceId: "ws-1",
        path: "notes.txt",
      }),
    ).resolves.toEqual({
      content: "hello",
      truncated: false,
    });
    await expect(
      handleWorkspaceFileRpc(context, "read_image_as_data_url", {
        workspaceId: "ws-1",
        path: "image.png",
      }),
    ).resolves.toMatch(/^data:image\/png;base64,/);
    await expect(
      handleWorkspaceFileRpc(context, "read_image_as_data_url", {
        workspaceId: "ws-1",
        path: "../outside.png",
      }),
    ).resolves.toEqual({
      error: {
        status: 400,
        message: "Invalid workspace file path.",
      },
    });
  });

  it("returns not found for unsupported scoped file kinds", async () => {
    const root = await makeTempDir();
    const context = createContext(root);

    await expect(
      handleScopedFileRpc(context, "file_read", {
        scope: "workspace",
        kind: "unknown",
        workspaceId: "ws-1",
      }),
    ).resolves.toEqual({
      error: {
        status: 404,
        message: "Unsupported file scope or kind.",
      },
    });
  });
});
