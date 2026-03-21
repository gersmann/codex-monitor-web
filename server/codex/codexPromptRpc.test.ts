import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { handlePromptRpc, type PromptRpcContext } from "./codexPromptRpc.js";
import type { StoredWorkspace } from "../types.js";

type TestContext = PromptRpcContext & {
  rootDir: string;
};

const workspace: StoredWorkspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/tmp/workspace",
  settings: {
    sidebarCollapsed: false,
  },
};

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createContext(): Promise<TestContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-prompt-rpc-"));
  createdRoots.push(rootDir);
  return {
    rootDir,
    storage: {
      workspacePromptsDir: (workspaceId) => path.join(rootDir, "workspaces", workspaceId, "prompts"),
      globalPromptsDir: () => path.join(rootDir, "global", "prompts"),
    },
    getWorkspace: (workspaceId) => (workspaceId === workspace.id ? workspace : null),
    badRequest: (message) => ({ error: { status: 400, message } }),
    notFound: (message) => ({ error: { status: 404, message } }),
    mapPathValidationError: (error) => ({
      error: {
        status:
          error instanceof Error && error.message === "Workspace not found."
            ? 404
            : 400,
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  };
}

describe("codexPromptRpc", () => {
  it("lists workspace and global prompts with parsed frontmatter", async () => {
    const context = await createContext();
    const workspaceDir = context.storage.workspacePromptsDir(workspace.id);
    const globalDir = context.storage.globalPromptsDir();
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "alpha.md"),
      [
        "---",
        'description: "Alpha description"',
        'argument-hint: "alpha hint"',
        "---",
        "Workspace body",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(globalDir, "beta.md"), "Global body\n", "utf8");

    const result = await handlePromptRpc(context, "prompts_list", {
      workspaceId: workspace.id,
    });

    expect(result).toEqual([
      {
        name: "alpha",
        path: path.join(workspaceDir, "alpha.md"),
        description: "Alpha description",
        argumentHint: "alpha hint",
        content: "Workspace body\n",
        scope: "workspace",
      },
      {
        name: "beta",
        path: path.join(globalDir, "beta.md"),
        description: null,
        argumentHint: null,
        content: "Global body\n",
        scope: "global",
      },
    ]);
  });

  it("creates, updates, moves, and deletes prompts", async () => {
    const context = await createContext();
    const workspaceDir = context.storage.workspacePromptsDir(workspace.id);
    const globalDir = context.storage.globalPromptsDir();
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });

    const created = await handlePromptRpc(context, "prompts_create", {
      workspaceId: workspace.id,
      scope: "workspace",
      name: "demo",
      description: "Demo description",
      argumentHint: "demo hint",
      content: "Initial body",
    });
    const promptPath = path.join(workspaceDir, "demo.md");

    expect(created).toEqual({
      name: "demo",
      path: promptPath,
      description: "Demo description",
      argumentHint: "demo hint",
      content: "Initial body",
      scope: "workspace",
    });

    const updated = await handlePromptRpc(context, "prompts_update", {
      workspaceId: workspace.id,
      path: promptPath,
      name: "renamed",
      description: "Renamed description",
      argumentHint: null,
      content: "Updated body",
    });
    const renamedPath = path.join(workspaceDir, "renamed.md");

    expect(updated).toEqual({
      name: "renamed",
      path: renamedPath,
      description: "Renamed description",
      argumentHint: null,
      content: "Updated body",
      scope: "workspace",
    });
    await expect(fs.readFile(renamedPath, "utf8")).resolves.toContain("Updated body");

    const moved = await handlePromptRpc(context, "prompts_move", {
      workspaceId: workspace.id,
      path: renamedPath,
      scope: "global",
    });
    const movedPath = path.join(globalDir, "renamed.md");

    expect(moved).toEqual({
      name: "renamed",
      path: movedPath,
      description: "Renamed description",
      argumentHint: null,
      content: "Updated body\n",
      scope: "global",
    });

    const deleted = await handlePromptRpc(context, "prompts_delete", {
      workspaceId: workspace.id,
      path: movedPath,
    });

    expect(deleted).toBeNull();
    await expect(fs.stat(movedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns typed errors for missing workspaces and unknown methods", async () => {
    const context = await createContext();

    const missingWorkspace = await handlePromptRpc(context, "prompts_workspace_dir", {
      workspaceId: "missing",
    });
    expect(missingWorkspace).toEqual({
      error: { status: 404, message: "Workspace not found." },
    });

    const unknown = await handlePromptRpc(context, "unknown_prompt_method", {});
    expect(unknown).toBeUndefined();
  });
});
