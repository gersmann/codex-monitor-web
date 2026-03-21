import { describe, expect, it, vi } from "vitest";
import {
  handleGitRpc,
  handleGitBranchRpc,
  handleGitHubRpc,
  handleGitWorkingTreeRpc,
  type GitRpcContext,
} from "./codexGitRpc.js";
import type { StoredWorkspace } from "../types.js";

const workspace: StoredWorkspace = {
  id: "ws-1",
  name: "Workspace",
  path: "/tmp/workspace",
  settings: {
    sidebarCollapsed: false,
  },
};

function createContext(overrides: Partial<GitRpcContext> = {}): GitRpcContext {
  return {
    getWorkspace: (workspaceId) => (workspaceId === "ws-1" ? workspace : null),
    trimString: (value) => (typeof value === "string" ? value.trim() : ""),
    notFound: (message) => ({ error: { status: 404, message } }),
    badRequest: (message) => ({ error: { status: 400, message } }),
    rpcBoundaryError: (error) => ({
      error: {
        status: 500,
        message: error instanceof Error ? error.message : String(error),
      },
    }),
    initializeGitRepo: vi.fn().mockResolvedValue({ status: "initialized" }),
    createGitHubRepo: vi.fn().mockResolvedValue({ status: "ok", repo: "openai/codex", remoteUrl: "origin" }),
    runGit: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    runGitCommit: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    tryRunGit: vi.fn().mockResolvedValue(null),
    resolveGitRootFromPath: vi.fn().mockResolvedValue("/tmp/workspace"),
    listLocalGitBranches: vi.fn().mockResolvedValue([{ name: "main", lastCommit: 1 }]),
    getGitHubIssues: vi.fn().mockResolvedValue({ total: 0, issues: [] }),
    getGitHubPullRequests: vi.fn().mockResolvedValue({ total: 0, pullRequests: [] }),
    getGitHubPullRequestDiff: vi.fn().mockResolvedValue([{ path: "a.ts", status: "M", diff: "diff" }]),
    getGitHubPullRequestComments: vi.fn().mockResolvedValue([]),
    checkoutGitHubPullRequest: vi.fn().mockResolvedValue(undefined),
    buildGitStatusSummary: vi.fn().mockResolvedValue({
      repoRoot: "/tmp/workspace",
      branchName: "main",
      files: [],
      stagedFiles: [],
      unstagedFiles: [],
      totalAdditions: 0,
      totalDeletions: 0,
    }),
    scanGitRoots: vi.fn().mockResolvedValue(["/tmp/workspace"]),
    buildWorkingTreeDiffs: vi.fn().mockResolvedValue([]),
    getGitLogSummary: vi.fn().mockResolvedValue({ total: 0, entries: [] }),
    getCommitDiffEntries: vi.fn().mockResolvedValue([]),
    getPreferredRemote: vi.fn().mockResolvedValue("origin"),
    ...overrides,
  };
}

describe("codexGitRpc", () => {
  it("returns undefined for methods it does not own", async () => {
    const context = createContext();

    await expect(handleGitBranchRpc(context, "ping", {})).resolves.toBeUndefined();
    await expect(handleGitHubRpc(context, "ping", {})).resolves.toBeUndefined();
    await expect(handleGitWorkingTreeRpc(context, "ping", {})).resolves.toBeUndefined();
  });

  it("rejects missing github pull request numbers before delegation", async () => {
    const context = createContext();

    await expect(
      handleGitHubRpc(context, "get_github_pull_request_diff", { workspaceId: "ws-1" }),
    ).resolves.toEqual({
      error: {
        status: 400,
        message: "prNumber is required.",
      },
    });

    expect(context.getGitHubPullRequestDiff).not.toHaveBeenCalled();
  });

  it("stages only visible tracked paths for stage_git_all", async () => {
    const runGit = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const buildGitStatusSummary = vi.fn().mockResolvedValue({
      repoRoot: "/tmp/workspace",
      branchName: "main",
      files: [
        { path: "src/a.ts", status: "M", additions: 1, deletions: 0 },
        { path: "src/a.ts", status: "M", additions: 1, deletions: 0 },
        { path: "", status: "M", additions: 0, deletions: 0 },
        { path: "src/b.ts", status: "A", additions: 2, deletions: 0 },
      ],
      stagedFiles: [],
      unstagedFiles: [],
      totalAdditions: 3,
      totalDeletions: 0,
    });
    const context = createContext({
      runGit,
      buildGitStatusSummary,
    });

    await expect(
      handleGitWorkingTreeRpc(context, "stage_git_all", { workspaceId: "ws-1" }),
    ).resolves.toBeNull();

    expect(runGit).toHaveBeenCalledWith("/tmp/workspace", ["add", "-A", "--", "src/a.ts", "src/b.ts"]);
  });

  it("routes init_git_repo through the unified git dispatcher", async () => {
    const initializeGitRepo = vi.fn().mockResolvedValue({ status: "initialized" });
    const context = createContext({ initializeGitRepo });

    await expect(
      handleGitRpc(context, "init_git_repo", {
        workspaceId: "ws-1",
        branch: "main",
        force: true,
      }),
    ).resolves.toEqual({ status: "initialized" });

    expect(initializeGitRepo).toHaveBeenCalledWith("/tmp/workspace", "main", true);
  });

  it("routes create_github_repo through the unified git dispatcher", async () => {
    const createGitHubRepo = vi.fn().mockResolvedValue({
      status: "ok",
      repo: "openai/codex",
      remoteUrl: "git@github.com:openai/codex.git",
    });
    const context = createContext({ createGitHubRepo });

    await expect(
      handleGitRpc(context, "create_github_repo", {
        workspaceId: "ws-1",
        repo: "openai/codex",
        visibility: "public",
        branch: "main",
      }),
    ).resolves.toEqual({
      status: "ok",
      repo: "openai/codex",
      remoteUrl: "git@github.com:openai/codex.git",
    });

    expect(createGitHubRepo).toHaveBeenCalledWith(
      "/tmp/workspace",
      "openai/codex",
      "public",
      "main",
    );
  });
});
