import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { Codex, type Thread, type ThreadEvent, type ThreadItem, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import { createTwoFilesPatch } from "diff";
import { buildAppServerEvent } from "./appServer.js";
import { CompanionStorage } from "./storage.js";
import type {
  AppServerEventPayload,
  JsonRecord,
  RpcErrorShape,
  StoredThread,
  StoredThreadItem,
  StoredTurn,
  StoredWorkspace,
} from "./types.js";

type ActiveRun = {
  abortController: AbortController;
  turnId: string;
};

type BroadcastMessage = {
  event: "app-server-event";
  payload: AppServerEventPayload;
};

type BroadcastFn = (message: BroadcastMessage) => void;

type AgentSummary = {
  name: string;
  description: string | null;
  developerInstructions: string | null;
  configFile: string;
  resolvedPath: string;
  managedByApp: boolean;
  fileExists: boolean;
};

type AgentsState = {
  multiAgentEnabled: boolean;
  maxThreads: number;
  maxDepth: number;
  agents: AgentSummary[];
};

type PromptEntry = {
  name: string;
  path: string;
  description: string | null;
  argumentHint: string | null;
  content: string;
  scope: "workspace" | "global";
};

type FileSnapshot = {
  path: string;
  content: string;
};

const DEFAULT_AGENT_MAX_THREADS = 6;
const DEFAULT_AGENT_MAX_DEPTH = 1;
const APP_SERVER_INIT_TIMEOUT_MS = 15_000;
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const APP_SERVER_SOURCE_KINDS = [
  "cli",
  "vscode",
  "appServer",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "unknown",
];
const DEFAULT_MODELS = [
  {
    id: "gpt-5-codex",
    model: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    description: "Default Codex coding model.",
    supportedReasoningEfforts: [
      { reasoningEffort: "minimal", description: "Fastest" },
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "High" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
  {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "General-purpose latest GPT-5 family model.",
    supportedReasoningEfforts: [
      { reasoningEffort: "minimal", description: "Fastest" },
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "High" },
    ],
    defaultReasoningEffort: "high",
    isDefault: false,
  },
];

function notFound(message: string): RpcErrorShape {
  return { error: { message } };
}

function badRequest(message: string): RpcErrorShape {
  return { error: { message } };
}

function isRpcError(value: unknown): value is RpcErrorShape {
  return Boolean(
    value &&
      typeof value === "object" &&
      "error" in value &&
      typeof (value as { error?: unknown }).error === "object",
  );
}

function totalsFromUsage(usage: Usage | null | undefined) {
  return {
    totalTokens:
      (usage?.input_tokens ?? 0) +
      (usage?.cached_input_tokens ?? 0) +
      (usage?.output_tokens ?? 0),
    inputTokens: usage?.input_tokens ?? 0,
    cachedInputTokens: usage?.cached_input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    reasoningOutputTokens: 0,
  };
}

function toThreadSummary(thread: StoredThread) {
  return {
    id: thread.id,
    cwd: thread.cwd,
    preview: thread.name ?? thread.preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    model: thread.modelId,
    modelReasoningEffort: thread.effort,
    source: "appServer",
    activeTurnId: thread.activeTurnId,
  };
}

function toThreadResponse(thread: StoredThread) {
  return {
    id: thread.id,
    cwd: thread.cwd,
    preview: thread.name ?? thread.preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    activeTurnId: thread.activeTurnId,
    source: "appServer",
    model: thread.modelId,
    modelReasoningEffort: thread.effort,
    turns: thread.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      createdAt: turn.createdAt,
      completedAt: turn.completedAt,
      items: turn.items,
      errorMessage: turn.errorMessage,
    })),
    tokenUsage: thread.tokenUsage,
  };
}

function sandboxModeForAccess(accessMode: unknown): ThreadOptions["sandboxMode"] {
  switch (accessMode) {
    case "read-only":
      return "read-only";
    case "full-access":
      return "danger-full-access";
    default:
      return "workspace-write";
  }
}

function diffSuffix(next: string, previous: string) {
  if (!previous) {
    return next;
  }
  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }
  return next;
}

function normalizeRootPath(value: string) {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function extractJsonValue(raw: string) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as JsonRecord;
  } catch {
    return null;
  }
}

function sanitizeRunWorktreeName(value: string) {
  const normalized = value.trim().toLowerCase();
  let cleaned = "";
  let previousDash = false;
  for (const character of normalized) {
    if (
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9") ||
      character === "/"
    ) {
      cleaned += character;
      previousDash = false;
      continue;
    }
    if (character === "-" || character === "_" || /\s/.test(character)) {
      if (!previousDash) {
        cleaned += "-";
        previousDash = true;
      }
    }
  }
  while (cleaned.endsWith("-") || cleaned.endsWith("/")) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

export function buildRunMetadataPrompt(prompt: string) {
  return (
    "You create concise run metadata for a coding task.\n" +
    "Return ONLY a JSON object with keys:\n" +
    "- title: short, clear, 3-7 words, Title Case\n" +
    "- worktreeName: lower-case, kebab-case slug prefixed with one of: " +
    "feat/, fix/, chore/, test/, docs/, refactor/, perf/, build/, ci/, style/.\n\n" +
    "Choose fix/ when the task is a bug fix, error, regression, crash, or cleanup. " +
    "Use the closest match for chores/tests/docs/refactors/perf/build/ci/style. " +
    "Otherwise use feat/.\n\n" +
    "Examples:\n" +
    '{"title":"Fix Login Redirect Loop","worktreeName":"fix/login-redirect-loop"}\n' +
    '{"title":"Add Workspace Home View","worktreeName":"feat/workspace-home"}\n' +
    '{"title":"Update Lint Config","worktreeName":"chore/update-lint-config"}\n' +
    '{"title":"Add Coverage Tests","worktreeName":"test/add-coverage-tests"}\n\n' +
    `Task:\n${prompt}`
  );
}

export function parseRunMetadataValue(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("No metadata was generated.");
  }
  const parsed = extractJsonValue(trimmed);
  if (!parsed) {
    throw new Error("Failed to parse metadata JSON.");
  }
  const title = trimString(parsed.title);
  if (!title) {
    throw new Error("Missing title in metadata.");
  }
  const worktreeName = sanitizeRunWorktreeName(
    trimString(parsed.worktreeName) || trimString(parsed.worktree_name),
  );
  if (!worktreeName) {
    throw new Error("Missing worktree name in metadata.");
  }
  return {
    title,
    worktreeName,
  };
}

function isInlineImageUrl(image: string) {
  return (
    image.startsWith("data:") ||
    image.startsWith("http://") ||
    image.startsWith("https://")
  );
}

export function buildAppServerUserInputItems(
  text: string,
  images: string[] = [],
  appMentions?: unknown,
) {
  const input: JsonRecord[] = [];
  const trimmedText = text.trim();
  if (trimmedText) {
    input.push({
      type: "text",
      text: trimmedText,
      text_elements: [],
    });
  }
  for (const image of images) {
    const trimmed = image.trim();
    if (!trimmed) {
      continue;
    }
    if (isInlineImageUrl(trimmed)) {
      input.push({ type: "image", url: trimmed });
      continue;
    }
    input.push({ type: "localImage", path: trimmed });
  }
  if (Array.isArray(appMentions)) {
    const seenPaths = new Set<string>();
    for (const rawMention of appMentions) {
      if (!rawMention || typeof rawMention !== "object") {
        throw new Error("Invalid app mention payload.");
      }
      const mention = rawMention as Record<string, unknown>;
      const name = trimString(mention.name);
      const mentionPath = trimString(mention.path);
      if (!name || !mentionPath || !mentionPath.startsWith("app://")) {
        throw new Error("Invalid app mention payload.");
      }
      if (seenPaths.has(mentionPath)) {
        continue;
      }
      seenPaths.add(mentionPath);
      input.push({
        type: "mention",
        name,
        path: mentionPath,
      });
    }
  }
  if (input.length === 0) {
    throw new Error("Empty user message.");
  }
  return input;
}

function appServerClientVersion() {
  const packageVersion = process.env.npm_package_version?.trim();
  return packageVersion || "0.0.0";
}

function buildAppServerInitializeParams() {
  return {
    clientInfo: {
      name: "codex_monitor_web",
      title: "Codex Monitor Web",
      version: appServerClientVersion(),
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

function appServerTurnStatus(value: unknown): StoredTurn["status"] {
  const normalized = trimString(value).toLowerCase();
  switch (normalized) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "active";
  }
}

function buildStoredTurnFromAppServerThread(
  threadId: string,
  threadCreatedAt: number,
  threadUpdatedAt: number,
  rawTurn: Record<string, unknown>,
  index: number,
  existing?: StoredTurn,
): StoredTurn {
  const turnId = trimString(rawTurn.id) || `${threadId}:turn-${index + 1}`;
  const status = appServerTurnStatus(rawTurn.status);
  const rawItems = Array.isArray(rawTurn.items)
    ? (rawTurn.items as Record<string, unknown>[])
    : [];
  const items = rawItems.map((item, itemIndex) => ({
    ...item,
    id: trimString(item.id) || `${turnId}:item-${itemIndex + 1}`,
  }));
  return {
    id: turnId,
    createdAt: existing?.createdAt ?? threadCreatedAt + index,
    completedAt:
      status === "completed" || status === "failed" || status === "cancelled"
        ? (existing?.completedAt ?? threadUpdatedAt)
        : null,
    status,
    errorMessage: toNullableString(rawTurn.error) ?? existing?.errorMessage ?? null,
    items,
  };
}

function toStoredItemId(turnId: string, itemId: string) {
  return `${turnId}:${itemId}`;
}

function mapSdkItem(turnId: string, item: ThreadItem): StoredThreadItem {
  const storedId = toStoredItemId(turnId, item.id);
  switch (item.type) {
    case "agent_message":
      return {
        id: storedId,
        type: "agentMessage",
        text: item.text,
      };
    case "reasoning":
      return {
        id: storedId,
        type: "reasoning",
        summary: item.text,
        content: item.text,
      };
    case "command_execution":
      return {
        id: storedId,
        type: "commandExecution",
        command: [item.command],
        aggregatedOutput: item.aggregated_output,
        status: item.status,
      };
    case "file_change":
      return {
        id: storedId,
        type: "fileChange",
        status: item.status,
        changes: item.changes.map((change) => ({
          path: change.path,
          kind: change.kind,
        })),
      };
    case "mcp_tool_call":
      return {
        id: storedId,
        type: "mcpToolCall",
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        status: item.status,
        result: item.result ? JSON.stringify(item.result) : "",
        error: item.error?.message ?? "",
      };
    case "web_search":
      return {
        id: storedId,
        type: "webSearch",
        query: item.query,
        status: "completed",
      };
    case "todo_list":
      return {
        id: storedId,
        type: "plan",
        status: "completed",
        text: item.items.map((entry) => `${entry.completed ? "[x]" : "[ ]"} ${entry.text}`).join("\n"),
      };
    case "error":
      return {
        id: storedId,
        type: "commandExecution",
        command: ["error"],
        aggregatedOutput: item.message,
        status: "failed",
      };
    default:
      return {
        id: storedId,
        type: "commandExecution",
        command: ["unknown"],
        aggregatedOutput: JSON.stringify(item),
        status: "completed",
      };
  }
}

function normalizeReasoningEffort(
  value: string | null | undefined,
): ThreadOptions["modelReasoningEffort"] {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return undefined;
  }
}

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toNullableString(value: unknown) {
  const trimmed = trimString(value);
  return trimmed.length > 0 ? trimmed : null;
}

function defaultWorkspaceSettings() {
  return {
    sidebarCollapsed: false,
    sortOrder: null,
    groupId: null,
    cloneSourceWorkspaceId: null,
    gitRoot: null,
    launchScript: null,
    launchScripts: null,
    worktreeSetupScript: null,
  };
}

function isWithinWorkspace(rootPath: string, candidatePath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readTextSnapshot(
  workspacePath: string,
  relativePath: string,
): Promise<FileSnapshot | null> {
  const absolutePath = path.resolve(workspacePath, relativePath);
  if (!isWithinWorkspace(workspacePath, absolutePath)) {
    return null;
  }
  try {
    const content = await fs.readFile(absolutePath, "utf8");
    return {
      path: relativePath,
      content,
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code === "ENOENT") {
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

function slugifyAgentName(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

function buildAgentTemplateContent(
  model: string | null,
  reasoningEffort: string | null,
  developerInstructions: string | null,
) {
  const lines = ["# Agent-specific overrides"];
  lines.push(`model = ${JSON.stringify(model ?? "gpt-5-codex")}`);
  if (reasoningEffort) {
    lines.push(`model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`);
  }
  if (developerInstructions) {
    lines.push(`developer_instructions = ${JSON.stringify(developerInstructions)}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function parseTopLevelTomlString(content: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*["']([^"']+)["']\\s*$`, "m"),
  );
  return match?.[1] ?? null;
}

async function runCommand(command: string, args: string[], cwd: string) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = `${stderr || stdout || error.message}`.trim() || "Command failed.";
      reject(new Error(detail));
    });
  });
}

async function runGit(repoRoot: string, args: string[]) {
  return await runCommand("git", args, repoRoot);
}

async function tryRunGit(repoRoot: string, args: string[]) {
  try {
    return await runGit(repoRoot, args);
  } catch {
    return null;
  }
}

function normalizeGitPathForUi(filePath: string) {
  return filePath.replace(/\\/g, "/");
}

function worktreeSetupMarkerPath(dataDir: string, workspaceId: string) {
  return path.join(dataDir, "worktree-setup", `${workspaceId}.ran`);
}

function normalizeSetupScript(script: unknown) {
  const trimmed = trimString(script);
  return trimmed ? trimmed : null;
}

async function resolveGitRootFromPath(workspacePath: string) {
  const result = await runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
  return result.stdout.trim();
}

function parseNumstat(output: string) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [additionsRaw = "0", deletionsRaw = "0", ...pathParts] = line.split("\t");
    const filePath = normalizeGitPathForUi(pathParts.join("\t"));
    if (!filePath) {
      continue;
    }
    stats.set(filePath, {
      additions: Number.parseInt(additionsRaw, 10) || 0,
      deletions: Number.parseInt(deletionsRaw, 10) || 0,
    });
  }
  return stats;
}

async function countTextFileAdditions(absolutePath: string) {
  try {
    const content = await fs.readFile(absolutePath, "utf8");
    if (!content) {
      return 0;
    }
    return content.split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

async function scanGitRoots(root: string, depth: number) {
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
    const gitStat = await fs.stat(gitEntry).catch(() => null);
    if (gitStat) {
      roots.add(next.current);
      continue;
    }
    if (next.remainingDepth === 0) {
      continue;
    }
    const entries = await fs.readdir(next.current, { withFileTypes: true }).catch(() => []);
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

  return Array.from(roots).sort();
}

async function countEffectiveDirEntries(root: string) {
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

function validateBranchName(name: string) {
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

type ParsedStatusEntry = {
  path: string;
  indexStatus: string | null;
  worktreeStatus: string | null;
  untracked: boolean;
};

function parseStatusEntries(output: string) {
  const entries = output.split("\0").filter(Boolean);
  const parsed: ParsedStatusEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.startsWith("## ")) {
      continue;
    }
    const indexCode = entry[0] ?? " ";
    const worktreeCode = entry[1] ?? " ";
    let filePath = entry.slice(3);
    if ((indexCode === "R" || indexCode === "C" || worktreeCode === "R" || worktreeCode === "C") && entries[index + 1]) {
      filePath = entries[index + 1]!;
      index += 1;
    }
    const normalizedPath = normalizeGitPathForUi(filePath);
    if (!normalizedPath) {
      continue;
    }
    parsed.push({
      path: normalizedPath,
      indexStatus: indexCode === " " || indexCode === "?" ? null : indexCode,
      worktreeStatus: worktreeCode === " " || worktreeCode === "?" ? null : worktreeCode,
      untracked: indexCode === "?" || worktreeCode === "?",
    });
  }
  return parsed;
}

async function buildGitStatusSummary(workspacePath: string) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const [statusResult, branchResult, stagedStatsResult, unstagedStatsResult] = await Promise.all([
    runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--branch"]),
    tryRunGit(repoRoot, ["branch", "--show-current"]),
    runGit(repoRoot, ["diff", "--cached", "--numstat", "--"]),
    runGit(repoRoot, ["diff", "--numstat", "--"]),
  ]);
  const branchName = branchResult?.stdout.trim() || "unknown";
  const stagedStats = parseNumstat(stagedStatsResult.stdout);
  const unstagedStats = parseNumstat(unstagedStatsResult.stdout);
  const entries = parseStatusEntries(statusResult.stdout);

  const files: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  const stagedFiles: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  const unstagedFiles: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const entry of entries) {
    const staged = stagedStats.get(entry.path) ?? { additions: 0, deletions: 0 };
    const unstaged = unstagedStats.get(entry.path) ?? { additions: 0, deletions: 0 };
    if (entry.untracked && !entry.worktreeStatus) {
      entry.worktreeStatus = "A";
    }
    if (entry.untracked) {
      unstaged.additions = await countTextFileAdditions(path.join(repoRoot, entry.path));
    }
    if (entry.indexStatus) {
      stagedFiles.push({
        path: entry.path,
        status: entry.indexStatus,
        additions: staged.additions,
        deletions: staged.deletions,
      });
      totalAdditions += staged.additions;
      totalDeletions += staged.deletions;
    }
    if (entry.worktreeStatus || entry.untracked) {
      unstagedFiles.push({
        path: entry.path,
        status: entry.worktreeStatus || "A",
        additions: unstaged.additions,
        deletions: unstaged.deletions,
      });
      totalAdditions += unstaged.additions;
      totalDeletions += unstaged.deletions;
    }
    files.push({
      path: entry.path,
      status: entry.worktreeStatus || entry.indexStatus || "A",
      additions: staged.additions + unstaged.additions,
      deletions: staged.deletions + unstaged.deletions,
    });
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

async function buildWorkingTreeDiffs(workspacePath: string) {
  const status = await buildGitStatusSummary(workspacePath);
  const diffs = await Promise.all(
    status.files.map(async (file) => {
      const isUntracked = !status.stagedFiles.some((entry) => entry.path === file.path) &&
        status.unstagedFiles.some((entry) => entry.path === file.path && entry.status === "A");
      let diff = "";
      if (isUntracked) {
        const snapshot = await readTextSnapshot(status.repoRoot, file.path);
        diff = buildUnifiedFileDiff(file.path, "", snapshot?.content ?? "");
      } else {
        diff = (await runGit(status.repoRoot, ["diff", "--binary", "HEAD", "--", file.path])).stdout;
      }
      return {
        path: file.path,
        diff,
      };
    }),
  );
  return diffs;
}

function parseGitLogEntries(output: string) {
  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = "", summary = "", author = "", timestamp = "0"] = entry.split("\x1f");
      return {
        sha,
        summary,
        author,
        timestamp: (Number.parseInt(timestamp, 10) || 0) * 1000,
      };
    })
    .filter((entry) => entry.sha);
}

async function getPreferredRemote(repoRoot: string) {
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

async function getGitLogSummary(workspacePath: string, limit: number) {
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

async function getCommitDiffEntries(workspacePath: string, sha: string) {
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

async function listLocalGitBranches(workspacePath: string) {
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
        lastCommit: (Number.parseInt(lastCommit, 10) || 0) * 1000,
      };
    })
    .filter((entry) => entry.name);
}

function nullDevicePath() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

async function runGitNoIndexDiff(repoRoot: string, relativePath: string) {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--binary", "--no-color", "--no-index", "--", nullDevicePath(), relativePath],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const message = `${stderr || stdout || error?.message || ""}`.trim();
        if (!error) {
          resolve(stdout);
          return;
        }
        const code =
          error && typeof error === "object" && "code" in error
            ? Number((error as { code?: unknown }).code)
            : NaN;
        if (code === 1) {
          resolve(stdout);
          return;
        }
        reject(new Error(message || "Git diff failed."));
      },
    );
  });
}

async function applyGitPatch(repoRoot: string, patch: string) {
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "git",
      ["apply", "--3way", "--whitespace=nowarn", "-"],
      {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      reject(new Error(`Failed to run git: ${error.message}`));
    });
    child.stdin.end(patch);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = `${stderr || stdout}`.trim() || "Git apply failed.";
      if (detail.includes("Applied patch to")) {
        if (detail.includes("with conflicts")) {
          reject(
            new Error(
              "Applied with conflicts. Resolve conflicts in the parent repo before retrying.",
            ),
          );
          return;
        }
        reject(
          new Error("Patch applied partially. Resolve changes in the parent repo before retrying."),
        );
        return;
      }
      reject(new Error(detail));
    });
  });
}

function parseFrontmatter(content: string) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {
      description: null,
      argumentHint: null,
      body: content,
    };
  }
  let index = 1;
  let description: string | null = null;
  let argumentHint: string | null = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line === "---") {
      index += 1;
      break;
    }
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) {
      continue;
    }
    const key = rawKey.trim().toLowerCase();
    const rawValue = rest.join(":").trim().replace(/^['"]|['"]$/g, "");
    if (key === "description") {
      description = rawValue || null;
    }
    if (key === "argument-hint" || key === "argument_hint") {
      argumentHint = rawValue || null;
    }
  }
  return {
    description,
    argumentHint,
    body: lines.slice(index).join("\n"),
  };
}

function buildPromptContent(
  description: string | null,
  argumentHint: string | null,
  body: string,
) {
  if (!description && !argumentHint) {
    return body;
  }
  const lines = ["---"];
  if (description) {
    lines.push(`description: ${JSON.stringify(description)}`);
  }
  if (argumentHint) {
    lines.push(`argument-hint: ${JSON.stringify(argumentHint)}`);
  }
  lines.push("---");
  lines.push(body);
  return `${lines.join("\n")}\n`;
}

async function cloneRepository(url: string, destinationPath: string) {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["clone", url, destinationPath], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git clone exited with code ${code ?? -1}`));
    });
  });
}

export class CodexCompanionServer {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly connectedWorkspaceIds = new Set<string>();
  private readonly threadsById = new Map<string, StoredThread>();
  private readonly workspacesById = new Map<string, StoredWorkspace>();

  constructor(
    private readonly storage: CompanionStorage,
    private readonly broadcast: BroadcastFn,
  ) {}

  async initialize() {
    const [workspaces, threads] = await Promise.all([
      this.storage.readWorkspaces(),
      this.storage.readThreads(),
    ]);
    this.workspacesById.clear();
    this.threadsById.clear();
    workspaces.forEach((workspace) => {
      this.workspacesById.set(workspace.id, workspace);
    });
    threads.forEach((thread) => {
      this.threadsById.set(thread.id, thread);
    });
  }

  private get dataDir() {
    return path.dirname(this.storage.settingsPath);
  }

  private agentsStatePath() {
    return path.join(this.dataDir, "agents.json");
  }

  private async readAgentsState(): Promise<AgentsState> {
    try {
      const raw = await fs.readFile(this.agentsStatePath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<AgentsState>;
      return {
        multiAgentEnabled: Boolean(parsed.multiAgentEnabled),
        maxThreads:
          typeof parsed.maxThreads === "number"
            ? parsed.maxThreads
            : DEFAULT_AGENT_MAX_THREADS,
        maxDepth:
          typeof parsed.maxDepth === "number"
            ? parsed.maxDepth
            : DEFAULT_AGENT_MAX_DEPTH,
        agents: Array.isArray(parsed.agents)
          ? parsed.agents.map((agent) => ({
              name: trimString(agent.name),
              description: toNullableString(agent.description),
              developerInstructions: toNullableString(agent.developerInstructions),
              configFile: trimString(agent.configFile),
              resolvedPath: trimString(agent.resolvedPath),
              managedByApp: agent.managedByApp !== false,
              fileExists: Boolean(agent.fileExists),
            }))
          : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const configPath = this.storage.globalConfigPath();
    let multiAgentEnabled = false;
    try {
      const config = await fs.readFile(configPath, "utf8");
      multiAgentEnabled = /^\s*multi_agent\s*=\s*true\s*$/m.test(config);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    return {
      multiAgentEnabled,
      maxThreads: DEFAULT_AGENT_MAX_THREADS,
      maxDepth: DEFAULT_AGENT_MAX_DEPTH,
      agents: [],
    };
  }

  private async writeAgentsState(state: AgentsState) {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.agentsStatePath(), JSON.stringify(state, null, 2));
    return state;
  }

  private agentConfigRelativePath(agentName: string) {
    return path.join("agents", `${slugifyAgentName(agentName)}.toml`);
  }

  private agentConfigAbsolutePath(relativePath: string) {
    return path.join(this.storage.codexHome, relativePath);
  }

  private async formatAgentsSettings(state?: AgentsState) {
    const current = state ?? (await this.readAgentsState());
    const agents = await Promise.all(
      current.agents.map(async (agent) => {
        const resolvedPath = this.agentConfigAbsolutePath(agent.configFile);
        const fileExists = await fs
          .stat(resolvedPath)
          .then((stat) => stat.isFile())
          .catch(() => false);
        return {
          ...agent,
          resolvedPath,
          fileExists,
        };
      }),
    );
    return {
      configPath: this.storage.globalConfigPath(),
      multiAgentEnabled: current.multiAgentEnabled,
      maxThreads: current.maxThreads,
      maxDepth: current.maxDepth,
      agents: agents.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  private async readPromptEntries(workspaceId: string): Promise<PromptEntry[]> {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found.");
    }
    const promptRoots: Array<{ dir: string; scope: "workspace" | "global" }> = [
      { dir: this.storage.workspacePromptsDir(workspace.id), scope: "workspace" },
      { dir: this.storage.globalPromptsDir(), scope: "global" },
    ];
    const results: PromptEntry[] = [];

    for (const root of promptRoots) {
      await fs.mkdir(root.dir, { recursive: true });
      const entries = await fs.readdir(root.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
          continue;
        }
        const promptPath = path.join(root.dir, entry.name);
        const content = await fs.readFile(promptPath, "utf8");
        const parsed = parseFrontmatter(content);
        results.push({
          name: entry.name.replace(/\.md$/i, ""),
          path: promptPath,
          description: parsed.description,
          argumentHint: parsed.argumentHint,
          content: parsed.body,
          scope: root.scope,
        });
      }
    }

    return results.sort((left, right) => left.name.localeCompare(right.name));
  }

  private async ensurePromptPathAllowed(workspaceId: string, promptPath: string) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found.");
    }
    const allowedRoots = [
      path.resolve(this.storage.workspacePromptsDir(workspaceId)),
      path.resolve(this.storage.globalPromptsDir()),
    ];
    const resolved = path.resolve(promptPath);
    if (!allowedRoots.some((root) => resolved.startsWith(root))) {
      throw new Error("Prompt path is not within allowed directories.");
    }
  }

  private promptDirectoryForScope(scope: string, workspaceId: string) {
    if (scope === "workspace") {
      return this.storage.workspacePromptsDir(workspaceId);
    }
    if (scope === "global") {
      return this.storage.globalPromptsDir();
    }
    throw new Error("Invalid scope.");
  }

  private async listWorkspaceFilesRecursive(root: string, current = root) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listWorkspaceFilesRecursive(root, absolute)));
        continue;
      }
      if (entry.isFile()) {
        files.push(path.relative(root, absolute).replace(/\\/g, "/"));
      }
    }
    return files;
  }

  private async readWorkspaceFileContents(workspaceId: string, relativePath: string) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found.");
    }
    const absolute = path.resolve(workspace.path, relativePath);
    if (!absolute.startsWith(path.resolve(workspace.path))) {
      throw new Error("Invalid workspace file path.");
    }
    const content = await fs.readFile(absolute, "utf8");
    return {
      content,
      truncated: false,
    };
  }

  private async readImageAsDataUrl(imagePath: string) {
    const buffer = await fs.readFile(imagePath);
    const extension = path.extname(imagePath).slice(1).toLowerCase();
    const subtype = extension === "jpg" ? "jpeg" : extension || "png";
    return `data:image/${subtype};base64,${buffer.toString("base64")}`;
  }

  private async updateWorkspaceSettingsRecord(
    workspaceId: string,
    settings: JsonRecord,
  ) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found.");
    }
    workspace.settings = {
      ...defaultWorkspaceSettings(),
      ...workspace.settings,
      ...settings,
    };
    await this.persistWorkspaces();
    return {
      ...workspace,
      connected: this.connectedWorkspaceIds.has(workspace.id),
    };
  }

  private async persistWorkspaces() {
    await this.storage.writeWorkspaces(Array.from(this.workspacesById.values()));
  }

  private async persistThreads() {
    await this.storage.writeThreads(Array.from(this.threadsById.values()));
  }

  private emit(workspaceId: string, method: string, params: JsonRecord = {}, id?: string | number) {
    this.broadcast({
      event: "app-server-event",
      payload: buildAppServerEvent(workspaceId, method, params, id),
    });
  }

  private getWorkspace(workspaceId: string) {
    return this.workspacesById.get(workspaceId) ?? null;
  }

  private getThread(threadId: string) {
    return this.threadsById.get(threadId) ?? null;
  }

  private findThreadBySdkThreadId(threadId: string) {
    return (
      Array.from(this.threadsById.values()).find(
        (entry) => entry.sdkThreadId === threadId || entry.id === threadId,
      ) ?? null
    );
  }

  private resolveWorkspaceIdForCwd(cwd: string) {
    const normalizedCwd = normalizeRootPath(cwd);
    if (!normalizedCwd) {
      return null;
    }
    const matches = Array.from(this.workspacesById.values())
      .map((workspace) => ({
        workspaceId: workspace.id,
        root: normalizeRootPath(workspace.path),
      }))
      .filter(({ root }) => {
        if (!root) {
          return false;
        }
        return (
          root === normalizedCwd ||
          (normalizedCwd.length > root.length &&
            normalizedCwd.startsWith(root) &&
            normalizedCwd.charCodeAt(root.length) === 47)
        );
      })
      .sort((left, right) => right.root.length - left.root.length);
    return matches[0]?.workspaceId ?? null;
  }

  private codexCommand(settings: JsonRecord) {
    const configured = trimString(settings.codexBin);
    return configured || "codex";
  }

  private async callCodexAppServer(method: string, params: JsonRecord, settings: JsonRecord) {
    const codexCommand = this.codexCommand(settings);
    return await new Promise<JsonRecord>((resolve, reject) => {
      const child = spawn(codexCommand, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      let settled = false;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const initializeId = 1;
      const requestId = 2;

      const finalize = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.kill();
        callback();
      };

      const fail = (message: string) =>
        finalize(() => {
          reject(new Error(message));
        });

      const send = (message: JsonRecord) => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };

      const timer = setTimeout(() => {
        fail(
          `${method} timed out while talking to codex app-server${
            stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ""
          }`,
        );
      }, method === "initialize" ? APP_SERVER_INIT_TIMEOUT_MS : APP_SERVER_REQUEST_TIMEOUT_MS);

      child.once("error", (error) => {
        fail(`Failed to start codex app-server: ${error.message}`);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk;
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (!line) {
            newlineIndex = stdoutBuffer.indexOf("\n");
            continue;
          }
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch (error) {
            fail(
              `Invalid JSON from codex app-server: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return;
          }
          if (message.id === initializeId) {
            if (message.error && typeof message.error === "object") {
              const appServerError = message.error as { message?: unknown };
              fail(
                `codex app-server initialize failed: ${trimString(appServerError.message) || "unknown error"}`,
              );
              return;
            }
            send({ method: "initialized", params: {} });
            send({ id: requestId, method, params });
            continue;
          }
          if (message.id === requestId) {
            if (message.error && typeof message.error === "object") {
              const appServerError = message.error as { message?: unknown };
              fail(
                `codex app-server ${method} failed: ${trimString(appServerError.message) || "unknown error"}`,
              );
              return;
            }
            finalize(() => {
              resolve((message.result ?? {}) as JsonRecord);
            });
            return;
          }
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });

      send({
        id: initializeId,
        method: "initialize",
        params: buildAppServerInitializeParams(),
      });
    });
  }

  private buildStoredThreadFromAppServer(
    workspaceId: string,
    rawThread: Record<string, unknown>,
    existing?: StoredThread | null,
  ): StoredThread {
    const threadId = trimString(rawThread.id);
    const createdAt = Number(rawThread.createdAt ?? rawThread.created_at ?? Date.now());
    const updatedAt = Number(rawThread.updatedAt ?? rawThread.updated_at ?? createdAt);
    const rawTurns = Array.isArray(rawThread.turns)
      ? (rawThread.turns as Record<string, unknown>[])
      : [];
    const turns = rawTurns.map((turn, index) =>
      buildStoredTurnFromAppServerThread(
        threadId,
        createdAt,
        updatedAt,
        turn,
        index,
        existing?.turns.find((entry) => entry.id === trimString(turn.id)),
      ),
    );
    const statusValue =
      typeof rawThread.status === "object" && rawThread.status
        ? trimString((rawThread.status as Record<string, unknown>).type)
        : trimString(rawThread.status);
    const activeTurnId =
      statusValue === "active" ? turns[turns.length - 1]?.id ?? null : null;
    const appServerName = toNullableString(rawThread.name);
    return {
      id: threadId,
      workspaceId,
      sdkThreadId: threadId,
      cwd: trimString(rawThread.cwd) || this.getWorkspace(workspaceId)?.path || "",
      createdAt,
      updatedAt,
      archivedAt: null,
      name: existing?.name ?? appServerName,
      preview: trimString(rawThread.preview) || existing?.preview || "New Agent",
      activeTurnId,
      turns,
      modelId: existing?.modelId ?? null,
      effort: existing?.effort ?? null,
      tokenUsage: existing?.tokenUsage ?? null,
    };
  }

  private async listThreadsFromCodexAppServer(
    cursor: string | null,
    limit: number | null,
    sortKey: "created_at" | "updated_at",
  ) {
    const settings = await this.storage.readSettings();
    return await this.callCodexAppServer(
      "thread/list",
      {
        cursor,
        limit,
        sortKey,
        sourceKinds: APP_SERVER_SOURCE_KINDS,
      },
      settings,
    );
  }

  private async resumeThreadFromCodexAppServer(threadId: string) {
    const settings = await this.storage.readSettings();
    return await this.callCodexAppServer(
      "thread/resume",
      {
        threadId,
      },
      settings,
    );
  }

  private resolveAppServerThreadId(thread: StoredThread) {
    return thread.sdkThreadId || thread.id;
  }

  private async syncStoredThreadFromAppServer(
    workspaceId: string,
    threadId: string,
    existing?: StoredThread | null,
  ) {
    const resumed = await this.resumeThreadFromCodexAppServer(threadId);
    const rawThread =
      resumed.thread && typeof resumed.thread === "object"
        ? (resumed.thread as Record<string, unknown>)
        : resumed;
    const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread, existing);
    this.threadsById.set(stored.id, stored);
    await this.persistThreads();
    return stored;
  }

  private async generateRunMetadataForWorkspace(workspace: StoredWorkspace, prompt: string) {
    const cleanedPrompt = prompt.trim();
    if (!cleanedPrompt) {
      throw new Error("Prompt is required.");
    }
    const settings = await this.storage.readSettings();
    const codex = this.buildCodex(settings);
    const thread = codex.startThread({
      workingDirectory: workspace.path,
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    });
    const result = await thread.run(buildRunMetadataPrompt(cleanedPrompt));
    return parseRunMetadataValue(result.finalResponse);
  }

  private buildCodex(settings: JsonRecord) {
    const codexBin = typeof settings.codexBin === "string" ? settings.codexBin : null;
    return new Codex({
      codexPathOverride: codexBin ?? undefined,
    });
  }

  private buildThreadOptions(
    workspace: StoredWorkspace,
    options: {
      model?: string | null;
      effort?: string | null;
      accessMode?: string | null;
    },
  ): ThreadOptions {
    return {
      workingDirectory: workspace.path,
      approvalPolicy: "on-request",
      sandboxMode: sandboxModeForAccess(options.accessMode),
      model: options.model ?? undefined,
      modelReasoningEffort: normalizeReasoningEffort(options.effort),
    };
  }

  private loadThreadHandle(
    settings: JsonRecord,
    workspace: StoredWorkspace,
    thread: StoredThread,
    options: {
      model?: string | null;
      effort?: string | null;
      accessMode?: string | null;
    },
  ): Thread {
    const codex = this.buildCodex(settings);
    const threadOptions = this.buildThreadOptions(workspace, options);
    if (thread.sdkThreadId) {
      return codex.resumeThread(thread.sdkThreadId, threadOptions);
    }
    return codex.startThread(threadOptions);
  }

  private appendItemToTurn(thread: StoredThread, turnId: string, item: StoredThreadItem) {
    const turn = thread.turns.find((entry) => entry.id === turnId);
    if (!turn) {
      return;
    }
    const existingIndex = turn.items.findIndex((entry) => entry.id === item.id);
    if (existingIndex >= 0) {
      turn.items[existingIndex] = item;
      return;
    }
    turn.items.push(item);
  }

  private async captureFileChangeSnapshots(
    workspace: StoredWorkspace,
    item: Extract<ThreadItem, { type: "file_change" }>,
  ) {
    const snapshots = await Promise.all(
      item.changes.map(async (change) => {
        const snapshot = await readTextSnapshot(workspace.path, change.path);
        if (!snapshot) {
          return null;
        }
        return snapshot;
      }),
    );
    return snapshots.filter((entry): entry is FileSnapshot => Boolean(entry));
  }

  private async attachFileChangeDiffs(
    workspace: StoredWorkspace,
    item: StoredThreadItem,
    snapshots: FileSnapshot[],
  ) {
    if (item.type !== "fileChange") {
      return item;
    }
    const changes = Array.isArray(item.changes)
      ? (item.changes as Array<Record<string, unknown>>)
      : [];
    const enrichedChanges = await Promise.all(
      changes.map(async (change) => {
        const relativePath = String(change.path ?? "");
        if (!relativePath) {
          return change;
        }
        const beforeSnapshot = snapshots.find((entry) => entry.path === relativePath) ?? null;
        const afterSnapshot = await readTextSnapshot(workspace.path, relativePath);
        const beforeContent = beforeSnapshot?.content ?? "";
        const afterContent = afterSnapshot?.content ?? "";
        const diff = buildUnifiedFileDiff(relativePath, beforeContent, afterContent);
        if (!diff) {
          return change;
        }
        return {
          ...change,
          diff,
        };
      }),
    );
    return {
      ...item,
      changes: enrichedChanges,
    };
  }

  private markThreadActive(workspaceId: string, threadId: string, turnId: string) {
    this.emit(workspaceId, "turn/started", {
      threadId,
      turn: {
        id: turnId,
        threadId,
      },
    });
    this.emit(workspaceId, "thread/status/changed", {
      threadId,
      status: { type: "active" },
    });
  }

  private markThreadIdle(workspaceId: string, thread: StoredThread, turnId: string) {
    this.emit(workspaceId, "turn/completed", {
      threadId: thread.id,
      turn: {
        id: turnId,
        threadId: thread.id,
      },
    });
    this.emit(workspaceId, "thread/status/changed", {
      threadId: thread.id,
      status: { type: "idle" },
    });
  }

  private async processThreadEvents(
    workspace: StoredWorkspace,
    thread: StoredThread,
    turnId: string,
    events: AsyncGenerator<ThreadEvent>,
  ) {
    const itemSnapshot = new Map<string, StoredThreadItem>();
    const fileChangeSnapshots = new Map<string, FileSnapshot[]>();
    try {
      for await (const event of events) {
        switch (event.type) {
          case "thread.started":
            thread.sdkThreadId = event.thread_id;
            await this.persistThreads();
            break;
          case "item.started": {
            if (event.item.type === "file_change") {
              const snapshots = await this.captureFileChangeSnapshots(
                workspace,
                event.item,
              );
              fileChangeSnapshots.set(event.item.id, snapshots);
            }
            const mapped = mapSdkItem(turnId, event.item);
            itemSnapshot.set(event.item.id, mapped);
            this.appendItemToTurn(thread, turnId, mapped);
            this.emit(workspace.id, "item/started", {
              threadId: thread.id,
              item: mapped,
            });
            await this.persistThreads();
            break;
          }
          case "item.updated": {
            const previous = itemSnapshot.get(event.item.id);
            const mapped = mapSdkItem(turnId, event.item);
            itemSnapshot.set(event.item.id, mapped);
            this.appendItemToTurn(thread, turnId, mapped);
            if (mapped.type === "agentMessage") {
              const nextText = String(mapped.text ?? "");
              const previousText =
                previous && previous.type === "agentMessage"
                  ? String(previous.text ?? "")
                  : "";
              const delta = diffSuffix(nextText, previousText);
              if (delta) {
                this.emit(workspace.id, "item/agentMessage/delta", {
                  threadId: thread.id,
                  itemId: mapped.id,
                  delta,
                });
              }
            }
            if (mapped.type === "commandExecution") {
              const nextOutput = String(mapped.aggregatedOutput ?? "");
              const previousOutput =
                previous && previous.type === "commandExecution"
                  ? String(previous.aggregatedOutput ?? "")
                  : "";
              const delta = diffSuffix(nextOutput, previousOutput);
              if (delta) {
                this.emit(workspace.id, "item/commandExecution/outputDelta", {
                  threadId: thread.id,
                  itemId: mapped.id,
                  delta,
                });
              }
            }
            await this.persistThreads();
            break;
          }
          case "item.completed": {
            const baseMapped = mapSdkItem(turnId, event.item);
            const mapped =
              event.item.type === "file_change"
                ? await this.attachFileChangeDiffs(
                    workspace,
                    baseMapped,
                    fileChangeSnapshots.get(event.item.id) ?? [],
                  )
                : baseMapped;
            itemSnapshot.set(event.item.id, mapped);
            this.appendItemToTurn(thread, turnId, mapped);
            this.emit(workspace.id, "item/completed", {
              threadId: thread.id,
              item: mapped,
            });
            if (mapped.type === "fileChange") {
              const turnDiff = Array.isArray(mapped.changes)
                ? mapped.changes
                    .map((change) =>
                      typeof change === "object" && change && "diff" in change
                        ? String((change as { diff?: unknown }).diff ?? "")
                        : "",
                    )
                    .filter(Boolean)
                    .join("\n")
                : "";
              if (turnDiff) {
                this.emit(workspace.id, "turn/diff/updated", {
                  threadId: thread.id,
                  diff: turnDiff,
                });
              }
              fileChangeSnapshots.delete(event.item.id);
            }
            await this.persistThreads();
            break;
          }
          case "turn.completed": {
            const usage = totalsFromUsage(event.usage);
            const previousTotals = thread.tokenUsage?.total ?? usage;
            thread.tokenUsage = {
              total: {
                totalTokens: previousTotals.totalTokens + usage.totalTokens,
                inputTokens: previousTotals.inputTokens + usage.inputTokens,
                cachedInputTokens:
                  previousTotals.cachedInputTokens + usage.cachedInputTokens,
                outputTokens: previousTotals.outputTokens + usage.outputTokens,
                reasoningOutputTokens:
                  previousTotals.reasoningOutputTokens + usage.reasoningOutputTokens,
              },
              last: usage,
              modelContextWindow: null,
            };
            this.emit(workspace.id, "thread/tokenUsage/updated", {
              threadId: thread.id,
              tokenUsage: thread.tokenUsage,
            });
            break;
          }
          case "turn.failed":
            this.emit(workspace.id, "error", {
              threadId: thread.id,
              turn: {
                id: turnId,
                threadId: thread.id,
              },
              message: event.error.message,
              willRetry: false,
            });
            break;
          case "error":
            this.emit(workspace.id, "error", {
              threadId: thread.id,
              turn: {
                id: turnId,
                threadId: thread.id,
              },
              message: event.message,
              willRetry: false,
            });
            break;
          case "turn.started":
            break;
        }
      }
      const turn = thread.turns.find((entry) => entry.id === turnId);
      if (turn) {
        turn.status = "completed";
        turn.completedAt = Date.now();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = this.activeRuns.get(thread.id)?.abortController.signal.aborted ?? false;
      const turn = thread.turns.find((entry) => entry.id === turnId);
      if (turn) {
        turn.status = cancelled ? "cancelled" : "failed";
        turn.completedAt = Date.now();
        turn.errorMessage = message;
      }
      this.emit(workspace.id, "error", {
        threadId: thread.id,
        turn: {
          id: turnId,
          threadId: thread.id,
        },
        message,
        willRetry: false,
      });
    } finally {
      thread.activeTurnId = null;
      thread.updatedAt = Date.now();
      this.activeRuns.delete(thread.id);
      this.markThreadIdle(workspace.id, thread, turnId);
      await this.persistThreads();
    }
  }

  async handleRpc(
    method: string,
    params: JsonRecord,
  ): Promise<unknown | RpcErrorShape> {
    switch (method) {
      case "get_app_settings":
        return this.storage.readSettings();
      case "update_app_settings": {
        const settings =
          params.settings && typeof params.settings === "object"
            ? (params.settings as JsonRecord)
            : {};
        return this.storage.writeSettings(settings);
      }
      case "get_codex_config_path":
        return this.storage.globalConfigPath();
      case "list_workspaces":
        return Array.from(this.workspacesById.values()).map((workspace) => ({
          ...workspace,
          connected: this.connectedWorkspaceIds.has(workspace.id),
        }));
      case "is_workspace_path_dir": {
        const targetPath = String(params.path ?? "");
        if (!targetPath) {
          return false;
        }
        try {
          const stat = await fs.stat(targetPath);
          return stat.isDirectory();
        } catch {
          return false;
        }
      }
      case "add_workspace": {
        const targetPath = String(params.path ?? "");
        const stat = await fs.stat(targetPath);
        if (!stat.isDirectory()) {
          return notFound("Workspace path is not a directory.");
        }
        const existing = Array.from(this.workspacesById.values()).find(
          (workspace) => path.resolve(workspace.path) === path.resolve(targetPath),
        );
        if (existing) {
          return {
            ...existing,
            connected: this.connectedWorkspaceIds.has(existing.id),
          };
        }
        const workspace: StoredWorkspace = {
          id: `ws-${randomUUID()}`,
          name: path.basename(targetPath),
          path: targetPath,
          kind: "main",
          parentId: null,
          worktree: null,
          settings: defaultWorkspaceSettings(),
        };
        this.workspacesById.set(workspace.id, workspace);
        await this.persistWorkspaces();
        return { ...workspace, connected: false };
      }
      case "add_workspace_from_git_url": {
        const url = String(params.url ?? "");
        const destinationPath = String(params.destinationPath ?? "");
        const targetFolderName =
          params.targetFolderName == null ? null : String(params.targetFolderName);
        if (!url || !destinationPath) {
          return notFound("Git URL and destination path are required.");
        }
        const folderName =
          targetFolderName ??
          url.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.git$/, "") ??
          "workspace";
        const targetPath = path.join(destinationPath, folderName);
        await cloneRepository(url, targetPath);
        return this.handleRpc("add_workspace", { path: targetPath });
      }
      case "add_clone": {
        const sourceWorkspaceId = String(params.sourceWorkspaceId ?? "");
        const copiesFolder = String(params.copiesFolder ?? "");
        const copyName = String(params.copyName ?? "");
        const source = this.getWorkspace(sourceWorkspaceId);
        if (!source) {
          return notFound("Source workspace not found.");
        }
        if (!copiesFolder || !copyName) {
          return badRequest("Copies folder and copy name are required.");
        }
        const targetPath = path.join(copiesFolder, copyName);
        await fs.mkdir(copiesFolder, { recursive: true });
        await fs.cp(source.path, targetPath, { recursive: true });
        const cloneWorkspace: StoredWorkspace = {
          id: `ws-${randomUUID()}`,
          name: copyName,
          path: targetPath,
          kind: "main",
          parentId: source.id,
          worktree: null,
          settings: {
            ...defaultWorkspaceSettings(),
            cloneSourceWorkspaceId: source.id,
          },
        };
        this.workspacesById.set(cloneWorkspace.id, cloneWorkspace);
        await this.persistWorkspaces();
        return { ...cloneWorkspace, connected: false };
      }
      case "add_worktree": {
        const parentId = String(params.parentId ?? "");
        const branch = trimString(params.branch);
        const requestedName = toNullableString(params.name);
        const copyAgentsMd = params.copyAgentsMd !== false;
        const parent = this.getWorkspace(parentId);
        if (!parent) {
          return notFound("Parent workspace not found.");
        }
        if (!branch) {
          return badRequest("Branch name is required.");
        }
        try {
          const repoRoot = await resolveGitRootFromPath(parent.path);
          const worktreesDir = path.join(this.dataDir, "worktrees");
          const baseName = slugifyAgentName(requestedName ?? branch.replace(/\//g, "-"));
          let targetPath = path.join(worktreesDir, baseName);
          let suffix = 2;
          while (await fs.stat(targetPath).then(() => true).catch(() => false)) {
            targetPath = path.join(worktreesDir, `${baseName}-${suffix}`);
            suffix += 1;
          }
          await fs.mkdir(worktreesDir, { recursive: true });
          const branchExists = Boolean(
            await tryRunGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]),
          );
          if (branchExists) {
            await runGit(repoRoot, ["worktree", "add", targetPath, branch]);
          } else {
            await runGit(repoRoot, ["worktree", "add", "-b", branch, targetPath]);
          }
          if (copyAgentsMd) {
            const sourceAgents = path.join(parent.path, "AGENTS.md");
            const destinationAgents = path.join(targetPath, "AGENTS.md");
            const sourceExists = await fs.stat(sourceAgents).then(() => true).catch(() => false);
            const destinationExists = await fs
              .stat(destinationAgents)
              .then(() => true)
              .catch(() => false);
            if (sourceExists && !destinationExists) {
              await fs.copyFile(sourceAgents, destinationAgents);
            }
          }
          const workspace: StoredWorkspace = {
            id: `ws-${randomUUID()}`,
            name: requestedName ?? branch,
            path: targetPath,
            kind: "worktree",
            parentId,
            worktree: { branch },
            settings: {
              ...defaultWorkspaceSettings(),
              sidebarCollapsed: parent.settings.sidebarCollapsed,
              groupId: parent.settings.groupId ?? null,
              sortOrder: parent.settings.sortOrder ?? null,
              gitRoot: parent.settings.gitRoot ?? null,
              worktreeSetupScript: parent.settings.worktreeSetupScript ?? null,
            },
          };
          this.workspacesById.set(workspace.id, workspace);
          await this.persistWorkspaces();
          return { ...workspace, connected: false };
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "connect_workspace": {
        const workspaceId = String(params.id ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        this.connectedWorkspaceIds.add(workspaceId);
        this.emit(workspaceId, "codex/connected", {});
        return null;
      }
      case "update_workspace_settings": {
        const workspaceId = String(params.id ?? "");
        const settings =
          params.settings && typeof params.settings === "object"
            ? (params.settings as JsonRecord)
            : {};
        return this.updateWorkspaceSettingsRecord(workspaceId, settings);
      }
      case "remove_workspace":
      case "remove_worktree": {
        const workspaceId = String(params.id ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return null;
        }
        this.workspacesById.delete(workspaceId);
        this.connectedWorkspaceIds.delete(workspaceId);
        for (const thread of Array.from(this.threadsById.values())) {
          if (thread.workspaceId === workspaceId) {
            this.threadsById.delete(thread.id);
          }
        }
        await Promise.all([this.persistWorkspaces(), this.persistThreads()]);
        return null;
      }
      case "rename_worktree": {
        const workspaceId = String(params.id ?? "");
        const nextBranch = trimString(params.branch);
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        if (workspace.kind !== "worktree" || !workspace.worktree?.branch) {
          return badRequest("Not a worktree workspace.");
        }
        if (!nextBranch) {
          return badRequest("Branch name is required.");
        }
        try {
          const repoRoot = await resolveGitRootFromPath(workspace.path);
          let actualBranch = nextBranch;
          let suffix = 2;
          while (
            await tryRunGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${actualBranch}`])
          ) {
            actualBranch = `${nextBranch}-${suffix}`;
            suffix += 1;
          }
          await runGit(repoRoot, ["branch", "-m", workspace.worktree.branch, actualBranch]);
          workspace.worktree = { branch: actualBranch };
          await this.persistWorkspaces();
          return { ...workspace, connected: this.connectedWorkspaceIds.has(workspace.id) };
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "rename_worktree_upstream": {
        const workspaceId = String(params.id ?? "");
        const oldBranch = trimString(params.oldBranch);
        const newBranch = trimString(params.newBranch);
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        if (!oldBranch || !newBranch) {
          return badRequest("Both old and new branch names are required.");
        }
        try {
          const repoRoot = await resolveGitRootFromPath(workspace.path);
          const remoteName = "origin";
          await runGit(repoRoot, ["push", remoteName, `refs/heads/${newBranch}:refs/heads/${newBranch}`]);
          await tryRunGit(repoRoot, ["push", remoteName, "--delete", oldBranch]);
          await tryRunGit(repoRoot, ["branch", "--set-upstream-to", `${remoteName}/${newBranch}`, newBranch]);
          return null;
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "apply_worktree_changes": {
        const workspaceId = String(params.workspaceId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return notFound("workspace not found");
        }
        if (workspace.kind !== "worktree") {
          return badRequest("Not a worktree workspace.");
        }
        const parentId = workspace.parentId ?? null;
        const parent = parentId ? this.getWorkspace(parentId) : null;
        if (!parent) {
          return badRequest("worktree parent not found");
        }
        try {
          const worktreeRoot = await resolveGitRootFromPath(workspace.path);
          const parentRoot = await resolveGitRootFromPath(parent.path);
          const parentStatus = await runGit(parentRoot, ["status", "--porcelain"]);
          if (parentStatus.stdout.trim()) {
            return badRequest(
              "Your current branch has uncommitted changes. Please commit, stash, or discard them before applying worktree changes.",
            );
          }

          let patch = "";
          patch += (await runGit(worktreeRoot, ["diff", "--binary", "--no-color", "--cached"])).stdout;
          patch += (await runGit(worktreeRoot, ["diff", "--binary", "--no-color"])).stdout;

          const untracked = await runGit(worktreeRoot, [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
          ]);
          for (const rawPath of untracked.stdout.split("\0").filter(Boolean)) {
            patch += await runGitNoIndexDiff(worktreeRoot, rawPath);
          }

          if (!patch.trim()) {
            return badRequest("No changes to apply.");
          }

          await applyGitPatch(parentRoot, patch);
          return null;
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "worktree_setup_status": {
        const workspaceId = String(params.workspaceId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return notFound("workspace not found");
        }
        const script = normalizeSetupScript(workspace.settings.worktreeSetupScript);
        const markerExists =
          workspace.kind === "worktree" &&
          (await fs.stat(worktreeSetupMarkerPath(this.dataDir, workspace.id)).then(() => true).catch(() => false));
        return {
          shouldRun: workspace.kind === "worktree" && Boolean(script) && !markerExists,
          script,
        };
      }
      case "worktree_setup_mark_ran": {
        const workspaceId = String(params.workspaceId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return notFound("workspace not found");
        }
        if (workspace.kind !== "worktree") {
          return badRequest("Not a worktree workspace.");
        }
        const markerPath = worktreeSetupMarkerPath(this.dataDir, workspace.id);
        await fs.mkdir(path.dirname(markerPath), { recursive: true });
        await fs.writeFile(markerPath, `ran_at=${Math.floor(Date.now() / 1000)}\n`, "utf8");
        return { ok: true };
      }
      case "get_open_app_icon":
        return null;
      case "set_workspace_runtime_codex_args":
        return {
          appliedCodexArgs: toNullableString(params.codexArgs),
          respawned: false,
        };
      case "start_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        const timestamp = Date.now();
        const thread: StoredThread = {
          id: `thread-${randomUUID()}`,
          workspaceId,
          sdkThreadId: null,
          cwd: workspace.path,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
          name: null,
          preview: "New Agent",
          activeTurnId: null,
          turns: [],
          modelId: null,
          effort: null,
          tokenUsage: null,
        };
        this.threadsById.set(thread.id, thread);
        await this.persistThreads();
        this.emit(workspaceId, "thread/started", {
          thread: toThreadSummary(thread),
        });
        return {
          thread: {
            id: thread.id,
            preview: thread.preview,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            cwd: thread.cwd,
          },
        };
      }
      case "send_user_message": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const text = String(params.text ?? "");
        const workspace = this.getWorkspace(workspaceId);
        const thread = this.getThread(threadId);
        if (!workspace || !thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread or workspace not found.");
        }
        if (this.activeRuns.has(threadId)) {
          return notFound("A turn is already active for this thread.");
        }
        const settings = await this.storage.readSettings();
        const turnId = `turn-${randomUUID()}`;
        const now = Date.now();
        const turn: StoredTurn = {
          id: turnId,
          createdAt: now,
          completedAt: null,
          status: "active",
          errorMessage: null,
          items: [],
        };
        const inputImages = Array.isArray(params.images)
          ? params.images.filter((entry): entry is string => typeof entry === "string")
          : [];
        const userItem: StoredThreadItem = {
          id: `item-${randomUUID()}`,
          type: "userMessage",
          content: [
            { type: "input_text", text },
            ...inputImages.map((imagePath) => ({ type: "input_image", imageUrl: imagePath })),
          ],
        };
        thread.turns.push(turn);
        thread.activeTurnId = turnId;
        thread.updatedAt = now;
        thread.modelId = typeof params.model === "string" ? params.model : thread.modelId;
        thread.effort = typeof params.effort === "string" ? params.effort : thread.effort;
        turn.items.push(userItem);
        const abortController = new AbortController();
        this.activeRuns.set(threadId, { abortController, turnId });
        this.markThreadActive(workspaceId, threadId, turnId);
        this.emit(workspaceId, "item/completed", {
          threadId,
          item: userItem,
        });
        await this.persistThreads();

        const codexThread = this.loadThreadHandle(settings, workspace, thread, {
          model: typeof params.model === "string" ? params.model : null,
          effort: typeof params.effort === "string" ? params.effort : null,
          accessMode: typeof params.accessMode === "string" ? params.accessMode : null,
        });
        void (async () => {
          const input =
            inputImages.length > 0
              ? [
                  { type: "text", text } as const,
                  ...inputImages.map((imagePath) => ({ type: "local_image", path: imagePath }) as const),
                ]
              : text;
          const streamed = await codexThread.runStreamed(input, {
            signal: abortController.signal,
          });
          await this.processThreadEvents(workspace, thread, turnId, streamed.events);
        })();
        return {
          turn: {
            id: turnId,
            threadId,
          },
        };
      }
      case "turn_interrupt": {
        const threadId = String(params.threadId ?? "");
        const run = this.activeRuns.get(threadId);
        if (!run) {
          return notFound("No active turn found.");
        }
        run.abortController.abort();
        return {
          turnId: run.turnId,
        };
      }
      case "turn_steer": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const turnId = String(params.turnId ?? "");
        const thread = this.getThread(threadId);
        if (!workspaceId || !thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread or workspace not found.");
        }
        if (!turnId.trim()) {
          return badRequest("Missing active turn id.");
        }
        try {
          return await this.callCodexAppServer(
            "turn/steer",
            {
              threadId: this.resolveAppServerThreadId(thread),
              expectedTurnId: turnId,
              input: buildAppServerUserInputItems(
                String(params.text ?? ""),
                Array.isArray(params.images)
                  ? params.images.filter((entry): entry is string => typeof entry === "string")
                  : [],
                params.appMentions,
              ),
            },
            await this.storage.readSettings(),
          );
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "start_review": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        const thread = this.getThread(threadId);
        if (!workspace || !thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread or workspace not found.");
        }
        try {
          const response = await this.callCodexAppServer(
            "review/start",
            {
              threadId: this.resolveAppServerThreadId(thread),
              target: params.target && typeof params.target === "object" ? params.target : {},
              delivery: toNullableString(params.delivery),
            },
            await this.storage.readSettings(),
          );
          const reviewThreadId =
            trimString(response.reviewThreadId) || trimString(response.review_thread_id);
          if (reviewThreadId) {
            await this.syncStoredThreadFromAppServer(workspaceId, reviewThreadId);
          }
          return response;
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "respond_to_server_request":
      case "remember_approval_rule":
        return null;
      case "thread_live_subscribe":
      case "thread_live_unsubscribe": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        if (!this.getWorkspace(workspaceId)) {
          return notFound("Workspace not found.");
        }
        if (!threadId.trim()) {
          return badRequest("threadId is required.");
        }
        return null;
      }
      case "list_threads": {
        const sortKey =
          String(params.sortKey ?? "updated_at") === "created_at" ? "created_at" : "updated_at";
        const cursor = toNullableString(params.cursor);
        const limit =
          typeof params.limit === "number" && Number.isFinite(params.limit)
            ? params.limit
            : null;

        const localOnlyThreads = Array.from(this.threadsById.values())
          .filter((thread) => thread.archivedAt === null)
          .sort((left, right) =>
            sortKey === "created_at"
              ? right.createdAt - left.createdAt
              : right.updatedAt - left.updatedAt,
          )
          .map(toThreadSummary);

        try {
          const result = await this.listThreadsFromCodexAppServer(cursor, limit, sortKey);
          const externalData = Array.isArray(result.data)
            ? (result.data as Record<string, unknown>[])
            : [];
          const merged = new Map<string, Record<string, unknown>>();
          const matchedLocalIds = new Set<string>();

          externalData.forEach((thread) => {
            const externalId = trimString(thread.id);
            if (!externalId) {
              return;
            }
            const localThread = this.findThreadBySdkThreadId(externalId);
            if (localThread) {
              matchedLocalIds.add(localThread.id);
              merged.set(localThread.id, {
                ...thread,
                id: localThread.id,
                cwd: localThread.cwd || trimString(thread.cwd),
                preview: localThread.name ?? trimString(thread.preview) ?? localThread.preview,
                createdAt: localThread.createdAt || thread.createdAt,
                updatedAt: localThread.updatedAt || thread.updatedAt,
                ...(localThread.activeTurnId ? { activeTurnId: localThread.activeTurnId } : {}),
                ...(localThread.modelId ? { model: localThread.modelId } : {}),
                ...(localThread.effort ? { modelReasoningEffort: localThread.effort } : {}),
              });
              return;
            }
            merged.set(externalId, thread);
          });

          localOnlyThreads.forEach((thread) => {
            if (!matchedLocalIds.has(thread.id)) {
              merged.set(thread.id, thread);
            }
          });

          return {
            data: Array.from(merged.values()),
            nextCursor: result.nextCursor ?? result.next_cursor ?? null,
          };
        } catch {
          const threads = localOnlyThreads;
          return {
            data: threads,
            nextCursor: null,
          };
        }
      }
      case "resume_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const thread = this.getThread(threadId);
        if (thread && thread.id !== thread.sdkThreadId) {
          return {
            thread: toThreadResponse(thread),
          };
        }

        try {
          const result = await this.resumeThreadFromCodexAppServer(threadId);
          const rawThread =
            result.thread && typeof result.thread === "object"
              ? (result.thread as Record<string, unknown>)
              : null;
          if (!rawThread) {
            return notFound("Thread not found.");
          }
          const resolvedWorkspaceId =
            workspaceId ||
            this.resolveWorkspaceIdForCwd(trimString(rawThread.cwd)) ||
            thread?.workspaceId ||
            null;
          if (!resolvedWorkspaceId) {
            return {
              thread: rawThread,
            };
          }
          const stored = this.buildStoredThreadFromAppServer(
            resolvedWorkspaceId,
            rawThread,
            thread,
          );
          this.threadsById.set(stored.id, stored);
          await this.persistThreads();
          return {
            thread: rawThread,
          };
        } catch {
          if (!thread) {
            return notFound("Thread not found.");
          }
          return {
            thread: toThreadResponse(thread),
          };
        }
      }
      case "fork_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        const thread = this.getThread(threadId);
        if (!workspace || !thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread or workspace not found.");
        }
        try {
          const response = await this.callCodexAppServer(
            "thread/fork",
            { threadId: this.resolveAppServerThreadId(thread) },
            await this.storage.readSettings(),
          );
          const rawThread =
            response.thread && typeof response.thread === "object"
              ? (response.thread as Record<string, unknown>)
              : null;
          if (rawThread) {
            const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread);
            this.threadsById.set(stored.id, stored);
            await this.persistThreads();
          }
          return response;
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "compact_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        const thread = this.getThread(threadId);
        if (!workspace || !thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread or workspace not found.");
        }
        try {
          return await this.callCodexAppServer(
            "thread/compact/start",
            { threadId: this.resolveAppServerThreadId(thread) },
            await this.storage.readSettings(),
          );
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "archive_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const thread = this.getThread(threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread not found.");
        }
        thread.archivedAt = Date.now();
        thread.updatedAt = Date.now();
        await this.persistThreads();
        this.emit(workspaceId, "thread/archived", { threadId });
        return null;
      }
      case "set_thread_name": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const name = String(params.name ?? "");
        const thread = this.getThread(threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread not found.");
        }
        thread.name = name || null;
        thread.updatedAt = Date.now();
        await this.persistThreads();
        this.emit(workspaceId, "thread/name/updated", {
          threadId,
          threadName: thread.name,
        });
        return null;
      }
      case "get_config_model": {
        try {
          const config = await fs.readFile(this.storage.globalConfigPath(), "utf8");
          return { model: parseTopLevelTomlString(config, "model") };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { model: null };
          }
          throw error;
        }
      }
      case "model_list":
        return { data: DEFAULT_MODELS };
      case "skills_list":
        return { data: [] };
      case "apps_list":
        return { data: [] };
      case "prompts_list": {
        const workspaceId = String(params.workspaceId ?? "");
        return await this.readPromptEntries(workspaceId);
      }
      case "prompts_workspace_dir": {
        const workspaceId = String(params.workspaceId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        const promptsDir = this.storage.workspacePromptsDir(workspace.id);
        await fs.mkdir(promptsDir, { recursive: true });
        return promptsDir;
      }
      case "prompts_global_dir": {
        const promptsDir = this.storage.globalPromptsDir();
        await fs.mkdir(promptsDir, { recursive: true });
        return promptsDir;
      }
      case "prompts_create": {
        const workspaceId = String(params.workspaceId ?? "");
        const scope = String(params.scope ?? "");
        const name = trimString(params.name);
        if (!name) {
          return badRequest("Prompt name is required.");
        }
        const promptDir = this.promptDirectoryForScope(scope, workspaceId);
        await fs.mkdir(promptDir, { recursive: true });
        const promptPath = path.join(promptDir, `${name}.md`);
        const exists = await fs
          .stat(promptPath)
          .then((stat) => stat.isFile())
          .catch(() => false);
        if (exists) {
          return badRequest("Prompt already exists.");
        }
        const content = buildPromptContent(
          toNullableString(params.description),
          toNullableString(params.argumentHint),
          String(params.content ?? ""),
        );
        await fs.writeFile(promptPath, content, "utf8");
        return {
          name,
          path: promptPath,
          description: toNullableString(params.description),
          argumentHint: toNullableString(params.argumentHint),
          content: String(params.content ?? ""),
          scope,
        };
      }
      case "prompts_update": {
        const workspaceId = String(params.workspaceId ?? "");
        const currentPath = String(params.path ?? "");
        const name = trimString(params.name);
        if (!name) {
          return badRequest("Prompt name is required.");
        }
        await this.ensurePromptPathAllowed(workspaceId, currentPath);
        const nextPath = path.join(path.dirname(currentPath), `${name}.md`);
        if (nextPath !== currentPath) {
          const exists = await fs
            .stat(nextPath)
            .then((stat) => stat.isFile())
            .catch(() => false);
          if (exists) {
            return badRequest("Prompt with that name already exists.");
          }
        }
        const content = buildPromptContent(
          toNullableString(params.description),
          toNullableString(params.argumentHint),
          String(params.content ?? ""),
        );
        await fs.writeFile(nextPath, content, "utf8");
        if (nextPath !== currentPath) {
          await fs.rm(currentPath, { force: true });
        }
        const workspaceRoot = path.resolve(this.storage.workspacePromptsDir(workspaceId));
        return {
          name,
          path: nextPath,
          description: toNullableString(params.description),
          argumentHint: toNullableString(params.argumentHint),
          content: String(params.content ?? ""),
          scope: path.resolve(nextPath).startsWith(workspaceRoot) ? "workspace" : "global",
        };
      }
      case "prompts_delete": {
        const workspaceId = String(params.workspaceId ?? "");
        const promptPath = String(params.path ?? "");
        await this.ensurePromptPathAllowed(workspaceId, promptPath);
        await fs.rm(promptPath, { force: true });
        return null;
      }
      case "prompts_move": {
        const workspaceId = String(params.workspaceId ?? "");
        const promptPath = String(params.path ?? "");
        const scope = String(params.scope ?? "");
        await this.ensurePromptPathAllowed(workspaceId, promptPath);
        const nextDir = this.promptDirectoryForScope(scope, workspaceId);
        await fs.mkdir(nextDir, { recursive: true });
        const nextPath = path.join(nextDir, path.basename(promptPath));
        if (path.resolve(nextPath) === path.resolve(promptPath)) {
          return badRequest("Prompt is already in that scope.");
        }
        await fs.rename(promptPath, nextPath);
        const parsed = parseFrontmatter(await fs.readFile(nextPath, "utf8"));
        return {
          name: path.basename(nextPath, ".md"),
          path: nextPath,
          description: parsed.description,
          argumentHint: parsed.argumentHint,
          content: parsed.body,
          scope,
        };
      }
      case "list_mcp_server_status":
        return { data: [] };
      case "get_agents_settings":
        return this.formatAgentsSettings();
      case "set_agents_core_settings": {
        const input =
          params.input && typeof params.input === "object"
            ? (params.input as JsonRecord)
            : {};
        const state = await this.readAgentsState();
        const nextState: AgentsState = {
          ...state,
          multiAgentEnabled: Boolean(input.multiAgentEnabled),
          maxThreads:
            typeof input.maxThreads === "number"
              ? input.maxThreads
              : state.maxThreads,
          maxDepth:
            typeof input.maxDepth === "number" ? input.maxDepth : state.maxDepth,
        };
        await this.writeAgentsState(nextState);
        return this.formatAgentsSettings(nextState);
      }
      case "create_agent": {
        const input =
          params.input && typeof params.input === "object"
            ? (params.input as JsonRecord)
            : {};
        const name = trimString(input.name);
        if (!name) {
          return badRequest("Agent name is required.");
        }
        const state = await this.readAgentsState();
        if (state.agents.some((agent) => agent.name === name)) {
          return badRequest(`Agent '${name}' already exists.`);
        }
        const configFile = this.agentConfigRelativePath(name);
        const resolvedPath = this.agentConfigAbsolutePath(configFile);
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(
          resolvedPath,
          buildAgentTemplateContent(
            toNullableString(input.model),
            toNullableString(input.reasoningEffort),
            toNullableString(input.developerInstructions),
          ),
          "utf8",
        );
        state.agents.push({
          name,
          description: toNullableString(input.description),
          developerInstructions: toNullableString(input.developerInstructions),
          configFile,
          resolvedPath,
          managedByApp: true,
          fileExists: true,
        });
        await this.writeAgentsState(state);
        return this.formatAgentsSettings(state);
      }
      case "update_agent": {
        const input =
          params.input && typeof params.input === "object"
            ? (params.input as JsonRecord)
            : {};
        const originalName = trimString(input.originalName);
        const name = trimString(input.name);
        const state = await this.readAgentsState();
        const agent = state.agents.find((entry) => entry.name === originalName);
        if (!agent) {
          return badRequest(`Agent '${originalName}' not found.`);
        }
        if (
          name &&
          name !== originalName &&
          state.agents.some((entry) => entry.name === name)
        ) {
          return badRequest(`Agent '${name}' already exists.`);
        }
        const nextName = name || originalName;
        const nextConfigFile =
          nextName === originalName ? agent.configFile : this.agentConfigRelativePath(nextName);
        const nextPath = this.agentConfigAbsolutePath(nextConfigFile);
        if (nextPath !== this.agentConfigAbsolutePath(agent.configFile)) {
          await fs.mkdir(path.dirname(nextPath), { recursive: true });
          await fs.rename(this.agentConfigAbsolutePath(agent.configFile), nextPath);
        }
        await fs.writeFile(
          nextPath,
          buildAgentTemplateContent(
            parseTopLevelTomlString(await fs.readFile(nextPath, "utf8").catch(() => ""), "model"),
            parseTopLevelTomlString(
              await fs.readFile(nextPath, "utf8").catch(() => ""),
              "model_reasoning_effort",
            ),
            toNullableString(input.developerInstructions),
          ),
          "utf8",
        );
        agent.name = nextName;
        agent.description = toNullableString(input.description);
        agent.developerInstructions = toNullableString(input.developerInstructions);
        agent.configFile = nextConfigFile;
        agent.resolvedPath = nextPath;
        agent.fileExists = true;
        await this.writeAgentsState(state);
        return this.formatAgentsSettings(state);
      }
      case "delete_agent": {
        const input =
          params.input && typeof params.input === "object"
            ? (params.input as JsonRecord)
            : {};
        const name = trimString(input.name);
        const deleteManagedFile = Boolean(input.deleteManagedFile);
        const state = await this.readAgentsState();
        const index = state.agents.findIndex((agent) => agent.name === name);
        if (index < 0) {
          return badRequest(`Agent '${name}' not found.`);
        }
        const [agent] = state.agents.splice(index, 1);
        if (deleteManagedFile && agent?.configFile) {
          await fs.rm(this.agentConfigAbsolutePath(agent.configFile), { force: true });
        }
        await this.writeAgentsState(state);
        return this.formatAgentsSettings(state);
      }
      case "read_agent_config_toml": {
        const agentName = trimString(params.agentName);
        if (!agentName) {
          return "";
        }
        const state = await this.readAgentsState();
        const agent = state.agents.find((entry) => entry.name === agentName);
        if (!agent) {
          return "";
        }
        return fs.readFile(this.agentConfigAbsolutePath(agent.configFile), "utf8").catch(
          () => "",
        );
      }
      case "write_agent_config_toml": {
        const agentName = trimString(params.agentName);
        const content = String(params.content ?? "");
        const state = await this.readAgentsState();
        const agent = state.agents.find((entry) => entry.name === agentName);
        if (!agent) {
          return badRequest(`Agent '${agentName}' not found.`);
        }
        const resolvedPath = this.agentConfigAbsolutePath(agent.configFile);
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(resolvedPath, content, "utf8");
        agent.fileExists = true;
        await this.writeAgentsState(state);
        return null;
      }
      case "collaboration_mode_list":
        return {
          data: [
            {
              mode: "default",
              name: "Default",
              label: "Default",
              settings: {
                model: null,
                reasoning_effort: null,
                developer_instructions: null,
              },
            },
          ],
        };
      case "experimental_feature_list":
        return { data: [] };
      case "set_codex_feature_flag":
        return null;
      case "account_rate_limits":
        return { primary: null, secondary: null, credits: null, planType: null };
      case "account_read":
        return {
          type: "unknown",
          email: null,
          planType: null,
          requiresOpenaiAuth: null,
        };
      case "codex_login":
        return badRequest("Codex login is not implemented in the web companion yet.");
      case "codex_login_cancel":
        return { canceled: false, status: "unavailable" };
      case "file_read": {
        const scope = String(params.scope ?? "");
        const kind = String(params.kind ?? "");
        const workspaceId = String(params.workspaceId ?? "");
        const filePath = this.resolveScopedFilePath(scope, kind, workspaceId);
        if (isRpcError(filePath)) {
          return filePath;
        }
        return this.storage.readTextFile(filePath);
      }
      case "file_write": {
        const scope = String(params.scope ?? "");
        const kind = String(params.kind ?? "");
        const workspaceId = String(params.workspaceId ?? "");
        const content = String(params.content ?? "");
        const filePath = this.resolveScopedFilePath(scope, kind, workspaceId);
        if (isRpcError(filePath)) {
          return filePath;
        }
        await this.storage.writeTextFile(filePath, content);
        return null;
      }
      case "generate_run_metadata": {
        const workspaceId = String(params.workspaceId ?? "");
        const prompt = String(params.prompt ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          return await this.generateRunMetadataForWorkspace(workspace, prompt);
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "read_image_as_data_url":
        return this.readImageAsDataUrl(String(params.path ?? ""));
      case "list_workspace_files": {
        const workspaceId = String(params.workspaceId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return [];
        }
        return this.listWorkspaceFilesRecursive(workspace.path);
      }
      case "read_workspace_file":
        return this.readWorkspaceFileContents(
          String(params.workspaceId ?? ""),
          String(params.path ?? ""),
        );
      case "init_git_repo": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const force = params.force === true;
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          const repoRoot = path.resolve(workspace.path);
          const branch = validateBranchName(String(params.branch ?? ""));
          if (await fs.stat(path.join(repoRoot, ".git")).then(() => true).catch(() => false)) {
            return { status: "already_initialized" };
          }
          if (!force) {
            const entryCount = await countEffectiveDirEntries(repoRoot);
            if (entryCount > 0) {
              return { status: "needs_confirmation", entryCount };
            }
          }

          try {
            await runGit(repoRoot, ["init", "--initial-branch", branch]);
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
            await runGit(repoRoot, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
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
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "create_github_repo":
        return badRequest("GitHub repo creation is not implemented in the web companion yet.");
      case "get_git_status": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          const status = await buildGitStatusSummary(workspace.path);
          return {
            branchName: status.branchName,
            files: status.files,
            stagedFiles: status.stagedFiles,
            unstagedFiles: status.unstagedFiles,
            totalAdditions: status.totalAdditions,
            totalDeletions: status.totalDeletions,
          };
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "list_git_roots": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const depth =
          typeof params.depth === "number" && Number.isFinite(params.depth) ? params.depth : 2;
        if (!workspace) {
          return [];
        }
        return await scanGitRoots(workspace.path, depth);
      }
      case "get_git_diffs": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          return await buildWorkingTreeDiffs(workspace.path);
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "get_git_log": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const limit =
          typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 40;
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          return await getGitLogSummary(workspace.path, limit);
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "get_git_commit_diff": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const sha = trimString(params.sha);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        if (!sha) {
          return badRequest("sha is required.");
        }
        try {
          return await getCommitDiffEntries(workspace.path, sha);
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "get_git_remote": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return null;
        }
        try {
          const repoRoot = await resolveGitRootFromPath(workspace.path);
          return await getPreferredRemote(repoRoot);
        } catch {
          return null;
        }
      }
      case "stage_git_file": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const filePath = trimString(params.path);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        await runGit(await resolveGitRootFromPath(workspace.path), ["add", "--", filePath]);
        return null;
      }
      case "stage_git_all": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        await runGit(await resolveGitRootFromPath(workspace.path), ["add", "-A"]);
        return null;
      }
      case "unstage_git_file": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const filePath = trimString(params.path);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        await runGit(await resolveGitRootFromPath(workspace.path), ["restore", "--staged", "--", filePath]);
        return null;
      }
      case "revert_git_file": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const filePath = trimString(params.path);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        const repoRoot = await resolveGitRootFromPath(workspace.path);
        const tracked = await tryRunGit(repoRoot, ["ls-files", "--error-unmatch", "--", filePath]);
        if (tracked) {
          await runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", filePath]);
        } else {
          await fs.rm(path.join(repoRoot, filePath), { force: true, recursive: true });
        }
        return null;
      }
      case "revert_git_all": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        const repoRoot = await resolveGitRootFromPath(workspace.path);
        await runGit(repoRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "."]);
        await tryRunGit(repoRoot, ["clean", "-fd"]);
        return null;
      }
      case "commit_git": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const message = String(params.message ?? "").trim();
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        if (!message) {
          return badRequest("Commit message is required.");
        }
        await runGit(await resolveGitRootFromPath(workspace.path), ["commit", "-m", message]);
        return null;
      }
      case "push_git": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        await runGit(await resolveGitRootFromPath(workspace.path), ["push"]);
        return null;
      }
      case "pull_git": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        await runGit(await resolveGitRootFromPath(workspace.path), ["pull", "--rebase"]);
        return null;
      }
      case "fetch_git": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        await runGit(await resolveGitRootFromPath(workspace.path), ["fetch", "--all", "--prune"]);
        return null;
      }
      case "sync_git": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        const repoRoot = await resolveGitRootFromPath(workspace.path);
        await runGit(repoRoot, ["pull", "--rebase"]);
        await runGit(repoRoot, ["push"]);
        return null;
      }
      case "list_git_branches": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return { branches: [] };
        }
        try {
          return { branches: await listLocalGitBranches(workspace.path) };
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "checkout_git_branch": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const name = trimString(params.name);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        await runGit(await resolveGitRootFromPath(workspace.path), ["checkout", name]);
        return null;
      }
      case "create_git_branch": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const name = trimString(params.name);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        await runGit(await resolveGitRootFromPath(workspace.path), ["checkout", "-b", name]);
        return null;
      }
      case "checkout_github_pull_request":
        return null;
      case "local_usage_snapshot":
        return {
          updatedAt: Date.now(),
          days: [],
          totals: {
            last7DaysTokens: 0,
            last30DaysTokens: 0,
            averageDailyTokens: 0,
            cacheHitRatePercent: 0,
            peakDay: null,
            peakDayTokens: 0,
          },
          topModels: [],
        };
      case "codex_doctor":
        return {
          ok: true,
          codexBin: null,
          version: null,
          appServerOk: true,
          details: "Web companion server is running.",
          path: null,
          nodeOk: true,
          nodeVersion: process.version,
          nodeDetails: null,
        };
      case "codex_update":
        return {
          ok: false,
          method: "unknown",
          package: null,
          beforeVersion: null,
          afterVersion: null,
          upgraded: false,
          output: null,
          details: "Codex update is not implemented in the web companion.",
        };
      case "app_build_type":
        return "release";
      case "is_mobile_runtime":
      case "is_macos_debug_build":
        return false;
      case "send_notification_fallback":
        return null;
      case "generate_commit_message":
        return "Update project files";
      case "generate_agent_description": {
        const description = trimString(params.description);
        return {
          description: description || "Custom agent",
          developerInstructions: description
            ? `Focus on: ${description}`
            : "Provide clear, pragmatic help for the assigned task.",
        };
      }
      default:
        return notFound(`Unsupported method: ${method}`);
    }
  }

  private resolveScopedFilePath(scope: string, kind: string, workspaceId: string) {
    if (scope === "global" && kind === "agents") {
      return this.storage.globalAgentsPath();
    }
    if (scope === "global" && kind === "config") {
      return this.storage.globalConfigPath();
    }
    if (scope === "workspace") {
      const workspace = this.getWorkspace(workspaceId);
      if (!workspace) {
        return notFound("Workspace not found.");
      }
      if (kind === "agents") {
        return this.storage.workspaceAgentsPath(workspace.path);
      }
      if (kind === "config") {
        return this.storage.workspaceConfigPath(workspace.path);
      }
    }
    return notFound("Unsupported file scope or kind.");
  }
}
