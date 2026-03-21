import fs from "node:fs/promises";
import path from "node:path";
import type { JsonRecord, RpcErrorShape, StoredWorkspace } from "../types.js";

export type WorkspaceGitRpcContext = {
  dataDir: string;
  getWorkspace: (workspaceId: string) => StoredWorkspace | null;
  addWorkspaceFromPath: (targetPath: string) => Promise<unknown>;
  setWorkspace: (workspace: StoredWorkspace) => void;
  persistWorkspaces: () => Promise<void>;
  isWorkspaceConnected: (workspaceId: string) => boolean;
  createWorkspaceId: () => string;
  defaultWorkspaceSettings: () => StoredWorkspace["settings"];
  slugifyAgentName: (name: string) => string;
  trimString: (value: unknown) => string;
  toNullableString: (value: unknown) => string | null;
  pathExists: (targetPath: string) => Promise<boolean>;
  notFound: (message: string) => RpcErrorShape;
  badRequest: (message: string) => RpcErrorShape;
  rpcBoundaryError: (error: unknown) => RpcErrorShape;
  resolveGitRootFromPath: (workspacePath: string) => Promise<string>;
  runGit: (repoRoot: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  tryRunGit: (repoRoot: string, args: string[]) => Promise<{ stdout: string; stderr: string } | null>;
  cloneRepository: (url: string, destinationPath: string) => Promise<void>;
  runGitNoIndexDiff: (repoRoot: string, relativePath: string) => Promise<string>;
  applyGitPatch: (repoRoot: string, patch: string) => Promise<void>;
};

type WorkspaceGitRpcHandler = (
  context: WorkspaceGitRpcContext,
  params: JsonRecord,
) => Promise<unknown | RpcErrorShape>;

function worktreeSetupMarkerPath(dataDir: string, workspaceId: string) {
  return path.join(dataDir, "worktree-setup", `${workspaceId}.ran`);
}

function normalizeSetupScript(
  context: WorkspaceGitRpcContext,
  script: unknown,
) {
  const trimmed = context.trimString(script);
  return trimmed ? trimmed : null;
}

async function handleAddWorkspaceFromGitUrl(
  context: WorkspaceGitRpcContext,
  params: JsonRecord,
) {
  const url = String(params.url ?? "");
  const destinationPath = String(params.destinationPath ?? "");
  const targetFolderName =
    params.targetFolderName == null ? null : String(params.targetFolderName);
  if (!url || !destinationPath) {
    return context.notFound("Git URL and destination path are required.");
  }
  const folderName =
    targetFolderName ??
    url.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/, "") ??
    "workspace";
  const targetPath = path.join(destinationPath, folderName);
  try {
    await context.cloneRepository(url, targetPath);
    return await context.addWorkspaceFromPath(targetPath);
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleAddWorktree(
  context: WorkspaceGitRpcContext,
  params: JsonRecord,
) {
  const parentId = String(params.parentId ?? "");
  const branch = context.trimString(params.branch);
  const requestedName = context.toNullableString(params.name);
  const copyAgentsMd = params.copyAgentsMd !== false;
  const parent = context.getWorkspace(parentId);
  if (!parent) {
    return context.notFound("Parent workspace not found.");
  }
  if (!branch) {
    return context.badRequest("Branch name is required.");
  }
  try {
    const repoRoot = await context.resolveGitRootFromPath(parent.path);
    const worktreesDir = path.join(context.dataDir, "worktrees");
    const baseName = context.slugifyAgentName(requestedName ?? branch.replace(/\//g, "-"));
    let targetPath = path.join(worktreesDir, baseName);
    let suffix = 2;
    while (await context.pathExists(targetPath)) {
      targetPath = path.join(worktreesDir, `${baseName}-${suffix}`);
      suffix += 1;
    }
    await fs.mkdir(worktreesDir, { recursive: true });
    const branchExists = Boolean(
      await context.tryRunGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]),
    );
    if (branchExists) {
      await context.runGit(repoRoot, ["worktree", "add", targetPath, branch]);
    } else {
      await context.runGit(repoRoot, ["worktree", "add", "-b", branch, targetPath]);
    }
    if (copyAgentsMd) {
      const sourceAgents = path.join(parent.path, "AGENTS.md");
      const destinationAgents = path.join(targetPath, "AGENTS.md");
      const sourceExists = await context.pathExists(sourceAgents);
      const destinationExists = await context.pathExists(destinationAgents);
      if (sourceExists && !destinationExists) {
        await fs.copyFile(sourceAgents, destinationAgents);
      }
    }
    const workspace: StoredWorkspace = {
      id: context.createWorkspaceId(),
      name: requestedName ?? branch,
      path: targetPath,
      kind: "worktree",
      parentId,
      worktree: { branch },
      settings: {
        ...context.defaultWorkspaceSettings(),
        sidebarCollapsed: parent.settings.sidebarCollapsed,
        groupId: parent.settings.groupId ?? null,
        sortOrder: parent.settings.sortOrder ?? null,
        gitRoot: parent.settings.gitRoot ?? null,
        worktreeSetupScript: parent.settings.worktreeSetupScript ?? null,
      },
    };
    context.setWorkspace(workspace);
    await context.persistWorkspaces();
    return { ...workspace, connected: false };
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleRenameWorktree(
  context: WorkspaceGitRpcContext,
  params: JsonRecord,
) {
  const workspaceId = String(params.id ?? "");
  const nextBranch = context.trimString(params.branch);
  const workspace = context.getWorkspace(workspaceId);
  if (!workspace) {
    return context.notFound("Workspace not found.");
  }
  if (workspace.kind !== "worktree" || !workspace.worktree?.branch) {
    return context.badRequest("Not a worktree workspace.");
  }
  if (!nextBranch) {
    return context.badRequest("Branch name is required.");
  }
  try {
    const repoRoot = await context.resolveGitRootFromPath(workspace.path);
    let actualBranch = nextBranch;
    let suffix = 2;
    while (
      await context.tryRunGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${actualBranch}`])
    ) {
      actualBranch = `${nextBranch}-${suffix}`;
      suffix += 1;
    }
    await context.runGit(repoRoot, ["branch", "-m", workspace.worktree.branch, actualBranch]);
    workspace.worktree = { branch: actualBranch };
    await context.persistWorkspaces();
    return { ...workspace, connected: context.isWorkspaceConnected(workspace.id) };
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleRenameWorktreeUpstream(
  context: WorkspaceGitRpcContext,
  params: JsonRecord,
) {
  const workspaceId = String(params.id ?? "");
  const oldBranch = context.trimString(params.oldBranch);
  const newBranch = context.trimString(params.newBranch);
  const workspace = context.getWorkspace(workspaceId);
  if (!workspace) {
    return context.notFound("Workspace not found.");
  }
  if (!oldBranch || !newBranch) {
    return context.badRequest("Both old and new branch names are required.");
  }
  try {
    const repoRoot = await context.resolveGitRootFromPath(workspace.path);
    const remoteName = "origin";
    await context.runGit(repoRoot, ["push", remoteName, `refs/heads/${newBranch}:refs/heads/${newBranch}`]);
    await context.tryRunGit(repoRoot, ["push", remoteName, "--delete", oldBranch]);
    await context.tryRunGit(repoRoot, ["branch", "--set-upstream-to", `${remoteName}/${newBranch}`, newBranch]);
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleApplyWorktreeChanges(
  context: WorkspaceGitRpcContext,
  params: JsonRecord,
) {
  const workspaceId = String(params.workspaceId ?? "");
  const workspace = context.getWorkspace(workspaceId);
  if (!workspace) {
    return context.notFound("Workspace not found.");
  }
  if (workspace.kind !== "worktree") {
    return context.badRequest("Not a worktree workspace.");
  }
  const parent = workspace.parentId ? context.getWorkspace(workspace.parentId) : null;
  if (!parent) {
    return context.badRequest("Worktree parent not found.");
  }
  try {
    const worktreeRoot = await context.resolveGitRootFromPath(workspace.path);
    const parentRoot = await context.resolveGitRootFromPath(parent.path);
    const parentStatus = await context.runGit(parentRoot, ["status", "--porcelain"]);
    if (parentStatus.stdout.trim()) {
      return context.badRequest(
        "Your current branch has uncommitted changes. Please commit, stash, or discard them before applying worktree changes.",
      );
    }

    let patch = "";
    patch += (await context.runGit(worktreeRoot, ["diff", "--binary", "--no-color", "--cached"])).stdout;
    patch += (await context.runGit(worktreeRoot, ["diff", "--binary", "--no-color"])).stdout;

    const untracked = await context.runGit(worktreeRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    for (const rawPath of untracked.stdout.split("\0").filter(Boolean)) {
      patch += await context.runGitNoIndexDiff(worktreeRoot, rawPath);
    }

    if (!patch.trim()) {
      return context.badRequest("No changes to apply.");
    }

    await context.applyGitPatch(parentRoot, patch);
    return null;
  } catch (error) {
    return context.rpcBoundaryError(error);
  }
}

async function handleWorktreeSetupStatus(
  context: WorkspaceGitRpcContext,
  params: JsonRecord,
) {
  const workspaceId = String(params.workspaceId ?? "");
  const workspace = context.getWorkspace(workspaceId);
  if (!workspace) {
    return context.notFound("Workspace not found.");
  }
  const script = normalizeSetupScript(context, workspace.settings.worktreeSetupScript);
  const markerExists =
    workspace.kind === "worktree" &&
    (await context.pathExists(worktreeSetupMarkerPath(context.dataDir, workspace.id)));
  return {
    shouldRun: workspace.kind === "worktree" && Boolean(script) && !markerExists,
    script,
  };
}

async function handleWorktreeSetupMarkRan(
  context: WorkspaceGitRpcContext,
  params: JsonRecord,
) {
  const workspaceId = String(params.workspaceId ?? "");
  const workspace = context.getWorkspace(workspaceId);
  if (!workspace) {
    return context.notFound("Workspace not found.");
  }
  if (workspace.kind !== "worktree") {
    return context.badRequest("Not a worktree workspace.");
  }
  const markerPath = worktreeSetupMarkerPath(context.dataDir, workspace.id);
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(
    markerPath,
    `ran_at=${Math.floor(Date.now() / 1000)}\n`,
    "utf8",
  );
  return { ok: true };
}

const WORKSPACE_GIT_RPC_HANDLERS: Record<string, WorkspaceGitRpcHandler> = {
  add_workspace_from_git_url: handleAddWorkspaceFromGitUrl,
  add_worktree: handleAddWorktree,
  rename_worktree: handleRenameWorktree,
  rename_worktree_upstream: handleRenameWorktreeUpstream,
  apply_worktree_changes: handleApplyWorktreeChanges,
  worktree_setup_status: handleWorktreeSetupStatus,
  worktree_setup_mark_ran: handleWorktreeSetupMarkRan,
};

export function handleWorkspaceGitRpc(
  context: WorkspaceGitRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  const handler = WORKSPACE_GIT_RPC_HANDLERS[method];
  return handler
    ? Promise.resolve(handler(context, params))
    : Promise.resolve(undefined);
}
