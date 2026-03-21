import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupServerTestFixtures,
  createServerFixture,
  installFakeGh,
  readGitStdout,
  runGit,
} from "./serverTestUtils.js";
import type { StoredWorkspace } from "../types.js";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupServerTestFixtures();
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

  it("returns null for get_git_remote when a repo has no configured remotes", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);

    const remote = await server.handleRpc("get_git_remote", { workspaceId: "ws-1" });

    expect(remote).toBeNull();
  });

  it("returns badRequest for get_git_remote when workspace path is not a git repo", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });

    const result = await server.handleRpc("get_git_remote", { workspaceId: "ws-1" });

    expect(result).toEqual({
      error: {
        status: 400,
        message: expect.stringContaining("not a git repository"),
      },
    });
  });

  it("expands untracked directories into file entries in git status and diffs", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await fs.mkdir(path.join(workspace.path, "untracked-dir"), { recursive: true });
    await fs.writeFile(path.join(workspace.path, "untracked-dir", "nested.txt"), "nested\n", "utf8");
    await fs.writeFile(path.join(workspace.path, "loose.txt"), "loose\n", "utf8");

    const status = await server.handleRpc("get_git_status", { workspaceId: "ws-1" });
    const diffs = await server.handleRpc("get_git_diffs", { workspaceId: "ws-1" });

    expect((status as { files: Array<{ path: string }> }).files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "loose.txt" }),
        expect.objectContaining({ path: "untracked-dir/nested.txt" }),
      ]),
    );
    expect((status as { files: Array<{ path: string }> }).files).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "untracked-dir/" })]),
    );
    expect(diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "loose.txt" }),
        expect.objectContaining({ path: "untracked-dir/nested.txt" }),
      ]),
    );
  });

  it("stages files from expanded untracked directories when stage_git_all runs", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\nworld\n", "utf8");
    await fs.mkdir(path.join(workspace.path, "untracked-dir"), { recursive: true });
    await fs.writeFile(path.join(workspace.path, "untracked-dir", "nested.txt"), "nested\n", "utf8");
    await fs.writeFile(path.join(workspace.path, "loose.txt"), "loose\n", "utf8");

    await server.handleRpc("stage_git_all", { workspaceId: "ws-1" });

    const status = await server.handleRpc("get_git_status", { workspaceId: "ws-1" });
    expect((status as { stagedFiles: Array<{ path: string }> }).stagedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt" }),
        expect.objectContaining({ path: "loose.txt" }),
        expect.objectContaining({ path: "untracked-dir/nested.txt" }),
      ]),
    );

    const cachedNames = (await readGitStdout(
      workspace.path,
      ["diff", "--cached", "--name-only", "--"],
    ))
      .split(/\r?\n/)
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    expect(cachedNames).toEqual(
      expect.arrayContaining(["tracked.txt", "loose.txt", "untracked-dir/nested.txt"]),
    );
  });

  it("times out a hanging pre-commit hook instead of hanging commit_git forever", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\nworld\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await fs.mkdir(path.join(workspace.path, ".git", "hooks"), { recursive: true });
    await fs.writeFile(
      path.join(workspace.path, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nsleep 1\n",
      "utf8",
    );
    await fs.chmod(path.join(workspace.path, ".git", "hooks", "pre-commit"), 0o755);
    vi.stubEnv("CODEX_MONITOR_GIT_COMMIT_TIMEOUT_MS", "100");

    await expect(
      server.handleRpc("commit_git", {
        workspaceId: "ws-1",
        message: "feat: test timeout",
      }),
    ).resolves.toMatchObject({
      error: {
        status: 400,
        message: expect.stringMatching(/timed out/i),
      },
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

  it("returns GitHub issues and pull requests through gh", async () => {
    const { dir, server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["remote", "add", "origin", "git@github.com:openai/codex.git"]);
    await installFakeGh(
      dir,
      `
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ number: 12, title: "Bug", url: "https://github.com/openai/codex/issues/12", updatedAt: "2026-03-08T12:00:00Z" }]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ number: 34, title: "Fix", url: "https://github.com/openai/codex/pull/34", updatedAt: "2026-03-08T12:00:00Z", createdAt: "2026-03-07T12:00:00Z", body: "Body", headRefName: "feature", baseRefName: "main", isDraft: false, author: { login: "octocat" } }]));
  process.exit(0);
}
if (args[0] === "api" && args[1].includes("is:issue")) {
  process.stdout.write("23\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1].includes("is:pr")) {
  process.stdout.write("45\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + JSON.stringify(args));
process.exit(1);
`,
    );

    const issues = await server.handleRpc("get_github_issues", { workspaceId: "ws-1" });
    const pullRequests = await server.handleRpc("get_github_pull_requests", { workspaceId: "ws-1" });

    expect(issues).toEqual({
      total: 23,
      issues: [
        {
          number: 12,
          title: "Bug",
          url: "https://github.com/openai/codex/issues/12",
          updatedAt: "2026-03-08T12:00:00Z",
        },
      ],
    });
    expect(pullRequests).toEqual({
      total: 45,
      pullRequests: [
        {
          number: 34,
          title: "Fix",
          url: "https://github.com/openai/codex/pull/34",
          updatedAt: "2026-03-08T12:00:00Z",
          createdAt: "2026-03-07T12:00:00Z",
          body: "Body",
          headRefName: "feature",
          baseRefName: "main",
          isDraft: false,
          author: { login: "octocat" },
        },
      ],
    });
  });

  it("returns GitHub pull request diffs, comments, and supports checkout", async () => {
    const { dir, server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["remote", "add", "origin", "https://github.com/openai/codex.git"]);
    await installFakeGh(
      dir,
      `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "diff") {
  process.stdout.write([
    "diff --git a/old.txt b/new.txt",
    "similarity index 100%",
    "rename from old.txt",
    "rename to new.txt",
    "--- a/old.txt",
    "+++ b/new.txt",
    "@@ -1 +1 @@",
    "-before",
    "+after",
  ].join("\\n"));
  process.exit(0);
}
if (args[0] === "api" && args[1].includes("/issues/7/comments")) {
  process.stdout.write(JSON.stringify([{ id: 99, body: "Looks good", createdAt: "2026-03-08T12:00:00Z", url: "https://github.com/openai/codex/pull/7#issuecomment-99", author: { login: "reviewer" } }]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "checkout") {
  fs.writeFileSync(path.join(process.cwd(), "checked-out-pr.txt"), args[2], "utf8");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + JSON.stringify(args));
process.exit(1);
`,
    );

    const diff = await server.handleRpc("get_github_pull_request_diff", {
      workspaceId: "ws-1",
      prNumber: 7,
    });
    const comments = await server.handleRpc("get_github_pull_request_comments", {
      workspaceId: "ws-1",
      prNumber: 7,
    });
    const checkoutResult = await server.handleRpc("checkout_github_pull_request", {
      workspaceId: "ws-1",
      prNumber: 7,
    });

    expect(diff).toEqual([
      {
        path: "new.txt",
        status: "R",
        diff: [
          "diff --git a/old.txt b/new.txt",
          "similarity index 100%",
          "rename from old.txt",
          "rename to new.txt",
          "--- a/old.txt",
          "+++ b/new.txt",
          "@@ -1 +1 @@",
          "-before",
          "+after",
        ].join("\n"),
      },
    ]);
    expect(comments).toEqual([
      {
        id: 99,
        body: "Looks good",
        createdAt: "2026-03-08T12:00:00Z",
        url: "https://github.com/openai/codex/pull/7#issuecomment-99",
        author: { login: "reviewer" },
      },
    ]);
    expect(checkoutResult).toBeNull();
    await expect(fs.readFile(path.join(workspace.path, "checked-out-pr.txt"), "utf8")).resolves.toBe("7");
  });

  it("returns a typed error when the workspace remote is not GitHub", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["remote", "add", "origin", "git@gitlab.com:openai/codex.git"]);

    const result = await server.handleRpc("get_github_issues", { workspaceId: "ws-1" });

    expect(result).toEqual({
      error: {
        status: 400,
        message: "Remote is not a GitHub repository.",
      },
    });
  });

  it("creates a GitHub repo, adds origin, pushes HEAD, and returns the remote URL", async () => {
    const { dir, server, workspace } = await createServerFixture();
    const remoteRepo = path.join(dir, "remote.git");
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(dir, ["init", "--bare", remoteRepo]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await installFakeGh(
      dir,
      `
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("octocat\\n");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "create") {
  process.exit(0);
}
if (args[0] === "config" && args[1] === "get" && args[2] === "git_protocol") {
  process.stdout.write("https\\n");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view" && args[3] === "--json") {
  process.stdout.write(${JSON.stringify(remoteRepo + "\n")});
  process.exit(0);
}
if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + JSON.stringify(args));
process.exit(1);
`,
    );

    const result = await server.handleRpc("create_github_repo", {
      workspaceId: "ws-1",
      repo: "demo",
      visibility: "private",
      branch: "main",
    });

    expect(result).toEqual({
      status: "ok",
      repo: "octocat/demo",
      remoteUrl: remoteRepo,
    });
    await expect(fs.readFile(path.join(remoteRepo, "HEAD"), "utf8")).resolves.toContain("main");
  });

  it("returns partial when push or default branch update fails after repo creation", async () => {
    const { dir, server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["config", "user.email", "dev@example.com"]);
    await runGit(workspace.path, ["config", "user.name", "Dev"]);
    await fs.writeFile(path.join(workspace.path, "tracked.txt"), "hello\n", "utf8");
    await runGit(workspace.path, ["add", "tracked.txt"]);
    await runGit(workspace.path, ["commit", "-m", "Initial commit"]);
    await installFakeGh(
      dir,
      `
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "create") {
  process.exit(0);
}
if (args[0] === "config" && args[1] === "get" && args[2] === "git_protocol") {
  process.stdout.write("ssh\\n");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view" && args[3] === "--json") {
  process.stdout.write("git@github.com:openai/codex.git\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
  process.stderr.write("patch failed");
  process.exit(1);
}
if (args[0] === "api" && args[1] === "user") {
  process.stdout.write("ignored\\n");
  process.exit(0);
}
process.stderr.write("unexpected gh invocation: " + JSON.stringify(args));
process.exit(1);
`,
    );
    await runGit(workspace.path, ["remote", "add", "origin", "git@github.com:openai/codex.git"]);

    const result = await server.handleRpc("create_github_repo", {
      workspaceId: "ws-1",
      repo: "openai/codex",
      visibility: "public",
      branch: "main",
    });

    expect(result).toEqual({
      status: "partial",
      repo: "openai/codex",
      remoteUrl: "git@github.com:openai/codex.git",
      pushError: expect.any(String),
      defaultBranchError: "patch failed",
    });
  });

  it("rejects create_github_repo when origin points at another repository", async () => {
    const { server, workspace } = await createServerFixture();
    await fs.mkdir(workspace.path, { recursive: true });
    await runGit(workspace.path, ["init", "-b", "main"]);
    await runGit(workspace.path, ["remote", "add", "origin", "git@github.com:openai/other.git"]);

    const result = await server.handleRpc("create_github_repo", {
      workspaceId: "ws-1",
      repo: "openai/codex",
      visibility: "public",
    });

    expect(result).toEqual({
      error: {
        status: 400,
        message:
          "Origin remote already points to 'openai/other', but 'openai/codex' was requested. Remove or reconfigure origin to continue.",
      },
    });
  });
});
