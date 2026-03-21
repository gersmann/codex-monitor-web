import fs from "node:fs/promises";
import path from "node:path";
import type { JsonRecord, RpcErrorShape, StoredWorkspace } from "../types.js";
import type { GitStatusSummary } from "./gitInspection.js";

export type GitRpcContext = {
  getWorkspace: (workspaceId: string) => StoredWorkspace | null;
  trimString: (value: unknown) => string;
  notFound: (message: string) => RpcErrorShape;
  badRequest: (message: string) => RpcErrorShape;
  rpcBoundaryError: (error: unknown) => RpcErrorShape;
  initializeGitRepo: (
    workspacePath: string,
    branch: string,
    force: boolean,
  ) => Promise<unknown>;
  createGitHubRepo: (
    workspacePath: string,
    repo: string,
    visibility: string,
    branch: string | null,
  ) => Promise<unknown>;
  runGit: (repoRoot: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  runGitCommit: (repoRoot: string, message: string) => Promise<{ stdout: string; stderr: string }>;
  tryRunGit: (repoRoot: string, args: string[]) => Promise<{ stdout: string; stderr: string } | null>;
  resolveGitRootFromPath: (workspacePath: string) => Promise<string>;
  listLocalGitBranches: (workspacePath: string) => Promise<unknown>;
  getGitHubIssues: (workspacePath: string) => Promise<unknown>;
  getGitHubPullRequests: (workspacePath: string) => Promise<unknown>;
  getGitHubPullRequestDiff: (workspacePath: string, prNumber: number) => Promise<unknown>;
  getGitHubPullRequestComments: (workspacePath: string, prNumber: number) => Promise<unknown>;
  checkoutGitHubPullRequest: (workspacePath: string, prNumber: number) => Promise<void>;
  buildGitStatusSummary: (workspacePath: string) => Promise<GitStatusSummary>;
  scanGitRoots: (root: string, depth: number) => Promise<string[]>;
  buildWorkingTreeDiffs: (workspacePath: string) => Promise<Array<{ path: string; diff: string }>>;
  getGitLogSummary: (workspacePath: string, limit: number) => Promise<unknown>;
  getCommitDiffEntries: (workspacePath: string, sha: string) => Promise<unknown>;
  getPreferredRemote: (repoRoot: string) => Promise<string | null>;
};

type GitRpcHandler = (
  context: GitRpcContext,
  params: JsonRecord,
) => Promise<unknown | RpcErrorShape>;

function readWorkspace(
  context: GitRpcContext,
  workspaceId: string,
): StoredWorkspace | RpcErrorShape {
  const workspace = context.getWorkspace(workspaceId);
  return workspace ?? context.notFound("Workspace not found.");
}

function parseFiniteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePrNumber(
  context: GitRpcContext,
  params: JsonRecord,
): number | RpcErrorShape {
  const prNumber = parseFiniteNumber(params.prNumber);
  return prNumber === null ? context.badRequest("prNumber is required.") : prNumber;
}

function readWorkspacePath(
  context: GitRpcContext,
  params: JsonRecord,
): string | RpcErrorShape {
  const workspace = readWorkspace(context, String(params.workspaceId ?? ""));
  return "error" in workspace ? workspace : workspace.path;
}

function optionalTrimmedString(
  context: GitRpcContext,
  value: unknown,
) {
  const trimmed = context.trimString(value);
  return trimmed.length > 0 ? trimmed : null;
}

async function runWorkspaceGitCommand(
  context: GitRpcContext,
  workspacePath: string,
  args: string[],
) {
  return context.runGit(await context.resolveGitRootFromPath(workspacePath), args);
}

async function handleFetchGit(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  await runWorkspaceGitCommand(context, workspacePath, ["fetch", "--all", "--prune"]);
  return null;
}

async function handleSyncGit(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const repoRoot = await context.resolveGitRootFromPath(workspacePath);
  await context.runGit(repoRoot, ["pull", "--rebase"]);
  await context.runGit(repoRoot, ["push"]);
  return null;
}

async function handleListGitBranches(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    return { branches: await context.listLocalGitBranches(workspacePath) };
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

function visibleGitPaths(status: GitStatusSummary) {
  return Array.from(
    new Set(
      status.files
        .map((entry) => entry.path)
        .filter((entry) => typeof entry === "string" && entry.length > 0),
    ),
  );
}

async function handleCheckoutGitBranch(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  await runWorkspaceGitCommand(context, workspacePath, ["checkout", context.trimString(params.name)]);
  return null;
}

async function handleCreateGitBranch(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  await runWorkspaceGitCommand(context, workspacePath, ["checkout", "-b", context.trimString(params.name)]);
  return null;
}

async function handleGitHubIssues(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    return await context.getGitHubIssues(workspacePath);
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleGitHubPullRequests(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    return await context.getGitHubPullRequests(workspacePath);
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleGitHubPullRequestDiff(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const prNumber = parsePrNumber(context, params);
  if (typeof prNumber !== "number") {
    return prNumber;
  }
  try {
    return await context.getGitHubPullRequestDiff(workspacePath, prNumber);
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleGitHubPullRequestComments(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const prNumber = parsePrNumber(context, params);
  if (typeof prNumber !== "number") {
    return prNumber;
  }
  try {
    return await context.getGitHubPullRequestComments(workspacePath, prNumber);
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleCheckoutGitHubPullRequest(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const prNumber = parsePrNumber(context, params);
  if (typeof prNumber !== "number") {
    return prNumber;
  }
  try {
    await context.checkoutGitHubPullRequest(workspacePath, prNumber);
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleGetGitStatus(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    const status = await context.buildGitStatusSummary(workspacePath);
    return {
      branchName: status.branchName,
      files: status.files,
      stagedFiles: status.stagedFiles,
      unstagedFiles: status.unstagedFiles,
      totalAdditions: status.totalAdditions,
      totalDeletions: status.totalDeletions,
    };
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleListGitRoots(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const depth =
    typeof params.depth === "number" && Number.isFinite(params.depth) ? params.depth : 2;
  try {
    return await context.scanGitRoots(workspacePath, depth);
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleGetGitDiffs(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    return await context.buildWorkingTreeDiffs(workspacePath);
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleGetGitLog(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 40;
  try {
    return await context.getGitLogSummary(workspacePath, limit);
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleGetGitCommitDiff(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const sha = context.trimString(params.sha);
  if (!sha) {
    return context.badRequest("sha is required.");
  }
  try {
    return await context.getCommitDiffEntries(workspacePath, sha);
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleGetGitRemote(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    const repoRoot = await context.resolveGitRootFromPath(workspacePath);
    return await context.getPreferredRemote(repoRoot);
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleStageGitFile(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    await runWorkspaceGitCommand(context, workspacePath, ["add", "--", context.trimString(params.path)]);
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleStageGitAll(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    const status = await context.buildGitStatusSummary(workspacePath);
    const visiblePaths = visibleGitPaths(status);
    if (visiblePaths.length === 0) {
      return null;
    }
    await context.runGit(status.repoRoot, ["add", "-A", "--", ...visiblePaths]);
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleUnstageGitFile(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    await runWorkspaceGitCommand(context, workspacePath, [
      "restore",
      "--staged",
      "--",
      context.trimString(params.path),
    ]);
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleRevertGitFile(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const filePath = context.trimString(params.path);
  try {
    const repoRoot = await context.resolveGitRootFromPath(workspacePath);
    const tracked = await context.tryRunGit(repoRoot, ["ls-files", "--error-unmatch", "--", filePath]);
    if (tracked) {
      await context.runGit(repoRoot, [
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        filePath,
      ]);
    } else {
      await fs.rm(path.join(repoRoot, filePath), { force: true, recursive: true });
    }
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleRevertGitAll(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    const repoRoot = await context.resolveGitRootFromPath(workspacePath);
    await context.runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "."]);
    await context.tryRunGit(repoRoot, ["clean", "-fd"]);
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleCommitGit(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  const message = String(params.message ?? "").trim();
  if (!message) {
    return context.badRequest("Commit message is required.");
  }
  try {
    await context.runGitCommit(await context.resolveGitRootFromPath(workspacePath), message);
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handlePushGit(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    await runWorkspaceGitCommand(context, workspacePath, ["push"]);
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handlePullGit(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    await runWorkspaceGitCommand(context, workspacePath, ["pull", "--rebase"]);
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleInitGitRepo(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    return await context.initializeGitRepo(
      workspacePath,
      context.trimString(params.branch),
      params.force === true,
    );
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleCreateGitHubRepo(context: GitRpcContext, params: JsonRecord) {
  const workspacePath = readWorkspacePath(context, params);
  if (typeof workspacePath !== "string") {
    return workspacePath;
  }
  try {
    return await context.createGitHubRepo(
      workspacePath,
      context.trimString(params.repo),
      context.trimString(params.visibility),
      optionalTrimmedString(context, params.branch),
    );
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

const GIT_RPC_HANDLERS: Record<string, GitRpcHandler> = {
  fetch_git: handleFetchGit,
  sync_git: handleSyncGit,
  list_git_branches: handleListGitBranches,
  checkout_git_branch: handleCheckoutGitBranch,
  create_git_branch: handleCreateGitBranch,
  get_github_issues: handleGitHubIssues,
  get_github_pull_requests: handleGitHubPullRequests,
  get_github_pull_request_diff: handleGitHubPullRequestDiff,
  get_github_pull_request_comments: handleGitHubPullRequestComments,
  checkout_github_pull_request: handleCheckoutGitHubPullRequest,
  get_git_status: handleGetGitStatus,
  list_git_roots: handleListGitRoots,
  get_git_diffs: handleGetGitDiffs,
  get_git_log: handleGetGitLog,
  get_git_commit_diff: handleGetGitCommitDiff,
  get_git_remote: handleGetGitRemote,
  stage_git_file: handleStageGitFile,
  stage_git_all: handleStageGitAll,
  unstage_git_file: handleUnstageGitFile,
  revert_git_file: handleRevertGitFile,
  revert_git_all: handleRevertGitAll,
  commit_git: handleCommitGit,
  push_git: handlePushGit,
  pull_git: handlePullGit,
  init_git_repo: handleInitGitRepo,
  create_github_repo: handleCreateGitHubRepo,
};

function dispatchGitHandler(
  context: GitRpcContext,
  method: string,
  params: JsonRecord,
  ownedMethods: ReadonlySet<string>,
) {
  if (!ownedMethods.has(method)) {
    return Promise.resolve(undefined);
  }
  return Promise.resolve(GIT_RPC_HANDLERS[method]?.(context, params));
}

const GIT_BRANCH_METHODS = new Set([
  "fetch_git",
  "sync_git",
  "list_git_branches",
  "checkout_git_branch",
  "create_git_branch",
]);

const GITHUB_METHODS = new Set([
  "get_github_issues",
  "get_github_pull_requests",
  "get_github_pull_request_diff",
  "get_github_pull_request_comments",
  "checkout_github_pull_request",
  "create_github_repo",
]);

const GIT_WORKING_TREE_METHODS = new Set([
  "get_git_status",
  "list_git_roots",
  "get_git_diffs",
  "get_git_log",
  "get_git_commit_diff",
  "get_git_remote",
  "stage_git_file",
  "stage_git_all",
  "unstage_git_file",
  "revert_git_file",
  "revert_git_all",
  "commit_git",
  "push_git",
  "pull_git",
  "init_git_repo",
]);

export function handleGitBranchRpc(
  context: GitRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  return dispatchGitHandler(context, method, params, GIT_BRANCH_METHODS);
}

export function handleGitHubRpc(
  context: GitRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  return dispatchGitHandler(context, method, params, GITHUB_METHODS);
}

export function handleGitWorkingTreeRpc(
  context: GitRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  return dispatchGitHandler(context, method, params, GIT_WORKING_TREE_METHODS);
}

export function handleGitRpc(
  context: GitRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  const handler = GIT_RPC_HANDLERS[method];
  return handler
    ? Promise.resolve(handler(context, params))
    : Promise.resolve(undefined);
}
