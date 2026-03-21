import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "./gitRuntime.js";

export type InitializeGitRepoResult =
  | { status: "already_initialized" }
  | { status: "needs_confirmation"; entryCount: number }
  | { status: "initialized"; commitError?: string };

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

async function pathExists(targetPath: string) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

export async function countEffectiveDirEntries(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".DS_Store" || entry.name === "Thumbs.db") {
      continue;
    }
    count += 1;
  }
  return count;
}

export function validateBranchName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Branch name is required.");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("Branch name cannot be '.' or '..'.");
  }
  if (/\s/.test(trimmed)) {
    throw new Error("Branch name cannot contain spaces.");
  }
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) {
    throw new Error("Branch name cannot start or end with '/'.");
  }
  if (trimmed.includes("//")) {
    throw new Error("Branch name cannot contain '//'.");
  }
  if (trimmed.endsWith(".lock")) {
    throw new Error("Branch name cannot end with '.lock'.");
  }
  if (trimmed.includes("..")) {
    throw new Error("Branch name cannot contain '..'.");
  }
  if (trimmed.includes("@{")) {
    throw new Error("Branch name cannot contain '@{'.");
  }
  if (/[~^:?*[\]\\]/.test(trimmed)) {
    throw new Error("Branch name contains invalid characters.");
  }
  if (trimmed.endsWith(".")) {
    throw new Error("Branch name cannot end with '.'.");
  }
  return trimmed;
}

export async function initializeGitRepo(
  workspacePath: string,
  branch: string,
  force: boolean,
): Promise<InitializeGitRepoResult> {
  const repoRoot = path.resolve(workspacePath);
  const validatedBranch = validateBranchName(branch);
  if (await pathExists(path.join(repoRoot, ".git"))) {
    return { status: "already_initialized" };
  }
  if (!force) {
    const entryCount = await countEffectiveDirEntries(repoRoot);
    if (entryCount > 0) {
      return { status: "needs_confirmation", entryCount };
    }
  }

  try {
    await runGit(repoRoot, ["init", "--initial-branch", validatedBranch]);
  } catch (error) {
    const detail = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const unsupported =
      detail.includes("initial-branch") &&
      (detail.includes("unknown option") ||
        detail.includes("unrecognized option") ||
        detail.includes("unknown switch") ||
        detail.includes("usage:"));
    if (!unsupported) {
      throw error;
    }
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, ["symbolic-ref", "HEAD", `refs/heads/${validatedBranch}`]);
  }

  let commitError: string | null = null;
  try {
    await runGit(repoRoot, ["add", "-A"]);
    await runGit(repoRoot, ["commit", "--allow-empty", "-m", "Initial commit"]);
  } catch (error) {
    commitError = error instanceof Error ? error.message : String(error);
  }

  return commitError
    ? { status: "initialized", commitError }
    : { status: "initialized" };
}
