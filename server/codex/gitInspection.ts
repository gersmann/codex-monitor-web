import fs from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ParsedStatusEntry } from "./gitParsers.js";
import { parseGitLogEntries, parseNumstat, parseStatusEntries } from "./gitParsers.js";
import {
  resolveGitRootFromPath,
  runGit,
  tryRunGit,
} from "./gitRuntime.js";

const MILLISECONDS_PER_SECOND = 10 ** 3;

type GitFileStats = {
  additions: number;
  deletions: number;
};

export type GitStatusFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

export type GitStatusSummary = {
  repoRoot: string;
  branchName: string;
  files: GitStatusFile[];
  stagedFiles: GitStatusFile[];
  unstagedFiles: GitStatusFile[];
  totalAdditions: number;
  totalDeletions: number;
};

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

function isWithinRoot(rootPath: string, candidatePath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readTextSnapshot(
  workspacePath: string,
  relativePath: string,
): Promise<{ path: string; content: string } | null> {
  const absolutePath = path.resolve(workspacePath, relativePath);
  if (!isWithinRoot(workspacePath, absolutePath)) {
    return null;
  }
  try {
    const metadata = await fs.stat(absolutePath);
    if (!metadata.isFile()) {
      return null;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    return {
      path: relativePath,
      content,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        path: relativePath,
        content: "",
      };
    }
    throw error;
  }
}

function normalizePatchText(value: string) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function buildUnifiedFileDiff(
  relativePath: string,
  beforeContent: string,
  afterContent: string,
) {
  if (beforeContent === afterContent) {
    return "";
  }
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const patch = createTwoFilesPatch(
    `a/${normalizedPath}`,
    `b/${normalizedPath}`,
    normalizePatchText(beforeContent),
    normalizePatchText(afterContent),
    "",
    "",
    { context: 3 },
  );
  return `diff --git a/${normalizedPath} b/${normalizedPath}\n${patch}`;
}

async function countTextFileAdditions(absolutePath: string) {
  try {
    const metadata = await fs.stat(absolutePath);
    if (!metadata.isFile()) {
      return 0;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    if (!content) {
      return 0;
    }
    return content.split(/\r?\n/).length;
  } catch (error) {
    if (isMissingFileError(error)) {
      return 0;
    }
    throw error;
  }
}

export async function scanGitRoots(root: string, depth: number) {
  const resolvedRoot = path.resolve(root);
  const roots = new Set<string>();
  const pending: Array<{ current: string; remainingDepth: number }> = [
    { current: resolvedRoot, remainingDepth: Math.max(0, depth) },
  ];

  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) {
      continue;
    }
    const gitEntry = path.join(next.current, ".git");
    let gitStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      gitStat = await fs.stat(gitEntry);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    if (gitStat) {
      roots.add(next.current);
      continue;
    }
    if (next.remainingDepth === 0) {
      continue;
    }
    const entries = await fs.readdir(next.current, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      pending.push({
        current: path.join(next.current, entry.name),
        remainingDepth: next.remainingDepth - 1,
      });
    }
  }

  return Array.from(roots).sort((left, right) => left.localeCompare(right));
}

function readGitFileStats(
  statsMap: Map<string, GitFileStats>,
  filePath: string,
): GitFileStats {
  return statsMap.get(filePath) ?? { additions: 0, deletions: 0 };
}

function resolveWorktreeStatus(entry: ParsedStatusEntry) {
  if (entry.worktreeStatus) {
    return entry.worktreeStatus;
  }
  return entry.untracked ? "A" : null;
}

async function resolveUnstagedFileStats(
  repoRoot: string,
  entry: ParsedStatusEntry,
  unstagedStatsMap: Map<string, GitFileStats>,
) {
  const stats = { ...readGitFileStats(unstagedStatsMap, entry.path) };
  if (!entry.untracked) {
    return stats;
  }
  return {
    additions: await countTextFileAdditions(path.join(repoRoot, entry.path)),
    deletions: stats.deletions,
  };
}

function appendGitFile(
  target: GitStatusFile[],
  file: GitStatusFile,
  totals: { additions: number; deletions: number },
) {
  target.push(file);
  totals.additions += file.additions;
  totals.deletions += file.deletions;
}

export async function buildGitStatusSummary(workspacePath: string): Promise<GitStatusSummary> {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const [statusResult, branchResult, stagedStatsResult, unstagedStatsResult] = await Promise.all([
    runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"]),
    tryRunGit(repoRoot, ["branch", "--show-current"]),
    runGit(repoRoot, ["diff", "--cached", "--numstat", "--"]),
    runGit(repoRoot, ["diff", "--numstat", "--"]),
  ]);
  const branchName = branchResult?.stdout.trim() || "unknown";
  const stagedStats = parseNumstat(stagedStatsResult.stdout);
  const unstagedStats = parseNumstat(unstagedStatsResult.stdout);
  const entries = parseStatusEntries(statusResult.stdout);

  const files: GitStatusFile[] = [];
  const stagedFiles: GitStatusFile[] = [];
  const unstagedFiles: GitStatusFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const entry of entries) {
    const staged = readGitFileStats(stagedStats, entry.path);
    const unstaged = await resolveUnstagedFileStats(repoRoot, entry, unstagedStats);
    const worktreeStatus = resolveWorktreeStatus(entry);
    const totals = { additions: 0, deletions: 0 };
    if (entry.indexStatus) {
      appendGitFile(
        stagedFiles,
        {
          path: entry.path,
          status: entry.indexStatus,
          additions: staged.additions,
          deletions: staged.deletions,
        },
        totals,
      );
    }
    if (worktreeStatus) {
      appendGitFile(
        unstagedFiles,
        {
          path: entry.path,
          status: worktreeStatus,
          additions: unstaged.additions,
          deletions: unstaged.deletions,
        },
        totals,
      );
    }
    files.push({
      path: entry.path,
      status: worktreeStatus || entry.indexStatus || "A",
      additions: staged.additions + unstaged.additions,
      deletions: staged.deletions + unstaged.deletions,
    });
    totalAdditions += totals.additions;
    totalDeletions += totals.deletions;
  }

  return {
    repoRoot,
    branchName,
    files,
    stagedFiles,
    unstagedFiles,
    totalAdditions,
    totalDeletions,
  };
}

export async function buildWorkingTreeDiffs(workspacePath: string) {
  const status = await buildGitStatusSummary(workspacePath);
  const diffs = await Promise.all(
    status.files.map(async (file) => {
      const isUntracked = !status.stagedFiles.some((entry) => entry.path === file.path) &&
        status.unstagedFiles.some((entry) => entry.path === file.path && entry.status === "A");
      let diff = "";
      if (isUntracked) {
        const snapshot = await readTextSnapshot(status.repoRoot, file.path);
        if (!snapshot) {
          return null;
        }
        diff = buildUnifiedFileDiff(file.path, "", snapshot.content);
      } else {
        diff = (await runGit(status.repoRoot, ["diff", "--binary", "HEAD", "--", file.path])).stdout;
      }
      if (!diff.trim()) {
        return null;
      }
      return {
        path: file.path,
        diff,
      };
    }),
  );
  return diffs.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export async function getPreferredRemote(repoRoot: string) {
  const origin = await tryRunGit(repoRoot, ["remote", "get-url", "origin"]);
  if (origin?.stdout.trim()) {
    return origin.stdout.trim();
  }
  const remotes = await tryRunGit(repoRoot, ["remote"]);
  const firstRemote = remotes?.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!firstRemote) {
    return null;
  }
  const remote = await tryRunGit(repoRoot, ["remote", "get-url", firstRemote]);
  return remote?.stdout.trim() || null;
}

function normalizeGitPathForUi(filePath: string) {
  return filePath.replace(/\\/g, "/");
}

export async function getGitLogSummary(workspacePath: string, limit: number) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const totalResult = await runGit(repoRoot, ["rev-list", "--count", "HEAD"]);
  const entriesResult = await runGit(repoRoot, [
    "log",
    `--max-count=${limit}`,
    "--date=unix",
    "--pretty=format:%H%x1f%s%x1f%an%x1f%at%x1e",
  ]);
  let ahead = 0;
  let behind = 0;
  let aheadEntries: Array<{ sha: string; summary: string; author: string; timestamp: number }> = [];
  let behindEntries: Array<{ sha: string; summary: string; author: string; timestamp: number }> = [];
  let upstream: string | null = null;
  const upstreamName = await tryRunGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstreamName?.stdout.trim()) {
    upstream = upstreamName.stdout.trim();
    const counts = await runGit(repoRoot, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
    const [aheadRaw = "0", behindRaw = "0"] = counts.stdout.trim().split(/\s+/);
    ahead = Number.parseInt(aheadRaw, 10) || 0;
    behind = Number.parseInt(behindRaw, 10) || 0;
    const [aheadResult, behindResult] = await Promise.all([
      runGit(repoRoot, [
        "log",
        `--max-count=${limit}`,
        "--date=unix",
        "--pretty=format:%H%x1f%s%x1f%an%x1f%at%x1e",
        `${upstream}..HEAD`,
      ]),
      runGit(repoRoot, [
        "log",
        `--max-count=${limit}`,
        "--date=unix",
        "--pretty=format:%H%x1f%s%x1f%an%x1f%at%x1e",
        `HEAD..${upstream}`,
      ]),
    ]);
    aheadEntries = parseGitLogEntries(aheadResult.stdout);
    behindEntries = parseGitLogEntries(behindResult.stdout);
  }
  return {
    total: Number.parseInt(totalResult.stdout.trim(), 10) || 0,
    entries: parseGitLogEntries(entriesResult.stdout),
    ahead,
    behind,
    aheadEntries,
    behindEntries,
    upstream,
  };
}

export async function getCommitDiffEntries(workspacePath: string, sha: string) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const names = await runGit(repoRoot, ["diff-tree", "--no-commit-id", "--name-status", "-r", sha]);
  const entries = names.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status = "", ...pathParts] = line.split("\t");
      return {
        status,
        path: normalizeGitPathForUi(pathParts[pathParts.length - 1] ?? ""),
      };
    })
    .filter((entry) => entry.path);

  return await Promise.all(
    entries.map(async (entry) => ({
      path: entry.path,
      status: entry.status.charAt(0) || "M",
      diff: (await runGit(repoRoot, ["show", "--format=", "--binary", sha, "--", entry.path])).stdout,
    })),
  );
}

export async function listLocalGitBranches(workspacePath: string) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const result = await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)\t%(committerdate:unix)",
    "refs/heads",
  ]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", lastCommit = "0"] = line.split("\t");
      return {
        name,
        lastCommit: (Number.parseInt(lastCommit, 10) || 0) * MILLISECONDS_PER_SECOND,
      };
    })
    .filter((entry) => entry.name);
}
