function normalizeGitPathForUi(filePath: string) {
  return filePath.replace(/\\/g, "/");
}

export function parseGitHubRepo(remoteUrl: string) {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }
  let repoPath = "";
  if (trimmed.startsWith("git@github.com:")) {
    repoPath = trimmed.slice("git@github.com:".length);
  } else if (trimmed.startsWith("ssh://git@github.com/")) {
    repoPath = trimmed.slice("ssh://git@github.com/".length);
  } else {
    const githubIndex = trimmed.indexOf("github.com/");
    if (githubIndex === -1) {
      return null;
    }
    repoPath = trimmed.slice(githubIndex + "github.com/".length);
  }
  repoPath = repoPath.replace(/\.git$/i, "").replace(/\/+$/g, "");
  return repoPath || null;
}

export function validateGitHubRepoName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Repository name is required.");
  }
  if (/\s/.test(trimmed)) {
    throw new Error("Repository name cannot contain spaces.");
  }
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) {
    throw new Error("Repository name cannot start or end with '/'.");
  }
  if (trimmed.includes("//")) {
    throw new Error("Repository name cannot contain '//'.");
  }
  return trimmed;
}

export function normalizeRepoFullName(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
}

export function validateNormalizedRepoName(value: string) {
  const normalized = normalizeRepoFullName(value);
  if (!normalized) {
    throw new Error("Repository name is empty after normalization. Use 'repo' or 'owner/repo'.");
  }
  return normalized;
}

export function gitHubRepoNamesMatch(existing: string, requested: string) {
  return normalizeRepoFullName(existing).toLowerCase() === normalizeRepoFullName(requested).toLowerCase();
}

export function githubRepoExistsMessage(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("already exists") ||
    lower.includes("name already exists") ||
    lower.includes("has already been taken") ||
    lower.includes("repository with this name already exists")
  );
}

type PullRequestDiffChunk = {
  lines: string[];
  oldPath: string | null;
  newPath: string | null;
  status: string | null;
};

function createPullRequestDiffChunk(): PullRequestDiffChunk {
  return {
    lines: [],
    oldPath: null,
    newPath: null,
    status: null,
  };
}

function resetPullRequestDiffChunk(chunk: PullRequestDiffChunk, line: string) {
  chunk.lines = [line];
  chunk.oldPath = null;
  chunk.newPath = null;
  chunk.status = null;
  const parts = line.slice("diff --git ".length).trim().split(/\s+/);
  const oldPart = parts[0]?.replace(/^a\//, "") ?? "";
  const newPart = parts[1]?.replace(/^b\//, "") ?? "";
  chunk.oldPath = oldPart || null;
  chunk.newPath = newPart || null;
}

function updatePullRequestDiffChunkMetadata(chunk: PullRequestDiffChunk, line: string) {
  if (line.startsWith("new file mode ")) {
    chunk.status = "A";
    return;
  }
  if (line.startsWith("deleted file mode ")) {
    chunk.status = "D";
    return;
  }
  if (line.startsWith("rename from ")) {
    chunk.status = "R";
    chunk.oldPath = line.slice("rename from ".length).trim() || chunk.oldPath;
    return;
  }
  if (line.startsWith("rename to ")) {
    chunk.status = "R";
    chunk.newPath = line.slice("rename to ".length).trim() || chunk.newPath;
  }
}

function finalizePullRequestDiffChunk(
  chunk: PullRequestDiffChunk,
  results: Array<{ path: string; status: string; diff: string }>,
) {
  if (chunk.lines.length === 0) {
    return;
  }
  const diffText = chunk.lines.join("\n");
  if (!diffText.trim()) {
    return;
  }
  const status = chunk.status ?? "M";
  const filePath = status === "D" ? chunk.oldPath : chunk.newPath ?? chunk.oldPath;
  if (!filePath) {
    return;
  }
  results.push({
    path: normalizeGitPathForUi(filePath),
    status,
    diff: diffText,
  });
}

export function parseGitHubPullRequestDiff(diff: string) {
  const results: Array<{ path: string; status: string; diff: string }> = [];
  const chunk = createPullRequestDiffChunk();
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      finalizePullRequestDiffChunk(chunk, results);
      resetPullRequestDiffChunk(chunk, line);
      continue;
    }
    updatePullRequestDiffChunkMetadata(chunk, line);
    chunk.lines.push(line);
  }
  finalizePullRequestDiffChunk(chunk, results);
  return results;
}
