import {
  gitHubRepoNamesMatch,
  githubRepoExistsMessage,
  parseGitHubPullRequestDiff,
  parseGitHubRepo,
  validateGitHubRepoName,
  validateNormalizedRepoName,
} from "./githubParsers.js";
import {
  resolveGitRootFromPath,
  runGh,
  runGit,
  tryRunGit,
} from "./gitRuntime.js";
import { validateBranchName } from "./gitRepoLifecycle.js";

function parseJsonOrThrow<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context} returned invalid JSON: ${message}`, {
      cause: error,
    });
  }
}

async function githubRepoFromPath(repoRoot: string) {
  const remotesResult = await runGit(repoRoot, ["remote"]);
  const remoteNames = remotesResult.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const remoteName = remoteNames.includes("origin") ? "origin" : remoteNames[0] ?? null;
  if (!remoteName) {
    throw new Error("No git remote configured.");
  }
  let remoteUrl = "";
  try {
    remoteUrl = (await runGit(repoRoot, ["remote", "get-url", remoteName])).stdout.trim();
  } catch {
    throw new Error("Remote has no URL configured.");
  }
  const repo = parseGitHubRepo(remoteUrl);
  if (!repo) {
    throw new Error("Remote is not a GitHub repository.");
  }
  return repo;
}

async function ghStdoutTrim(repoRoot: string, args: string[]) {
  return (await runGh(repoRoot, args)).stdout.trim();
}

async function ghGitProtocol(repoRoot: string) {
  try {
    return await ghStdoutTrim(repoRoot, ["config", "get", "git_protocol"]);
  } catch {
    return "https";
  }
}

function ghRepoCreateArgs(fullName: string, visibilityFlag: string, originExists: boolean) {
  if (originExists) {
    return ["repo", "create", fullName, visibilityFlag];
  }
  return ["repo", "create", fullName, visibilityFlag, "--source=.", "--remote=origin"];
}

async function ensureGitHubRepoExists(
  repoRoot: string,
  fullName: string,
  visibilityFlag: string,
  originExists: boolean,
) {
  if (originExists) {
    try {
      await runGh(repoRoot, ["repo", "view", fullName, "--json", "name", "--jq", ".name"]);
      return;
    } catch {
      // fall through to create
    }
  }
  try {
    await runGh(repoRoot, ghRepoCreateArgs(fullName, visibilityFlag, originExists));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!githubRepoExistsMessage(message)) {
      throw error;
    }
  }
}

export async function getGitHubIssues(workspacePath: string) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const repoName = await githubRepoFromPath(repoRoot);
  const issues = parseJsonOrThrow<
    Array<{
      number: number;
      title: string;
      url: string;
      updatedAt: string;
    }>
  >(
    (
      await runGh(repoRoot, [
        "issue",
        "list",
        "--repo",
        repoName,
        "--limit",
        "50",
        "--json",
        "number,title,url,updatedAt",
      ])
    ).stdout,
    "gh issue list",
  );
  let total = issues.length;
  try {
    const searchQuery = `repo:${repoName} is:issue is:open`.replaceAll(" ", "+");
    total = Number.parseInt(
      (
        await runGh(repoRoot, [
          "api",
          `/search/issues?q=${searchQuery}`,
          "--jq",
          ".total_count",
        ])
      ).stdout.trim(),
      10,
    ) || issues.length;
  } catch {
    total = issues.length;
  }
  return { total, issues };
}

export async function getGitHubPullRequests(workspacePath: string) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const repoName = await githubRepoFromPath(repoRoot);
  const pullRequests = parseJsonOrThrow<
    Array<{
      author: { login: string } | null;
      baseRefName: string;
      body: string;
      createdAt: string;
      headRefName: string;
      isDraft: boolean;
      number: number;
      title: string;
      updatedAt: string;
      url: string;
    }>
  >(
    (
      await runGh(repoRoot, [
        "pr",
        "list",
        "--repo",
        repoName,
        "--state",
        "open",
        "--limit",
        "50",
        "--json",
        "number,title,url,updatedAt,createdAt,body,headRefName,baseRefName,isDraft,author",
      ])
    ).stdout,
    "gh pr list",
  );
  let total = pullRequests.length;
  try {
    const searchQuery = `repo:${repoName} is:pr is:open`.replaceAll(" ", "+");
    total = Number.parseInt(
      (
        await runGh(repoRoot, [
          "api",
          `/search/issues?q=${searchQuery}`,
          "--jq",
          ".total_count",
        ])
      ).stdout.trim(),
      10,
    ) || pullRequests.length;
  } catch {
    total = pullRequests.length;
  }
  return { total, pullRequests };
}

export async function getGitHubPullRequestDiff(workspacePath: string, prNumber: number) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const repoName = await githubRepoFromPath(repoRoot);
  const diff = await runGh(repoRoot, [
    "pr",
    "diff",
    String(prNumber),
    "--repo",
    repoName,
    "--color",
    "never",
  ]);
  return parseGitHubPullRequestDiff(diff.stdout);
}

export async function getGitHubPullRequestComments(workspacePath: string, prNumber: number) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const repoName = await githubRepoFromPath(repoRoot);
  const commentsEndpoint = `/repos/${repoName}/issues/${prNumber}/comments?per_page=30`;
  const jqFilter = "[.[] | {id, body, createdAt: .created_at, url: .html_url, author: (if .user then {login: .user.login} else null end)}]";
  return parseJsonOrThrow<
    Array<{
      author: { login: string } | null;
      body: string;
      createdAt: string;
      id: number;
      url: string;
    }>
  >(
    (await runGh(repoRoot, ["api", commentsEndpoint, "--jq", jqFilter])).stdout,
    "gh api issue comments",
  );
}

export async function checkoutGitHubPullRequest(workspacePath: string, prNumber: number) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  await runGh(repoRoot, ["pr", "checkout", String(prNumber)]);
}

export async function createGitHubRepo(
  workspacePath: string,
  repo: string,
  visibility: string,
  branch: string | null,
) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const repoName = validateNormalizedRepoName(validateGitHubRepoName(repo));
  const visibilityFlag = visibility.trim() === "private"
    ? "--private"
    : visibility.trim() === "public"
      ? "--public"
      : null;
  if (!visibilityFlag) {
    throw new Error(`Invalid repo visibility: ${visibility}`);
  }

  try {
    await runGit(repoRoot, ["rev-parse", "--git-dir"]);
  } catch {
    throw new Error("Git is not initialized in this folder yet.");
  }

  const originUrlBefore = await tryRunGit(repoRoot, ["remote", "get-url", "origin"]);
  const originRepoBefore = originUrlBefore?.stdout.trim() ? parseGitHubRepo(originUrlBefore.stdout.trim()) : null;

  const fullName = repoName.includes("/")
    ? repoName
    : `${await ghStdoutTrim(repoRoot, ["api", "user", "--jq", ".login"])}/${repoName}`;
  if (fullName.startsWith("/")) {
    throw new Error("Failed to determine GitHub username.");
  }

  if (originUrlBefore?.stdout.trim()) {
    if (!originRepoBefore) {
      throw new Error(
        "Origin remote is not a GitHub repository. Remove or reconfigure origin before creating a GitHub remote.",
      );
    }
    if (!gitHubRepoNamesMatch(originRepoBefore, fullName)) {
      throw new Error(
        `Origin remote already points to '${originRepoBefore}', but '${fullName}' was requested. Remove or reconfigure origin to continue.`,
      );
    }
  }

  await ensureGitHubRepoExists(repoRoot, fullName, visibilityFlag, Boolean(originUrlBefore?.stdout.trim()));

  let remoteUrl = (await tryRunGit(repoRoot, ["remote", "get-url", "origin"]))?.stdout.trim() || null;
  if (!remoteUrl) {
    const protocol = await ghGitProtocol(repoRoot);
    const jqField = protocol.trim() === "ssh" ? ".sshUrl" : ".httpsUrl";
    remoteUrl = await ghStdoutTrim(repoRoot, [
      "repo",
      "view",
      fullName,
      "--json",
      "sshUrl,httpsUrl",
      "--jq",
      jqField,
    ]);
    if (!remoteUrl.trim()) {
      throw new Error("Failed to resolve GitHub remote URL.");
    }
    await runGit(repoRoot, ["remote", "add", "origin", remoteUrl.trim()]);
  }

  const pushError = await runGit(repoRoot, ["push", "-u", "origin", "HEAD"]).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  let defaultBranch = branch ? validateBranchName(branch) : null;
  if (!defaultBranch) {
    const currentBranch = await tryRunGit(repoRoot, ["branch", "--show-current"]);
    defaultBranch = currentBranch?.stdout.trim() || null;
    if (defaultBranch) {
      defaultBranch = validateBranchName(defaultBranch);
    }
  }

  const defaultBranchError = defaultBranch
    ? await runGh(repoRoot, [
        "api",
        "-X",
        "PATCH",
        `/repos/${fullName}`,
        "-f",
        `default_branch=${defaultBranch}`,
      ]).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
    : null;

  if (pushError || defaultBranchError) {
    return {
      status: "partial" as const,
      repo: fullName,
      remoteUrl,
      pushError,
      defaultBranchError,
    };
  }

  return {
    status: "ok" as const,
    repo: fullName,
    remoteUrl,
  };
}
