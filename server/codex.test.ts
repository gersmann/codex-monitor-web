import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAppServerUserInputItems, CodexCompanionServer } from "./codex.js";
import { CompanionStorage } from "./storage.js";
import type { StoredThread, StoredWorkspace } from "./types.js";

const tempDirs: string[] = [];

async function createServerFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-server-"));
  tempDirs.push(dir);
  const storage = new CompanionStorage(dir);
  const workspacePath = path.join(dir, "workspace");
  const workspace: StoredWorkspace = {
    id: "ws-1",
    name: "Workspace",
    path: workspacePath,
    settings: {
      sidebarCollapsed: false,
    },
  };
  const thread: StoredThread = {
    id: "thread-1",
    workspaceId: "ws-1",
    sdkThreadId: "sdk-thread-1",
    cwd: workspacePath,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    name: null,
    preview: "Thread One",
    activeTurnId: null,
    turns: [],
    modelId: null,
    effort: null,
    tokenUsage: null,
  };
  await storage.writeWorkspaces([workspace]);
  await storage.writeThreads([thread]);
  const server = new CodexCompanionServer(storage, () => {});
  await server.initialize();
  return { dir, storage, server, workspace, thread };
}

async function runGit(cwd: string, args: string[]) {
  return await new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve();
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildAppServerUserInputItems", () => {
  it("maps text, images, and mentions to app-server input items", () => {
    expect(
      buildAppServerUserInputItems("Ship it", ["/tmp/image.png", "https://example.com/a.png"], [
        { name: "Calendar", path: "app://calendar" },
      ]),
    ).toEqual([
      { type: "text", text: "Ship it", text_elements: [] },
      { type: "localImage", path: "/tmp/image.png" },
      { type: "image", url: "https://example.com/a.png" },
      { type: "mention", name: "Calendar", path: "app://calendar" },
    ]);
  });
});

describe("CodexCompanionServer phase 1 rpc support", () => {
  it("routes turn_steer through codex app-server", async () => {
    const { server } = await createServerFixture();
    const callCodexAppServer = vi.fn().mockResolvedValue({ turnId: "turn-2" });
    (server as unknown as { callCodexAppServer: typeof callCodexAppServer }).callCodexAppServer =
      callCodexAppServer;

    const result = await server.handleRpc("turn_steer", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      turnId: "turn-active",
      text: "Refine the patch",
      images: ["/tmp/image.png"],
      appMentions: [{ name: "Calendar", path: "app://calendar" }],
    });

    expect(callCodexAppServer).toHaveBeenCalledWith(
      "turn/steer",
      {
        threadId: "sdk-thread-1",
        expectedTurnId: "turn-active",
        input: [
          { type: "text", text: "Refine the patch", text_elements: [] },
          { type: "localImage", path: "/tmp/image.png" },
          { type: "mention", name: "Calendar", path: "app://calendar" },
        ],
      },
      {},
    );
    expect(result).toEqual({ turnId: "turn-2" });
  });

  it("imports a detached review thread after review/start", async () => {
    const { server, storage, workspace } = await createServerFixture();
    const callCodexAppServer = vi
      .fn()
      .mockImplementation(async (method: string) => {
        if (method === "review/start") {
          return {
            turn: { id: "turn-review", status: "active", items: [] },
            reviewThreadId: "sdk-review-1",
          };
        }
        if (method === "thread/resume") {
          return {
            thread: {
              id: "sdk-review-1",
              cwd: workspace.path,
              preview: "Review thread",
              createdAt: 10,
              updatedAt: 20,
              turns: [],
              status: "idle",
            },
          };
        }
        throw new Error(`unexpected method: ${method}`);
      });
    (server as unknown as { callCodexAppServer: typeof callCodexAppServer }).callCodexAppServer =
      callCodexAppServer;

    const result = await server.handleRpc("start_review", {
      workspaceId: "ws-1",
      threadId: "thread-1",
      target: { type: "custom", instructions: "Review this patch" },
      delivery: "detached",
    });

    expect(result).toEqual({
      turn: { id: "turn-review", status: "active", items: [] },
      reviewThreadId: "sdk-review-1",
    });
    const threads = await storage.readThreads();
    expect(threads.some((thread) => thread.id === "sdk-review-1")).toBe(true);
  });

  it("persists forked threads returned by thread/fork", async () => {
    const { server, storage, workspace } = await createServerFixture();
    const callCodexAppServer = vi.fn().mockResolvedValue({
      thread: {
        id: "sdk-fork-1",
        cwd: workspace.path,
        preview: "Forked thread",
        createdAt: 30,
        updatedAt: 40,
        turns: [],
        status: "idle",
      },
    });
    (server as unknown as { callCodexAppServer: typeof callCodexAppServer }).callCodexAppServer =
      callCodexAppServer;

    const result = await server.handleRpc("fork_thread", {
      workspaceId: "ws-1",
      threadId: "thread-1",
    });

    expect(result).toEqual({
      thread: {
        id: "sdk-fork-1",
        cwd: workspace.path,
        preview: "Forked thread",
        createdAt: 30,
        updatedAt: 40,
        turns: [],
        status: "idle",
      },
    });
    const threads = await storage.readThreads();
    expect(threads.some((thread) => thread.id === "sdk-fork-1")).toBe(true);
  });

  it("generates run metadata from a background codex prompt", async () => {
    const { server } = await createServerFixture();
    const buildCodex = vi.fn().mockReturnValue({
      startThread: vi.fn().mockReturnValue({
        run: vi.fn().mockResolvedValue({
          finalResponse:
            '{"title":"Fix Login Redirect Loop","worktreeName":"fix/login-redirect-loop"}',
        }),
      }),
    });
    (server as unknown as { buildCodex: typeof buildCodex }).buildCodex = buildCodex;

    const result = await server.handleRpc("generate_run_metadata", {
      workspaceId: "ws-1",
      prompt: "Fix the login redirect loop",
    });

    expect(result).toEqual({
      title: "Fix Login Redirect Loop",
      worktreeName: "fix/login-redirect-loop",
    });
  });
});

describe("CodexCompanionServer git/worktree support", () => {
  it("initializes a git repo after confirmation", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await fs.writeFile(path.join(workspace.path, "README.md"), "# Repo\n", "utf8");

    const preview = await server.handleRpc("init_git_repo", {
      workspaceId: "ws-1",
      branch: "main",
      force: false,
    });
    const result = await server.handleRpc("init_git_repo", {
      workspaceId: "ws-1",
      branch: "main",
      force: true,
    });

    expect(preview).toEqual({ status: "needs_confirmation", entryCount: 1 });
    expect(result).toMatchObject({ status: "initialized" });
    await expect(fs.stat(path.join(workspace.path, ".git"))).resolves.toBeTruthy();
  });

  it("returns git status and branch data for a workspace repo", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\nworld\n", "utf8");

    const status = await server.handleRpc("get_git_status", { workspaceId: "ws-1" });
    const branches = await server.handleRpc("list_git_branches", { workspaceId: "ws-1" });

    expect(status).toMatchObject({
      branchName: "main",
      totalAdditions: expect.any(Number),
      totalDeletions: expect.any(Number),
    });
    expect((status as { files: Array<{ path: string; status: string }> }).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", status: "M" }),
      ]),
    );
    expect(branches).toEqual({
      branches: expect.arrayContaining([
        expect.objectContaining({ name: "main", lastCommit: expect.any(Number) }),
      ]),
    });
  });

  it("tracks worktree setup markers", async () => {
    const { server, storage, workspace } = await createServerFixture();
    const worktreeWorkspace: StoredWorkspace = {
      ...workspace,
      id: "ws-worktree",
      kind: "worktree",
      worktree: { branch: "feat/test" },
      settings: {
        ...workspace.settings,
        worktreeSetupScript: "npm install",
      },
    };
    await storage.writeWorkspaces([workspace, worktreeWorkspace]);
    await server.initialize();

    const before = await server.handleRpc("worktree_setup_status", {
      workspaceId: "ws-worktree",
    });
    await server.handleRpc("worktree_setup_mark_ran", {
      workspaceId: "ws-worktree",
    });
    const after = await server.handleRpc("worktree_setup_status", {
      workspaceId: "ws-worktree",
    });

    expect(before).toEqual({ shouldRun: true, script: "npm install" });
    expect(after).toEqual({ shouldRun: false, script: "npm install" });
  });

  it("applies worktree changes back to the parent repo", async () => {
    const { dir, server, storage, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await runGit(workspace.path, ["branch", "feat/test"]);

    const worktreePath = path.join(dir, "worktree");
    await runGit(workspace.path, ["worktree", "add", worktreePath, "feat/test"]);
    await fs.writeFile(path.join(worktreePath, "tracked.txt"), "hello\nfrom worktree\n", "utf8");

    const worktreeWorkspace: StoredWorkspace = {
      ...workspace,
      id: "ws-worktree",
      path: worktreePath,
      kind: "worktree",
      parentId: workspace.id,
      worktree: { branch: "feat/test" },
    };
    await storage.writeWorkspaces([workspace, worktreeWorkspace]);
    await server.initialize();

    const result = await server.handleRpc("apply_worktree_changes", {
      workspaceId: "ws-worktree",
    });

    expect(result).toBeNull();
    await expect(fs.readFile(path.join(workspace.path, "tracked.txt"), "utf8")).resolves.toBe(
      "hello\nfrom worktree\n",
    );
  });
});
