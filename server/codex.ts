import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildAppServerEvent } from "./appServer.js";
import {
  isHttpUrl,
} from "./parity.js";
import { handleAgentsRpc as dispatchAgentsRpc } from "./codex/codexAgentsRpc.js";
import {
  handleScopedFileRpc as dispatchScopedFileRpc,
  handleWorkspaceFileRpc as dispatchWorkspaceFileRpc,
} from "./codex/codexFileRpc.js";
import {
  handleGitRpc as dispatchGitRpc,
} from "./codex/codexGitRpc.js";
import { handleWorkspaceRpc as dispatchWorkspaceRpc } from "./codex/codexWorkspaceRpc.js";
import { handleWorkspaceGitRpc as dispatchWorkspaceGitRpc } from "./codex/codexWorkspaceGitRpc.js";
import {
  createGitHubRepo,
  getGitHubIssues,
  getGitHubPullRequestComments,
  getGitHubPullRequestDiff,
  getGitHubPullRequests,
  checkoutGitHubPullRequest,
} from "./codex/githubRepo.js";
import {
  buildGitStatusSummary,
  buildWorkingTreeDiffs,
  getCommitDiffEntries,
  getGitLogSummary,
  getPreferredRemote,
  listLocalGitBranches,
  scanGitRoots,
} from "./codex/gitInspection.js";
import { initializeGitRepo } from "./codex/gitRepoLifecycle.js";
import {
  applyGitPatch,
  cloneRepository,
  resolveGitRootFromPath,
  runCommandCapture,
  runGit,
  runGitCommit,
  runGitNoIndexDiff,
  tryRunGit,
} from "./codex/gitRuntime.js";
import { handleCompanionRuntimeRpc as dispatchCompanionRuntimeRpc } from "./codex/codexRpcRuntime.js";
import { handleThreadBacklogRpc as dispatchThreadBacklogRpc } from "./codex/codexRpcThreadBacklog.js";
import { classifyRpcBoundaryError } from "./codex/rpcErrors.js";
import { buildLocalUsageSnapshot } from "./codex/localUsage.js";
import {
  buildAgentDescriptionPrompt,
  buildAppServerUserInputItems,
  buildRunMetadataPrompt,
  extractUserMessageTextFromStoredItem,
  findLastAgentMessageText,
  parseAgentDescriptionValue,
  parseRunMetadataValue,
} from "./codex/codexPrompts.js";
import { handlePromptRpc as dispatchPromptRpc } from "./codex/codexPromptRpc.js";
import { CompanionStorage } from "./storage.js";
import {
  createTerminalRuntime,
  type TerminalBroadcastMessage,
  type TerminalRuntime,
} from "./terminal.js";
import {
  CodexAppServerClient,
  type AppServerNotificationMessage,
} from "./vendor/codexSdk.js";
import type {
  AppServerEventPayload,
  JsonRecord,
  RpcErrorShape,
  StoredThread,
  StoredThreadItem,
  StoredTurn,
  StoredWorkspace,
  ThreadBacklogItem,
} from "./types.js";
export {
  buildAppServerUserInputItems,
  buildRunMetadataPrompt,
  parseRunMetadataValue,
} from "./codex/codexPrompts.js";

type AccountFallback = {
  email: string | null;
  planType: string | null;
};

type LoginState = {
  canceled: boolean;
  loginId: string | null;
  pending: Promise<JsonRecord> | null;
};

type BroadcastMessage = {
  event: "app-server-event";
  payload: AppServerEventPayload;
};

type BroadcastFn = (message: BroadcastMessage | TerminalBroadcastMessage) => void;

const RPC_UNHANDLED = Symbol("rpc-unhandled");
type RpcDispatchResult = unknown | RpcErrorShape | typeof RPC_UNHANDLED;

const APP_SERVER_INIT_TIMEOUT_MS = 15_000;
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const MILLISECONDS_PER_SECOND = 10 ** 3;
const SECONDS_PER_MINUTE = 60;
const MAX_ACTIVITY_GAP_MS = 2 * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const APP_SERVER_SOURCE_KINDS = [
  "cli",
  "vscode",
  "appServer",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "unknown",
];

const APP_SERVER_GLOBAL_NOTIFICATION_METHODS = new Set([
  "account/login/completed",
  "account/rateLimits/updated",
  "account/updated",
  "app/list/updated",
  "configWarning",
  "deprecationNotice",
  "model/rerouted",
  "skills/changed",
]);
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";
const TURN_ACTIVITY_TIMESTAMP_KEYS = [
  "updatedAt",
  "updated_at",
  "completedAt",
  "completed_at",
  "startedAt",
  "started_at",
  "createdAt",
  "created_at",
] as const;
const THREAD_ACTIVITY_TIMESTAMP_KEYS = [
  "updatedAt",
  "updated_at",
  "createdAt",
  "created_at",
] as const;

const RUN_METADATA_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    worktreeName: { type: "string" },
  },
  required: ["title", "worktreeName"],
  additionalProperties: false,
} as const;

function rpcError(status: number, message: string): RpcErrorShape {
  return { error: { status, message } };
}

function notFound(message: string): RpcErrorShape {
  return rpcError(404, message);
}

function badRequest(message: string): RpcErrorShape {
  return rpcError(400, message);
}

function rpcBoundaryError(error: unknown): RpcErrorShape {
  return classifyRpcBoundaryError(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapPathValidationError(error: unknown): RpcErrorShape {
  const message = errorMessage(error);
  if (message === "Workspace not found.") {
    return notFound(message);
  }
  return badRequest(message);
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

type ThreadSummary = ReturnType<typeof toThreadSummary>;

function normalizeRootPath(value: string) {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function buildCommitMessagePrompt(diff: string, template: string) {
  const defaultTemplate =
    "Generate a concise git commit message for the following changes. " +
    "Follow conventional commit format (e.g., feat:, fix:, refactor:, docs:, etc.). " +
    "Keep the summary line under 72 characters. " +
    "Only output the commit message, nothing else.\n\nChanges:\n{diff}";
  const base = template.trim() ? template : defaultTemplate;
  return base.includes("{diff}") ? base.replace("{diff}", diff) : `${base}\n\nChanges:\n${diff}`;
}

function buildCommitMessagePromptForDiff(diff: string, template: string) {
  if (!diff.trim()) {
    throw new Error("No changes to generate commit message for");
  }
  return buildCommitMessagePrompt(diff, template);
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

function buildSandboxPolicy(workspacePath: string, accessMode: string | null) {
  switch (accessMode) {
    case "full-access":
      return {
        type: "dangerFullAccess",
      };
    case "read-only":
      return {
        type: "readOnly",
      };
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [workspacePath],
        networkAccess: true,
      };
  }
}

function approvalPolicyForAccessMode(accessMode: string | null) {
  return accessMode === "full-access" ? "never" : "on-request";
}

function asJsonRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function extractEmbeddedThreadId(value: unknown) {
  return trimString(asJsonRecord(value)?.id);
}

function extractThreadIdFromRecord(value: unknown) {
  const record = asJsonRecord(value);
  if (!record) {
    return "";
  }
  return (
    trimString(record.threadId) ||
    trimString(record.thread_id) ||
    extractEmbeddedThreadId(record.thread)
  );
}

function extractThreadIdFromParams(params: JsonRecord) {
  const direct = trimString(params.threadId) || trimString(params.thread_id);
  if (direct) {
    return direct;
  }
  const fromTurn = extractThreadIdFromRecord(params.turn);
  if (fromTurn) {
    return fromTurn;
  }
  const fromItem = extractThreadIdFromRecord(params.item);
  if (fromItem) {
    return fromItem;
  }
  return extractEmbeddedThreadId(params.thread);
}

function extractTurnIdFromTurnRecord(value: unknown) {
  const record = asJsonRecord(value);
  if (!record) {
    return "";
  }
  return trimString(record.id);
}

function extractTurnIdFromItemRecord(value: unknown) {
  const record = asJsonRecord(value);
  if (!record) {
    return "";
  }
  return trimString(record.turnId) || trimString(record.turn_id);
}

function extractTurnIdFromParams(params: JsonRecord) {
  const direct = trimString(params.turnId) || trimString(params.turn_id);
  if (direct) {
    return direct;
  }
  const fromTurn = extractTurnIdFromTurnRecord(params.turn);
  if (fromTurn) {
    return fromTurn;
  }
  return extractTurnIdFromItemRecord(params.item);
}

function normalizeLifecycleStatus(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, "");
}

function isTerminalAppServerItem(item: unknown) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return true;
  }
  const record = item as JsonRecord;
  const normalizedStatus = normalizeLifecycleStatus(record.status);
  if (!normalizedStatus) {
    return true;
  }
  return !(
    normalizedStatus === "inprogress" ||
    normalizedStatus === "running" ||
    normalizedStatus === "processing" ||
    normalizedStatus === "pending" ||
    normalizedStatus === "queued" ||
    normalizedStatus === "waiting" ||
    normalizedStatus === "blocked"
  );
}

function hasExplicitAppServerItemStatus(item: unknown) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  const record = item as JsonRecord;
  return normalizeLifecycleStatus(record.status).length > 0;
}

function readLifecycleTimestampMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  const trimmed = trimString(value);
  if (!trimmed) {
    return null;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate) && parsedDate > 0) {
    return parsedDate;
  }
  const parsedNumber = Number(trimmed);
  return Number.isFinite(parsedNumber) && parsedNumber > 0 ? parsedNumber : null;
}

function readFirstLifecycleTimestampMs(
  source: Record<string, unknown>,
  keys: readonly string[],
) {
  for (const key of keys) {
    const timestamp = readLifecycleTimestampMs(source[key]);
    if (timestamp !== null) {
      return timestamp;
    }
  }
  return null;
}

function readThreadActivityTimestampMs(rawThread: Record<string, unknown>, rawTurn: Record<string, unknown>) {
  return (
    readFirstLifecycleTimestampMs(rawTurn, TURN_ACTIVITY_TIMESTAMP_KEYS) ??
    readFirstLifecycleTimestampMs(rawThread, THREAD_ACTIVITY_TIMESTAMP_KEYS)
  );
}

function readThreadTurns(rawThread: Record<string, unknown>) {
  return Array.isArray(rawThread.turns)
    ? (rawThread.turns as Array<Record<string, unknown>>)
    : [];
}

function readTurnItems(rawTurn: Record<string, unknown>) {
  return Array.isArray(rawTurn.items) ? rawTurn.items : [];
}

function hasExplicitTerminalItemStatuses(items: unknown[]) {
  return items.length > 0 &&
    items.every((item) => isTerminalAppServerItem(item) && hasExplicitAppServerItemStatus(item));
}

function readDirectActiveTurnId(rawThread: Record<string, unknown>) {
  return trimString(rawThread.activeTurnId) || trimString(rawThread.active_turn_id);
}

function isInactiveThreadStatus(statusType: string) {
  return statusType === "idle" || statusType === "notloaded" || statusType === "systemerror";
}

function isStaleByActivityAge(activityTimestamp: number | null) {
  return activityTimestamp !== null && Date.now() - activityTimestamp > MAX_ACTIVITY_GAP_MS;
}

function shouldNormalizeStaleThread(
  statusType: string,
  directActiveTurnId: string,
  activityTimestamp: number | null,
) {
  if (isInactiveThreadStatus(statusType)) {
    return true;
  }
  if (directActiveTurnId) {
    return false;
  }
  return isStaleByActivityAge(activityTimestamp);
}

function markTurnCompleted(rawTurn: Record<string, unknown>) {
  rawTurn.status = "completed";
  if (!("error" in rawTurn)) {
    rawTurn.error = null;
  }
}

function normalizeThreadStatusToIdle(rawThread: Record<string, unknown>) {
  const status = asJsonRecord(rawThread.status);
  if (status && normalizeLifecycleStatus(status.type) === "active") {
    rawThread.status = { type: "idle" };
    return;
  }
  if (normalizeLifecycleStatus(rawThread.status) === "active") {
    rawThread.status = "idle";
  }
}

function clearThreadActiveTurn(rawThread: Record<string, unknown>) {
  rawThread.activeTurnId = null;
  rawThread.active_turn_id = null;
}

function normalizeStaleInProgressThread(rawThread: Record<string, unknown>) {
  const turns = readThreadTurns(rawThread);
  const lastTurn = turns.at(-1);
  if (!lastTurn) {
    return rawThread;
  }
  if (normalizeLifecycleStatus(lastTurn.status) !== "inprogress") {
    return rawThread;
  }
  const items = readTurnItems(lastTurn);
  if (items.length === 0) {
    return rawThread;
  }
  if (!hasExplicitTerminalItemStatuses(items)) {
    return rawThread;
  }
  const statusType = normalizeThreadStatusType(rawThread.status);
  const directActiveTurnId = readDirectActiveTurnId(rawThread);
  const activityTimestamp = readThreadActivityTimestampMs(rawThread, lastTurn);
  if (!shouldNormalizeStaleThread(statusType, directActiveTurnId, activityTimestamp)) {
    return rawThread;
  }
  markTurnCompleted(lastTurn);
  normalizeThreadStatusToIdle(rawThread);
  clearThreadActiveTurn(rawThread);
  return rawThread;
}

function normalizeThreadStatusType(status: unknown) {
  const record = asJsonRecord(status);
  if (!record) {
    return trimString(status).toLowerCase().replace(/[\s_-]/g, "");
  }
  return trimString(record.type ?? record.statusType ?? record.status_type)
    .toLowerCase()
    .replace(/[\s_-]/g, "");
}

function extractActiveTurnRecord(rawThread: Record<string, unknown>) {
  return asJsonRecord(rawThread.activeTurn) ?? asJsonRecord(rawThread.active_turn);
}

function extractTurnObjectId(value: unknown) {
  const record = asJsonRecord(value);
  if (!record) {
    return "";
  }
  return (
    trimString(record.id) ||
    trimString(record.turnId) ||
    trimString(record.turn_id)
  );
}

function findLatestTurnId(turns: Array<Record<string, unknown>>) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turnId = trimString(turns[index]?.id);
    if (turnId) {
      return turnId;
    }
  }
  return null;
}

function extractActiveTurnIdFromThread(rawThread: Record<string, unknown>) {
  normalizeStaleInProgressThread(rawThread);
  const direct = readDirectActiveTurnId(rawThread);
  if (direct) {
    return direct;
  }
  const objectId = extractTurnObjectId(extractActiveTurnRecord(rawThread));
  if (objectId) {
    return objectId;
  }
  if (normalizeThreadStatusType(rawThread.status) !== "active") {
    return null;
  }
  return findLatestTurnId(readThreadTurns(rawThread));
}

function toStoredItemFromAppServer(turnId: string, item: JsonRecord): StoredThreadItem {
  const itemId = trimString(item.id) || `item-${randomUUID()}`;
  return {
    ...item,
    id: toStoredItemId(turnId, itemId),
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

function appServerItemIdMatches(storedItemId: string, requestedItemId: string) {
  return (
    storedItemId === requestedItemId ||
    storedItemId.endsWith(`:${requestedItemId}`) ||
    requestedItemId.endsWith(`:${storedItemId}`)
  );
}

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toNullableString(value: unknown) {
  const trimmed = trimString(value);
  return trimmed.length > 0 ? trimmed : null;
}

function getOptionalServiceTier(
  params: Record<string, unknown>,
  key: string,
): "fast" | "flex" | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) {
    return undefined;
  }
  if (params[key] === null) {
    return null;
  }
  const value = toNullableString(params[key]);
  return value === "fast" || value === "flex" ? value : undefined;
}

function parseCodexArgs(value: string | null) {
  if (!value) {
    return [];
  }
  const matches = value.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g);
  if (!matches) {
    return [];
  }
  return matches.map((part) => {
    if (
      (part.startsWith("\"") && part.endsWith("\"")) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}

function buildCodexPathEnv(codexBin: string | null) {
  const resolved = trimString(codexBin);
  if (!resolved || (!resolved.includes("/") && !resolved.includes("\\"))) {
    return null;
  }
  const codexDir = path.dirname(path.resolve(resolved));
  const currentPath = process.env.PATH ?? "";
  return currentPath ? `${codexDir}${path.delimiter}${currentPath}` : codexDir;
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
  return Buffer.from(padded, "base64").toString("utf8");
}

function readJwtPayload(token: string) {
  const segments = token.split(".");
  if (segments.length < 2) {
    return null;
  }
  try {
    return JSON.parse(decodeBase64Url(segments[1])) as JsonRecord;
  } catch {
    return null;
  }
}

function cloneAccountRecord(response: JsonRecord | null) {
  const account = asJsonRecord(response?.account) ?? asJsonRecord(response);
  return account ? { ...account } : {};
}

function shouldApplyAccountFallback(account: JsonRecord) {
  const accountType = trimString(account.type).toLowerCase();
  return (
    Object.keys(account).length === 0 ||
    !accountType ||
    accountType === "chatgpt" ||
    accountType === "unknown"
  );
}

function applyAccountFallback(account: JsonRecord, fallback: AccountFallback) {
  if (!trimString(account.email) && fallback.email) {
    account.email = fallback.email;
  }
  if (!trimString(account.planType) && fallback.planType) {
    account.planType = fallback.planType;
  }
  if (!trimString(account.type) && (fallback.email || fallback.planType)) {
    account.type = "chatgpt";
  }
}

function buildAccountResponse(response: JsonRecord | null, fallback: AccountFallback | null) {
  const account = cloneAccountRecord(response);
  if (fallback && shouldApplyAccountFallback(account)) {
    applyAccountFallback(account, fallback);
  }
  const accountResponse: { account: JsonRecord | null; requiresOpenaiAuth?: boolean } = {
    account: Object.keys(account).length > 0 ? account : null,
  };
  if (typeof response?.requiresOpenaiAuth === "boolean") {
    accountResponse.requiresOpenaiAuth = response.requiresOpenaiAuth;
  }
  return accountResponse;
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

async function directoryExists(targetPath: string) {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function parseTopLevelTomlString(content: string, key: string) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*["']([^"']+)["']\\s*$`, "m"),
  );
  return match?.[1] ?? null;
}

function escapeRuleString(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function formatPrefixRule(pattern: string[]) {
  const items = pattern.map((item) => `"${escapeRuleString(item)}"`).join(", ");
  return `prefix_rule(\n    pattern = [${items}],\n    decision = "allow",\n)\n`;
}

function normalizeRuleValue(value: string) {
  return value.replace(/\s+/g, "");
}

function ruleAlreadyPresent(contents: string, pattern: string[]) {
  const targetPattern = normalizeRuleValue(
    `[${pattern.map((item) => `"${escapeRuleString(item)}"`).join(", ")}]`,
  );
  let inRule = false;
  let patternMatches = false;
  let decisionAllows = false;
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("prefix_rule(")) {
      inRule = true;
      patternMatches = false;
      decisionAllows = false;
      continue;
    }
    if (!inRule) {
      continue;
    }
    if (trimmed.startsWith("pattern")) {
      const [, value = ""] = trimmed.split("=", 2);
      if (normalizeRuleValue(value.replace(/,$/, "").trim()) === targetPattern) {
        patternMatches = true;
      }
      continue;
    }
    if (trimmed.startsWith("decision")) {
      const [, value = ""] = trimmed.split("=", 2);
      if (value.includes('"allow"') || value.includes("'allow'")) {
        decisionAllows = true;
      }
      continue;
    }
    if (trimmed.startsWith(")")) {
      if (patternMatches && decisionAllows) {
        return true;
      }
      inRule = false;
    }
  }
  return false;
}

async function appendPrefixRule(rulesPath: string, pattern: string[]) {
  const existing = await fs.readFile(rulesPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (ruleAlreadyPresent(existing, pattern)) {
    return;
  }
  let updated = existing;
  if (updated && !updated.endsWith("\n")) {
    updated += "\n";
  }
  if (updated) {
    updated += "\n";
  }
  updated += formatPrefixRule(pattern);
  await fs.mkdir(path.dirname(rulesPath), { recursive: true });
  await fs.writeFile(rulesPath, updated, "utf8");
}

export class CodexCompanionServer {
  private static readonly LOCAL_USAGE_CACHE_TTL_MS = 30_000;
  private readonly appServerClients = new Map<string, CodexAppServerClient>();
  private readonly appServerClientWorkspaceIds = new Map<string, Set<string>>();
  private readonly appServerNotificationUnsubscribers = new Map<string, () => void>();
  private readonly appServerThreadWorkspaceIds = new Map<string, string>();
  private readonly connectedWorkspaceIds = new Set<string>();
  private readonly loginStateByWorkspace = new Map<string, LoginState>();
  private readonly threadsById = new Map<string, StoredThread>();
  private readonly workspaceRuntimeCodexArgs = new Map<string, string | null>();
  private readonly workspacesById = new Map<string, StoredWorkspace>();
  private readonly localUsageSnapshotCache = new Map<
    string,
    { expiresAt: number; snapshot: Awaited<ReturnType<typeof buildLocalUsageSnapshot>> }
  >();
  private readonly localUsageSnapshotInFlight = new Map<
    string,
    Promise<Awaited<ReturnType<typeof buildLocalUsageSnapshot>>>
  >();
  private readonly terminalRuntime: TerminalRuntime | null;
  private readonly terminalEnabled: boolean;

  constructor(
    private readonly storage: CompanionStorage,
    private readonly broadcast: BroadcastFn,
    private readonly requestShutdown?: () => void,
    terminalRuntime?: TerminalRuntime | null,
  ) {
    this.terminalRuntime = terminalRuntime ?? createTerminalRuntime(broadcast);
    this.terminalEnabled = this.terminalRuntime !== null;
  }

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
      this.appServerThreadWorkspaceIds.set(this.resolveAppServerThreadId(thread), thread.workspaceId);
    });
  }

  getHealth() {
    return {
      mode: "typescript",
      dataDir: this.dataDir,
      workspaceCount: this.workspacesById.size,
      threadCount: this.threadsById.size,
      connectedWorkspaceCount: this.connectedWorkspaceIds.size,
      appServerClientCount: this.appServerClients.size,
      capabilities: {
        terminal: this.terminalEnabled,
      },
    };
  }

  async close() {
    await Promise.all(Array.from(this.appServerClients.values(), (client) => client.close()));
    await this.terminalRuntime?.closeAll();
    this.appServerClients.clear();
    this.appServerClientWorkspaceIds.clear();
    this.appServerThreadWorkspaceIds.clear();
    this.appServerNotificationUnsubscribers.clear();
  }

  private get dataDir() {
    return path.dirname(this.storage.settingsPath);
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

  private getThreadForWorkspace(workspaceId: string, threadId: string) {
    const thread = this.getThread(threadId);
    if (!thread || thread.workspaceId !== workspaceId) {
      return null;
    }
    return thread;
  }

  private createBacklogItem(text: string): ThreadBacklogItem {
    const now = Date.now();
    return {
      id: randomUUID(),
      text,
      createdAt: now,
      updatedAt: now,
    };
  }

  private sortBacklog(items: ThreadBacklogItem[]) {
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items;
  }

  private findRollbackTarget(thread: StoredThread, messageItemId: string) {
    for (let index = 0; index < thread.turns.length; index += 1) {
      const turn = thread.turns[index];
      const item = turn.items.find((entry) =>
        appServerItemIdMatches(trimString(entry.id), messageItemId),
      );
      if (!item) {
        continue;
      }
      return {
        turnIndex: index,
        turn,
        item,
      };
    }
    return null;
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

  private resolveRuntimeCodexArgs(settings: JsonRecord, workspaceId?: string | null) {
    if (workspaceId) {
      const override = this.workspaceRuntimeCodexArgs.get(workspaceId);
      if (override !== undefined) {
        return override;
      }
    }
    return toNullableString(settings.codexArgs);
  }

  private appServerClientKey(settings: JsonRecord, workspaceId?: string | null) {
    return JSON.stringify({
      codexPath: this.codexCommand(settings),
      codexArgs: this.resolveRuntimeCodexArgs(settings, workspaceId),
    });
  }

  private appServerClientOptions(settings: JsonRecord, workspaceId?: string | null) {
    return {
      codexPath: this.codexCommand(settings),
      cliArgs: parseCodexArgs(this.resolveRuntimeCodexArgs(settings, workspaceId)),
      env: process.env,
      initializeParams: buildAppServerInitializeParams(),
      initTimeoutMs: APP_SERVER_INIT_TIMEOUT_MS,
      requestTimeoutMs: APP_SERVER_REQUEST_TIMEOUT_MS,
    };
  }

  private createDetachedAppServerClient(settings: JsonRecord, workspaceId?: string | null) {
    return new CodexAppServerClient(this.appServerClientOptions(settings, workspaceId));
  }

  private buildAppServerClient(settings: JsonRecord, workspaceId?: string | null) {
    const key = this.appServerClientKey(settings, workspaceId);
    const existing = this.appServerClients.get(key);
    if (workspaceId) {
      const workspaceIds = this.appServerClientWorkspaceIds.get(key) ?? new Set<string>();
      workspaceIds.add(workspaceId);
      this.appServerClientWorkspaceIds.set(key, workspaceIds);
    }
    if (existing) {
      return existing;
    }
    const client = this.createDetachedAppServerClient(settings, workspaceId);
    this.appServerClients.set(key, client);
    this.appServerNotificationUnsubscribers.set(
      key,
      client.onNotification((message) => {
        void this.handleAppServerNotification(key, message);
      }),
    );
    return client;
  }

  private async resetAppServerClients() {
    await Promise.all(Array.from(this.appServerClients.values(), (client) => client.close()));
    this.appServerClients.clear();
    this.appServerClientWorkspaceIds.clear();
    this.appServerNotificationUnsubscribers.clear();
  }

  private hasActiveAppServerRuntime() {
    return this.appServerClients.size > 0;
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
    const activeTurnId = extractActiveTurnIdFromThread(rawThread);
    const appServerName = toNullableString(rawThread.name);
    return {
      id: existing?.id ?? threadId,
      workspaceId,
      sdkThreadId: existing?.sdkThreadId ?? threadId,
      cwd: trimString(rawThread.cwd) || this.getWorkspace(workspaceId)?.path || "",
      createdAt,
      updatedAt,
      archivedAt: existing?.archivedAt ?? null,
      name: existing?.name ?? appServerName,
      preview: trimString(rawThread.preview) || existing?.preview || "New Agent",
      activeTurnId,
      turns,
      modelId: existing?.modelId ?? null,
      effort: existing?.effort ?? null,
      backlog: existing?.backlog ?? [],
      tokenUsage: existing?.tokenUsage ?? null,
    };
  }

  private async listThreadsFromCodexAppServer(
    workspaceId: string,
    cursor: string | null,
    limit: number | null,
    sortKey: "created_at" | "updated_at",
  ) {
    const settings = await this.storage.readSettings();
    const client = this.buildAppServerClient(settings, workspaceId);
    return await client.listThreads({
      cursor,
      limit,
      sortKey,
      sourceKinds: APP_SERVER_SOURCE_KINDS,
    });
  }

  private async resumeThreadFromCodexAppServer(threadId: string) {
    const settings = await this.storage.readSettings();
    const client = this.buildAppServerClient(settings);
    return await client.resumeThread(threadId);
  }

  private updateThreadWorkspaceMapping(thread: StoredThread) {
    this.appServerThreadWorkspaceIds.set(this.resolveAppServerThreadId(thread), thread.workspaceId);
  }

  private findThreadByAppServerThreadId(threadId: string) {
    const mappedWorkspaceId = this.appServerThreadWorkspaceIds.get(threadId) ?? null;
    if (mappedWorkspaceId) {
      const directMatch = Array.from(this.threadsById.values()).find(
        (thread) =>
          thread.workspaceId === mappedWorkspaceId &&
          this.resolveAppServerThreadId(thread) === threadId,
      );
      if (directMatch) {
        return directMatch;
      }
    }
    return this.findThreadBySdkThreadId(threadId);
  }

  private clearStoredActiveTurn(thread: StoredThread, turnId?: string | null) {
    const targetTurnId = turnId ?? thread.activeTurnId;
    if (targetTurnId) {
      const existing = thread.turns.find((entry) => entry.id === targetTurnId);
      if (existing && existing.completedAt === null) {
        existing.completedAt = Date.now();
        if (existing.status === "active") {
          existing.status = "completed";
        }
      }
    }
    thread.activeTurnId = null;
    thread.updatedAt = Date.now();
  }

  private async refreshThreadStateFromAppServer(
    settings: JsonRecord,
    workspaceId: string,
    thread: StoredThread,
  ) {
    const client = this.buildAppServerClient(settings, workspaceId);
    const response = await client.readThreadWithTurns(this.resolveAppServerThreadId(thread));
    const rawThread =
      response.thread && typeof response.thread === "object"
        ? (response.thread as Record<string, unknown>)
        : null;
    if (!rawThread) {
      return thread;
    }
    const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread, thread);
    this.threadsById.set(stored.id, stored);
    this.updateThreadWorkspaceMapping(stored);
    await this.persistThreads();
    return stored;
  }

  private upsertStoredTurn(
    thread: StoredThread,
    rawTurn: Record<string, unknown>,
    completedFallback = Date.now(),
  ) {
    const threadId = this.resolveAppServerThreadId(thread);
    const existingIndex = thread.turns.findIndex(
      (entry) => entry.id === (trimString(rawTurn.id) || ""),
    );
    const nextTurn = buildStoredTurnFromAppServerThread(
      threadId,
      thread.createdAt,
      completedFallback,
      rawTurn,
      existingIndex >= 0 ? existingIndex : thread.turns.length,
      existingIndex >= 0 ? thread.turns[existingIndex] : undefined,
    );
    if (existingIndex >= 0) {
      thread.turns[existingIndex] = nextTurn;
    } else {
      thread.turns.push(nextTurn);
    }
    return nextTurn;
  }

  private upsertStoredItem(
    thread: StoredThread,
    turnId: string,
    item: JsonRecord,
  ) {
    const turn = thread.turns.find((entry) => entry.id === turnId);
    if (!turn) {
      return null;
    }
    const storedItem = toStoredItemFromAppServer(turnId, item);
    const existingIndex = turn.items.findIndex((entry) => entry.id === storedItem.id);
    if (existingIndex >= 0) {
      turn.items[existingIndex] = storedItem;
    } else {
      turn.items.push(storedItem);
    }
    return storedItem;
  }

  private workspaceIdsForClient(key: string) {
    const workspaceIds = this.appServerClientWorkspaceIds.get(key);
    if (workspaceIds && workspaceIds.size > 0) {
      return Array.from(workspaceIds);
    }
    return Array.from(this.connectedWorkspaceIds);
  }

  private findStoredThreadForTurn(workspaceIds: string[], turnId: string) {
    for (const thread of this.threadsById.values()) {
      if (!workspaceIds.includes(thread.workspaceId)) {
        continue;
      }
      if (thread.activeTurnId === turnId || thread.turns.some((turn) => turn.id === turnId)) {
        return thread;
      }
    }
    return null;
  }

  private findStoredThreadByTurnId(turnId: string) {
    for (const thread of this.threadsById.values()) {
      if (thread.activeTurnId === turnId || thread.turns.some((turn) => turn.id === turnId)) {
        return thread;
      }
    }
    return null;
  }

  private inferThreadIdForNotification(workspaceIds: string[], params: JsonRecord) {
    const turnId = extractTurnIdFromParams(params);
    if (turnId) {
      const thread = this.findStoredThreadForTurn(workspaceIds, turnId);
      if (thread) {
        return this.resolveAppServerThreadId(thread);
      }
    }
    if (workspaceIds.length !== 1) {
      return null;
    }
    const activeThreads = Array.from(this.threadsById.values()).filter(
      (thread) => thread.workspaceId === workspaceIds[0] && Boolean(thread.activeTurnId),
    );
    if (activeThreads.length === 1) {
      return this.resolveAppServerThreadId(activeThreads[0]!);
    }
    return null;
  }

  private enrichNotificationParams(workspaceIds: string[], params: JsonRecord) {
    if (extractThreadIdFromParams(params)) {
      return params;
    }
    const inferredThreadId = this.inferThreadIdForNotification(workspaceIds, params);
    if (!inferredThreadId) {
      return params;
    }
    return {
      ...params,
      threadId: inferredThreadId,
    };
  }

  private resolveWorkspaceIdsForNotification(
    key: string,
    method: string,
    params: JsonRecord,
  ) {
    const threadId = extractThreadIdFromParams(params);
    if (threadId) {
      const workspaceId = this.appServerThreadWorkspaceIds.get(threadId);
      if (workspaceId) {
        return [workspaceId];
      }
    }
    const turnId = extractTurnIdFromParams(params);
    if (turnId) {
      const thread = this.findStoredThreadByTurnId(turnId);
      if (thread) {
        return [thread.workspaceId];
      }
    }
    if (method === "thread/started") {
      const thread =
        params.thread && typeof params.thread === "object" && !Array.isArray(params.thread)
          ? (params.thread as JsonRecord)
          : null;
      const workspaceId =
        (thread ? this.resolveWorkspaceIdForCwd(trimString(thread.cwd)) : null) ??
        null;
      if (workspaceId) {
        return [workspaceId];
      }
    }
    if (APP_SERVER_GLOBAL_NOTIFICATION_METHODS.has(method)) {
      return this.workspaceIdsForClient(key);
    }
    return [];
  }

  private async applyAppServerNotificationToState(
    workspaceIds: string[],
    method: string,
    params: JsonRecord,
  ) {
    if (workspaceIds.length === 0) {
      return false;
    }
    const threadId = extractThreadIdFromParams(params);
    const workspaceId = workspaceIds[0]!;
    if (method === "thread/started") {
      const rawThread =
        params.thread && typeof params.thread === "object" && !Array.isArray(params.thread)
          ? (params.thread as Record<string, unknown>)
          : null;
      if (!rawThread) {
        return false;
      }
      const existing = threadId ? this.findThreadByAppServerThreadId(threadId) : null;
      const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread, existing);
      this.threadsById.set(stored.id, stored);
      this.updateThreadWorkspaceMapping(stored);
      await this.persistThreads();
      return true;
    }
    if (!threadId) {
      return false;
    }
    const thread = this.findThreadByAppServerThreadId(threadId);
    if (!thread) {
      return false;
    }
    let shouldPersist = false;
    switch (method) {
      case "thread/name/updated":
        thread.name = toNullableString(params.threadName) ?? toNullableString(params.thread_name);
        thread.updatedAt = Date.now();
        shouldPersist = true;
        break;
      case "thread/archived":
        thread.archivedAt = Date.now();
        thread.updatedAt = Date.now();
        shouldPersist = true;
        break;
      case "thread/unarchived":
        thread.archivedAt = null;
        thread.updatedAt = Date.now();
        shouldPersist = true;
        break;
      case "thread/closed":
        thread.activeTurnId = null;
        thread.updatedAt = Date.now();
        shouldPersist = true;
        break;
      case "turn/started": {
        const rawTurn =
          params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
            ? (params.turn as Record<string, unknown>)
            : null;
        if (!rawTurn) {
          break;
        }
        const turn = this.upsertStoredTurn(thread, rawTurn);
        thread.activeTurnId = turn.id;
        thread.updatedAt = Date.now();
        shouldPersist = true;
        break;
      }
      case "turn/completed": {
        const rawTurn =
          params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
            ? (params.turn as Record<string, unknown>)
            : null;
        if (rawTurn) {
          const turn = this.upsertStoredTurn(thread, rawTurn);
          turn.status = "completed";
          turn.completedAt = Date.now();
          this.clearStoredActiveTurn(thread, turn.id);
          shouldPersist = true;
          break;
        }
        const turnId = extractTurnIdFromParams(params);
        if (turnId) {
          this.clearStoredActiveTurn(thread, turnId);
          shouldPersist = true;
        }
        break;
      }
      case "thread/status/changed": {
        const statusType = normalizeThreadStatusType(params.status);
        if (
          statusType === "idle" ||
          statusType === "notloaded" ||
          statusType === "systemerror"
        ) {
          this.clearStoredActiveTurn(thread);
          shouldPersist = true;
        }
        break;
      }
      case "item/started":
      case "item/completed": {
        const turnId = extractTurnIdFromParams(params);
        const item =
          params.item && typeof params.item === "object" && !Array.isArray(params.item)
            ? (params.item as JsonRecord)
            : null;
        if (!turnId || !item) {
          break;
        }
        this.upsertStoredItem(thread, turnId, item);
        thread.updatedAt = Date.now();
        shouldPersist = method === "item/completed";
        break;
      }
      case "thread/tokenUsage/updated":
        if (params.tokenUsage && typeof params.tokenUsage === "object" && !Array.isArray(params.tokenUsage)) {
          thread.tokenUsage = params.tokenUsage as StoredThread["tokenUsage"];
          thread.updatedAt = Date.now();
          shouldPersist = true;
        }
        break;
      case "error": {
        const turn =
          params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
            ? (params.turn as JsonRecord)
            : null;
        const turnId = trimString(turn?.id);
        if (turnId) {
          const existing = thread.turns.find((entry) => entry.id === turnId);
          if (existing) {
            existing.status = "failed";
            existing.completedAt = Date.now();
            existing.errorMessage = trimString(params.message) || existing.errorMessage;
            this.clearStoredActiveTurn(thread, turnId);
            shouldPersist = true;
          }
        }
        break;
      }
      default:
        break;
    }
    if (shouldPersist) {
      await this.persistThreads();
    }
    return shouldPersist;
  }

  private async handleAppServerNotification(
    key: string,
    message: AppServerNotificationMessage,
  ) {
    const workspaceIds = this.resolveWorkspaceIdsForNotification(key, message.method, message.params);
    const normalizedParams = this.enrichNotificationParams(workspaceIds, message.params);
    await this.applyAppServerNotificationToState(workspaceIds, message.method, normalizedParams);
    for (const workspaceId of workspaceIds) {
      this.broadcast({
        event: "app-server-event",
        payload: buildAppServerEvent(workspaceId, message.method, normalizedParams, message.id),
      });
    }
  }

  private resolveCodexHomePath() {
    return path.dirname(this.storage.globalConfigPath());
  }

  private async readAuthAccountFallback(): Promise<AccountFallback | null> {
    const authPath = path.join(this.resolveCodexHomePath(), "auth.json");
    try {
      const raw = JSON.parse(await fs.readFile(authPath, "utf8")) as JsonRecord;
      const tokens =
        raw.tokens && typeof raw.tokens === "object" ? (raw.tokens as JsonRecord) : null;
      const idToken = trimString(tokens?.idToken) || trimString(tokens?.id_token);
      if (!idToken) {
        return null;
      }
      const payload = readJwtPayload(idToken);
      if (!payload) {
        return null;
      }
      const auth =
        payload[OPENAI_AUTH_CLAIM] &&
        typeof payload[OPENAI_AUTH_CLAIM] === "object"
          ? (payload[OPENAI_AUTH_CLAIM] as JsonRecord)
          : null;
      const profile =
        payload[OPENAI_PROFILE_CLAIM] &&
        typeof payload[OPENAI_PROFILE_CLAIM] === "object"
          ? (payload[OPENAI_PROFILE_CLAIM] as JsonRecord)
          : null;
      const email =
        toNullableString(payload.email) ?? toNullableString(profile?.email) ?? null;
      const planType =
        toNullableString(auth?.chatgpt_plan_type) ??
        toNullableString(payload.chatgpt_plan_type) ??
        null;
      if (!email && !planType) {
        return null;
      }
      return { email, planType };
    } catch {
      return null;
    }
  }

  private async readAccountInfo(workspaceId: string) {
    const settings = await this.storage.readSettings();
    const client = this.buildAppServerClient(settings, workspaceId);
    let response: JsonRecord | null = null;
    try {
      response = await client.accountRead();
    } catch {
      response = null;
    }
    return buildAccountResponse(response, await this.readAuthAccountFallback());
  }

  private getOrCreateLoginState(workspaceId: string) {
    const existing = this.loginStateByWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }
    const created: LoginState = { canceled: false, loginId: null, pending: null };
    this.loginStateByWorkspace.set(workspaceId, created);
    return created;
  }

  private async startCodexLogin(workspaceId: string) {
    const state = this.getOrCreateLoginState(workspaceId);
    state.canceled = false;
    const settings = await this.storage.readSettings();
    const client = this.buildAppServerClient(settings, workspaceId);
    const pending = client.startLogin("chatgpt");
    state.pending = pending;
    try {
      const response = await pending;
      const loginId =
        toNullableString(response.loginId) ?? toNullableString(response.login_id) ?? null;
      state.loginId = loginId;
      return {
        loginId,
        authUrl:
          toNullableString(response.authUrl) ?? toNullableString(response.auth_url) ?? null,
        raw: response,
      };
    } finally {
      state.pending = null;
    }
  }

  private async cancelCodexLogin(workspaceId: string) {
    const state = this.getOrCreateLoginState(workspaceId);
    if (state.pending) {
      state.canceled = true;
      state.loginId = null;
      return { canceled: true, status: "canceled" };
    }
    if (!state.loginId) {
      return { canceled: false };
    }
    const settings = await this.storage.readSettings();
    const client = this.buildAppServerClient(settings, workspaceId);
    const response = await client.cancelLogin(state.loginId);
    const canceled = Boolean(
      response.canceled ??
        response.cancelled ??
        response.ok ??
        true,
    );
    const status =
      toNullableString(response.status) ??
      (canceled ? "canceled" : "unknown");
    state.loginId = null;
    return { canceled, status, raw: response };
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
    this.updateThreadWorkspaceMapping(stored);
    await this.persistThreads();
    return stored;
  }

  private async runDetachedBackgroundPrompt(
    workspace: StoredWorkspace,
    prompt: string,
    options: {
      model?: string | null;
      outputSchema?: unknown;
      timeoutMessage: string;
      turnErrorFallback: string;
    },
  ) {
    const settings = await this.storage.readSettings();
    const client = this.createDetachedAppServerClient(settings, workspace.id);
    let threadId: string | null = null;
    try {
      const threadResponse = await client.startThread({
        cwd: workspace.path,
        approvalPolicy: "never",
      });
      threadId = extractThreadIdFromParams(threadResponse);
      if (!threadId) {
        throw new Error("Detached background thread did not return an id.");
      }
      this.emit(workspace.id, "codex/backgroundThread", {
        threadId,
        action: "hide",
      });

      let responseText = "";
      const unsubscribe = client.onNotification((message) => {
        if (message.method !== "item/agentMessage/delta") {
          return;
        }
        const messageThreadId = extractThreadIdFromParams(message.params);
        if (messageThreadId && messageThreadId !== threadId) {
          return;
        }
        const delta = typeof message.params.delta === "string" ? message.params.delta : "";
        if (delta) {
          responseText += delta;
        }
      });

      let expectedTurnId: string | null = null;
      const completion = client.waitForNotification((message) => {
        if (message.method !== "turn/completed") {
          return null;
        }
        const completedThreadId = extractThreadIdFromParams(message.params);
        if (completedThreadId !== threadId) {
          return null;
        }
        const completedTurnId = extractTurnIdFromParams(message.params);
        if (expectedTurnId && completedTurnId && completedTurnId !== expectedTurnId) {
          return null;
        }
        return message.params;
      });

      const turnResponse = await client.startTurn({
        threadId,
        input: buildAppServerUserInputItems(prompt),
        cwd: workspace.path,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
        model: options.model ?? undefined,
        outputSchema: options.outputSchema,
      });
      expectedTurnId = extractTurnIdFromParams(turnResponse);

      const completed = await completion;
      unsubscribe();
      const completedTurn =
        completed.turn && typeof completed.turn === "object" && !Array.isArray(completed.turn)
          ? (completed.turn as JsonRecord)
          : null;
      const status = trimString(completedTurn?.status).toLowerCase();
      if (status && status !== "completed") {
        const turnError =
          (completedTurn?.error && typeof completedTurn.error === "object"
            ? trimString((completedTurn.error as JsonRecord).message)
            : "") || trimString(completed.message);
        throw new Error(turnError || options.turnErrorFallback);
      }
      if (responseText.trim()) {
        return responseText.trim();
      }

      const threadRead = await client.readThreadWithTurns(threadId);
      const rawThread =
        threadRead.thread && typeof threadRead.thread === "object" && !Array.isArray(threadRead.thread)
          ? (threadRead.thread as JsonRecord)
          : threadRead;
      return findLastAgentMessageText(rawThread, expectedTurnId).trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Timed out while waiting for app-server notification.")) {
        throw new Error(options.timeoutMessage, { cause: error });
      }
      throw error;
    } finally {
      if (threadId) {
        await client.archiveThread(threadId).catch(() => undefined);
      }
      await client.close();
    }
  }

  private async generateRunMetadataForWorkspace(workspace: StoredWorkspace, prompt: string) {
    const cleanedPrompt = prompt.trim();
    if (!cleanedPrompt) {
      throw new Error("Prompt is required.");
    }
    const response = await this.runDetachedBackgroundPrompt(
      workspace,
      buildRunMetadataPrompt(cleanedPrompt),
      {
        outputSchema: RUN_METADATA_OUTPUT_SCHEMA,
        timeoutMessage: "Timeout waiting for metadata generation",
        turnErrorFallback: "Unknown error during metadata generation",
      },
    );
    return parseRunMetadataValue(response);
  }

  private async generateCommitMessageForWorkspace(
    workspace: StoredWorkspace,
    commitMessageModelId: string | null,
  ) {
    const settings = await this.storage.readSettings();
    const diffs = await buildWorkingTreeDiffs(workspace.path);
    const diff = diffs
      .map((entry) => entry.diff)
      .filter((entry) => entry.trim().length > 0)
      .join("\n");
    const prompt = buildCommitMessagePromptForDiff(diff, String(settings.commitMessagePrompt ?? ""));
    return await this.runDetachedBackgroundPrompt(workspace, prompt, {
      model: commitMessageModelId,
      timeoutMessage: "Timeout waiting for commit message generation",
      turnErrorFallback: "Unknown error during commit message generation",
    });
  }

  private async generateAgentDescriptionForWorkspace(
    workspace: StoredWorkspace,
    description: string,
  ) {
    const cleanedDescription = description.trim();
    if (!cleanedDescription) {
      throw new Error("Description is required.");
    }
    const response = await this.runDetachedBackgroundPrompt(
      workspace,
      buildAgentDescriptionPrompt(cleanedDescription),
      {
        timeoutMessage: "Timeout waiting for agent configuration generation",
        turnErrorFallback: "Unknown error during agent configuration generation",
      },
    );
    return parseAgentDescriptionValue(response);
  }

  private async runCodexDoctor(codexBin: string | null, codexArgs: string | null) {
    const settings = await this.storage.readSettings();
    const resolvedBin = codexBin?.trim() ? codexBin.trim() : this.codexCommand(settings);
    const resolvedArgs = codexArgs?.trim()
      ? codexArgs.trim()
      : this.resolveRuntimeCodexArgs(settings, null);
    const pathEnv = buildCodexPathEnv(resolvedBin);
    const env = pathEnv ? { ...process.env, PATH: pathEnv } : process.env;
    const versionResult = await runCommandCapture(resolvedBin, ["--version"], { env });
    const version = versionResult.ok
      ? toNullableString(versionResult.stdout) ?? toNullableString(versionResult.stderr)
      : null;
    const appServerResult = await runCommandCapture(
      resolvedBin,
      [...parseCodexArgs(resolvedArgs), "app-server", "--help"],
      { env },
    );
    const nodeResult = await runCommandCapture("node", ["--version"], { env });
    const nodeVersion = nodeResult.ok
      ? toNullableString(nodeResult.stdout) ?? toNullableString(nodeResult.stderr)
      : null;
    const nodeDetails = nodeResult.ok
      ? null
      : nodeResult.error || "Node failed to start.";
    const details = appServerResult.ok
      ? null
      : appServerResult.error || "Failed to run `codex app-server --help`.";
    return {
      ok: Boolean(version) && appServerResult.ok,
      codexBin: resolvedBin,
      version,
      appServerOk: appServerResult.ok,
      details,
      path: pathEnv,
      nodeOk: Boolean(nodeVersion),
      nodeVersion,
      nodeDetails,
    };
  }

  private async getLocalUsageSnapshot(days: number | null, workspacePath: string | null) {
    const requestedDays = Number.isFinite(days) ? Math.trunc(days ?? 30) : 30;
    const clampedDays = Math.min(Math.max(requestedDays || 30, 1), 90);
    const normalizedWorkspacePath = toNullableString(workspacePath)
      ? normalizeRootPath(String(workspacePath))
      : null;
    const cacheKey = JSON.stringify({
      days: clampedDays,
      workspacePath: normalizedWorkspacePath,
    });
    const now = Date.now();
    const cached = this.localUsageSnapshotCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.snapshot;
    }
    const inFlight = this.localUsageSnapshotInFlight.get(cacheKey);
    if (inFlight) {
      return await inFlight;
    }
    const sessionsRoots = [path.join(this.storage.codexHome, "sessions")];
    const loadPromise = buildLocalUsageSnapshot(
      sessionsRoots,
      clampedDays,
      normalizedWorkspacePath,
    );
    this.localUsageSnapshotInFlight.set(cacheKey, loadPromise);
    try {
      const snapshot = await loadPromise;
      this.localUsageSnapshotCache.set(cacheKey, {
        expiresAt: now + CodexCompanionServer.LOCAL_USAGE_CACHE_TTL_MS,
        snapshot,
      });
      return snapshot;
    } finally {
      this.localUsageSnapshotInFlight.delete(cacheKey);
    }
  }

  private async addWorkspaceFromPath(
    targetPath: string,
  ): Promise<(StoredWorkspace & { connected: boolean }) | RpcErrorShape> {
    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) {
        return notFound("Workspace path is not a directory.");
      }
    } catch {
      return badRequest("Workspace path is not accessible.");
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

  private async addCloneWorkspace(
    sourceWorkspaceId: string,
    copiesFolder: string,
    copyName: string,
  ): Promise<unknown | RpcErrorShape> {
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

  private connectWorkspace(workspaceId: string): unknown | RpcErrorShape {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      return notFound("Workspace not found.");
    }
    this.connectedWorkspaceIds.add(workspaceId);
    this.emit(workspaceId, "codex/connected", {});
    return null;
  }

  private async removeWorkspaceCascade(workspaceId: string): Promise<unknown | RpcErrorShape> {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      return notFound("Workspace not found.");
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

  private openWorkspaceIn(targetPath: string): unknown | RpcErrorShape {
    const normalizedPath = trimString(targetPath);
    if (!normalizedPath) {
      return badRequest("path is required.");
    }
    if (isHttpUrl(normalizedPath)) {
      return null;
    }
    return badRequest("open_workspace_in only supports http(s) URLs in the web companion.");
  }

  private async setWorkspaceRuntimeCodexArgs(
    params: JsonRecord,
  ): Promise<unknown | RpcErrorShape> {
    const workspaceId = String(params.workspaceId ?? "");
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      return notFound("Workspace not found.");
    }
    const settings = await this.storage.readSettings();
    const nextArgs =
      params.codexArgs === null || params.codexArgs === undefined
        ? toNullableString(settings.codexArgs)
        : toNullableString(params.codexArgs);
    const previousArgs = this.resolveRuntimeCodexArgs(settings, workspaceId);
    if (params.codexArgs === null || params.codexArgs === undefined) {
      this.workspaceRuntimeCodexArgs.delete(workspaceId);
    } else {
      this.workspaceRuntimeCodexArgs.set(workspaceId, nextArgs);
    }
    const respawned =
      this.connectedWorkspaceIds.has(workspaceId) &&
      this.hasActiveAppServerRuntime() &&
      previousArgs !== nextArgs;
    if (respawned) {
      await this.resetAppServerClients();
    }
    return {
      appliedCodexArgs: nextArgs,
      respawned,
    };
  }

  private async handleWorkspaceGitRpc(
    method: string,
    params: JsonRecord,
  ): Promise<unknown | RpcErrorShape | undefined> {
    return await dispatchWorkspaceGitRpc(
      this.createWorkspaceGitRpcContext(),
      method,
      params,
    );
  }

  private createWorkspaceRpcContext() {
    return {
      listWorkspaces: () => Array.from(this.workspacesById.values()),
      isWorkspaceConnected: (workspaceId: string) => this.connectedWorkspaceIds.has(workspaceId),
      directoryExists,
      addWorkspaceFromPath: this.addWorkspaceFromPath.bind(this),
      handleWorkspaceGitRpc: this.handleWorkspaceGitRpc.bind(this),
      addCloneWorkspace: this.addCloneWorkspace.bind(this),
      connectWorkspace: this.connectWorkspace.bind(this),
      updateWorkspaceSettingsRecord: this.updateWorkspaceSettingsRecord.bind(this),
      removeWorkspaceCascade: this.removeWorkspaceCascade.bind(this),
      openWorkspaceIn: this.openWorkspaceIn.bind(this),
      setWorkspaceRuntimeCodexArgs: this.setWorkspaceRuntimeCodexArgs.bind(this),
    };
  }

  private async handleWorkspaceRpc(
    method: string,
    params: JsonRecord,
  ): Promise<RpcDispatchResult> {
    const result = await dispatchWorkspaceRpc(
      this.createWorkspaceRpcContext(),
      method,
      params,
    );
    return result === undefined ? RPC_UNHANDLED : result;
  }

  private async handleCompanionRuntimeRpc(
    method: string,
    params: JsonRecord,
  ): Promise<RpcDispatchResult> {
    const result = await dispatchCompanionRuntimeRpc(
      {
        terminalRuntime: this.terminalRuntime,
        getWorkspace: this.getWorkspace.bind(this),
        getLocalUsageSnapshot: this.getLocalUsageSnapshot.bind(this),
        runCodexDoctor: this.runCodexDoctor.bind(this),
        badRequest,
        notFound,
      },
      method,
      params,
    );
    return result === undefined ? RPC_UNHANDLED : result;
  }

  private async handleAgentsRpc(
    method: string,
    params: JsonRecord,
  ): Promise<RpcDispatchResult> {
    const result = await dispatchAgentsRpc(
      {
        codexHome: this.storage.codexHome,
        badRequest,
      },
      method,
      params,
    );
    return result === undefined ? RPC_UNHANDLED : result;
  }

  private async handlePromptRpc(
    method: string,
    params: JsonRecord,
  ): Promise<RpcDispatchResult> {
    const result = await dispatchPromptRpc(
      {
        storage: this.storage,
        getWorkspace: this.getWorkspace.bind(this),
        badRequest,
        notFound,
        mapPathValidationError,
      },
      method,
      params,
    );
    return result === undefined ? RPC_UNHANDLED : result;
  }

  private createGitRpcContext() {
    return {
      getWorkspace: this.getWorkspace.bind(this),
      trimString,
      notFound,
      badRequest,
      rpcBoundaryError,
      initializeGitRepo,
      createGitHubRepo,
      runGit,
      runGitCommit,
      tryRunGit,
      resolveGitRootFromPath,
      listLocalGitBranches,
      getGitHubIssues,
      getGitHubPullRequests,
      getGitHubPullRequestDiff,
      getGitHubPullRequestComments,
      checkoutGitHubPullRequest,
      buildGitStatusSummary,
      scanGitRoots,
      buildWorkingTreeDiffs,
      getGitLogSummary,
      getCommitDiffEntries,
      getPreferredRemote,
    };
  }

  private createWorkspaceGitRpcContext() {
    return {
      dataDir: this.dataDir,
      getWorkspace: this.getWorkspace.bind(this),
      addWorkspaceFromPath: this.addWorkspaceFromPath.bind(this),
      setWorkspace: (workspace: StoredWorkspace) => {
        this.workspacesById.set(workspace.id, workspace);
      },
      persistWorkspaces: this.persistWorkspaces.bind(this),
      isWorkspaceConnected: (workspaceId: string) => this.connectedWorkspaceIds.has(workspaceId),
      createWorkspaceId: () => `ws-${randomUUID()}`,
      defaultWorkspaceSettings,
      slugifyAgentName: (name: string) =>
        name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, "") || "agent",
      trimString,
      toNullableString,
      pathExists,
      notFound,
      badRequest,
      rpcBoundaryError,
      resolveGitRootFromPath,
      runGit,
      tryRunGit,
      cloneRepository,
      runGitNoIndexDiff,
      applyGitPatch,
    };
  }

  private async handleGitRpc(
    method: string,
    params: JsonRecord,
  ): Promise<RpcDispatchResult> {
    const result = await dispatchGitRpc(
      this.createGitRpcContext(),
      method,
      params,
    );
    return result === undefined ? RPC_UNHANDLED : result;
  }

  private listLocalThreadSummaries(
    workspaceId: string,
    sortKey: "created_at" | "updated_at",
  ): ThreadSummary[] {
    return Array.from(this.threadsById.values())
      .filter((thread) => thread.workspaceId === workspaceId && thread.archivedAt === null)
      .sort((left, right) =>
        sortKey === "created_at"
          ? right.createdAt - left.createdAt
          : right.updatedAt - left.updatedAt,
      )
      .map(toThreadSummary);
  }

  private mergeThreadListData(
    workspaceId: string,
    localOnlyThreads: ThreadSummary[],
    externalData: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const merged = new Map<string, Record<string, unknown>>();
    const matchedLocalIds = new Set<string>();

    externalData.forEach((thread) => {
      const externalId = trimString(thread.id);
      if (!externalId) {
        return;
      }
      const localThread = this.findThreadBySdkThreadId(externalId);
      if (localThread) {
        if (localThread.workspaceId !== workspaceId) {
          return;
        }
        if (localThread.archivedAt !== null) {
          matchedLocalIds.add(localThread.id);
          return;
        }
        matchedLocalIds.add(localThread.id);
        const externalActiveTurnId = extractActiveTurnIdFromThread(thread);
        const externalUpdatedAt = Number(thread.updatedAt ?? thread.updated_at ?? 0);
        const externalCreatedAt = Number(thread.createdAt ?? thread.created_at ?? 0);
        const externalModel = trimString(thread.model);
        const externalEffort = trimString(thread.modelReasoningEffort ?? thread.model_reasoning_effort);
        merged.set(localThread.id, {
          ...thread,
          id: localThread.id,
          cwd: localThread.cwd || trimString(thread.cwd),
          preview: localThread.name ?? trimString(thread.preview) ?? localThread.preview,
          createdAt: externalCreatedAt || localThread.createdAt,
          updatedAt: externalUpdatedAt || localThread.updatedAt,
          ...(externalActiveTurnId ? { activeTurnId: externalActiveTurnId } : {}),
          ...(externalModel || localThread.modelId
            ? { model: externalModel || localThread.modelId }
            : {}),
          ...(externalEffort || localThread.effort
            ? {
                modelReasoningEffort: externalEffort || localThread.effort,
              }
            : {}),
        });
        return;
      }
      merged.set(externalId, thread);
    });

    localOnlyThreads.forEach((thread) => {
      if (!matchedLocalIds.has(thread.id)) {
        merged.set(thread.id, { ...thread });
      }
    });

    return Array.from(merged.values());
  }

  private async listThreadsRpc(params: JsonRecord): Promise<unknown | RpcErrorShape> {
    const workspaceId = String(params.workspaceId ?? "");
    const sortKey =
      String(params.sortKey ?? "updated_at") === "created_at" ? "created_at" : "updated_at";
    const cursor = toNullableString(params.cursor);
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : null;
    if (!this.getWorkspace(workspaceId)) {
      return notFound("Workspace not found.");
    }

    const localOnlyThreads = this.listLocalThreadSummaries(workspaceId, sortKey);

    try {
      const result = await this.listThreadsFromCodexAppServer(
        workspaceId,
        cursor,
        limit,
        sortKey,
      );
      const externalData = Array.isArray(result.data)
        ? (result.data as Record<string, unknown>[])
        : [];
      return {
        data: this.mergeThreadListData(workspaceId, localOnlyThreads, externalData),
        nextCursor: result.nextCursor ?? result.next_cursor ?? null,
      };
    } catch (error) {
      return {
        data: localOnlyThreads,
        nextCursor: null,
        degraded: {
          source: "local_cache",
          reason: errorMessage(error),
        },
      };
    }
  }

  private async resumeThreadRpc(params: JsonRecord): Promise<unknown | RpcErrorShape> {
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
    } catch (error) {
      if (!thread) {
        return notFound("Thread not found.");
      }
      return {
        thread: toThreadResponse(thread),
        degraded: {
          source: "local_cache",
          reason: errorMessage(error),
        },
      };
    }
  }

  private async handleThreadBacklogRpc(
    method: string,
    params: JsonRecord,
  ): Promise<RpcDispatchResult> {
    const result = await dispatchThreadBacklogRpc(
      {
        getThreadForWorkspace: this.getThreadForWorkspace.bind(this),
        createBacklogItem: this.createBacklogItem.bind(this),
        sortBacklog: this.sortBacklog.bind(this),
        persistThreads: this.persistThreads.bind(this),
        notFound,
        badRequest,
      },
      method,
      params,
    );
    return result === undefined ? RPC_UNHANDLED : result;
  }

  async handleRpc(
    method: string,
    params: JsonRecord,
  ): Promise<unknown | RpcErrorShape> {
    switch (method) {
      case "ping":
        return { ok: true };
      case "daemon_info":
        return {
          name: "codex-monitor-web",
          version: process.env.npm_package_version?.trim() || "0.0.0",
          pid: process.pid,
          mode: "typescript",
          transport: "http",
          binaryPath: process.execPath,
          capabilities: {
            terminal: this.terminalEnabled,
          },
        };
      case "daemon_shutdown":
        queueMicrotask(() => {
          this.requestShutdown?.();
        });
        return { ok: true };
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
      case "is_workspace_path_dir":
      case "add_workspace":
      case "add_workspace_from_git_url":
      case "add_clone":
      case "add_worktree":
      case "connect_workspace":
      case "update_workspace_settings":
      case "remove_workspace":
      case "remove_worktree":
      case "rename_worktree":
      case "rename_worktree_upstream":
      case "apply_worktree_changes":
      case "worktree_setup_status":
      case "worktree_setup_mark_ran":
      case "open_workspace_in":
      case "get_open_app_icon":
      case "set_workspace_runtime_codex_args":
        return await this.handleWorkspaceRpc(method, params);
      case "prompts_list":
      case "prompts_workspace_dir":
      case "prompts_global_dir":
      case "prompts_create":
      case "prompts_update":
      case "prompts_delete":
      case "prompts_move":
        return await this.handlePromptRpc(method, params);
      case "read_image_as_data_url":
      case "list_workspace_files":
      case "read_workspace_file":
        return (
          (await dispatchWorkspaceFileRpc(
            {
              storage: this.storage,
              getWorkspace: this.getWorkspace.bind(this),
              badRequest,
              notFound,
            },
            method,
            params,
          )) ?? RPC_UNHANDLED
        );
      case "fetch_git":
      case "sync_git":
      case "list_git_branches":
      case "checkout_git_branch":
      case "create_git_branch":
      case "get_github_issues":
      case "get_github_pull_requests":
      case "get_github_pull_request_diff":
      case "get_github_pull_request_comments":
      case "checkout_github_pull_request":
      case "get_git_status":
      case "list_git_roots":
      case "get_git_diffs":
      case "get_git_log":
      case "get_git_commit_diff":
      case "get_git_remote":
      case "stage_git_file":
      case "stage_git_all":
      case "unstage_git_file":
      case "revert_git_file":
      case "revert_git_all":
      case "commit_git":
      case "push_git":
      case "pull_git":
      case "init_git_repo":
      case "create_github_repo":
        return await this.handleGitRpc(method, params);
      case "file_read":
      case "file_write":
        return (
          (await dispatchScopedFileRpc(
            {
              storage: this.storage,
              getWorkspace: this.getWorkspace.bind(this),
              badRequest,
              notFound,
            },
            method,
            params,
          )) ?? RPC_UNHANDLED
        );
      case "start_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          const settings = await this.storage.readSettings();
          const client = this.buildAppServerClient(settings, workspaceId);
          const response = await client.startThread({
            cwd: workspace.path,
            approvalPolicy: "on-request",
          });
          const rawThread =
            response.thread && typeof response.thread === "object"
              ? (response.thread as Record<string, unknown>)
              : null;
          if (!rawThread) {
            return badRequest("codex app-server did not return a thread.");
          }
          const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread);
          stored.modelId = toNullableString(response.model) ?? stored.modelId;
          this.threadsById.set(stored.id, stored);
          this.updateThreadWorkspaceMapping(stored);
          await this.persistThreads();
          return {
            thread: {
              id: stored.id,
              preview: stored.preview,
              createdAt: stored.createdAt,
              updatedAt: stored.updatedAt,
              cwd: stored.cwd,
            },
          };
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "send_user_message": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        let thread = this.getThread(threadId) ?? this.findThreadBySdkThreadId(threadId);
        if (!workspace || !thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread or workspace not found.");
        }
        try {
          const settings = await this.storage.readSettings();
          const client = this.buildAppServerClient(settings, workspaceId);
          if (thread.activeTurnId) {
            thread = await this.refreshThreadStateFromAppServer(settings, workspaceId, thread);
            if (thread.activeTurnId) {
              return notFound("A turn is already active for this thread.");
            }
          }
          const accessMode = toNullableString(params.accessMode);
          const serviceTier = getOptionalServiceTier(params, "serviceTier");
          const response = await client.startTurn({
            threadId: this.resolveAppServerThreadId(thread),
            input: buildAppServerUserInputItems(
              String(params.text ?? ""),
              Array.isArray(params.images)
                ? params.images.filter((entry): entry is string => typeof entry === "string")
                : [],
              params.appMentions,
            ),
            cwd: workspace.path,
            approvalPolicy: approvalPolicyForAccessMode(accessMode),
            sandboxPolicy: buildSandboxPolicy(workspace.path, accessMode),
            model: toNullableString(params.model),
            effort: toNullableString(params.effort),
            ...(serviceTier !== undefined ? { serviceTier } : {}),
            collaborationMode: params.collaborationMode ?? null,
          });
          const rawTurn =
            response.turn && typeof response.turn === "object"
              ? (response.turn as Record<string, unknown>)
              : null;
          if (!rawTurn) {
            return badRequest("codex app-server did not return a turn.");
          }
          const storedTurn = this.upsertStoredTurn(thread, rawTurn);
          thread.activeTurnId = storedTurn.id;
          thread.updatedAt = Date.now();
          thread.modelId = toNullableString(params.model) ?? thread.modelId;
          thread.effort = toNullableString(params.effort) ?? thread.effort;
          await this.persistThreads();
          return {
            turn: {
              id: storedTurn.id,
              threadId: thread.id,
            },
          };
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "turn_interrupt": {
        const threadId = String(params.threadId ?? "");
        const workspaceId = String(params.workspaceId ?? "");
        const thread = this.getThread(threadId) ?? this.findThreadBySdkThreadId(threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          return notFound("No active turn found.");
        }
        const turnId = toNullableString(params.turnId) ?? thread.activeTurnId;
        if (!turnId) {
          return notFound("No active turn found.");
        }
        try {
          const settings = await this.storage.readSettings();
          const client = this.buildAppServerClient(settings, workspaceId);
          await client.interruptTurn({
            threadId: this.resolveAppServerThreadId(thread),
            turnId,
          });
          return {
            turnId,
          };
        } catch (error) {
          return rpcBoundaryError(error);
        }
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
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.steerTurn({
            threadId: this.resolveAppServerThreadId(thread),
            expectedTurnId: turnId,
            input: buildAppServerUserInputItems(
              String(params.text ?? ""),
              Array.isArray(params.images)
                ? params.images.filter((entry): entry is string => typeof entry === "string")
                : [],
              params.appMentions,
            ),
          });
        } catch (error) {
          return rpcBoundaryError(error);
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
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          const response = await client.startReview({
            threadId: this.resolveAppServerThreadId(thread),
            target:
              params.target && typeof params.target === "object"
                ? (params.target as JsonRecord)
                : {},
            delivery: toNullableString(params.delivery),
          });
          const reviewThreadId =
            trimString(response.reviewThreadId) || trimString(response.review_thread_id);
          if (reviewThreadId) {
            await this.syncStoredThreadFromAppServer(workspaceId, reviewThreadId);
          }
          return response;
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "respond_to_server_request": {
        const workspaceId = String(params.workspaceId ?? "");
        if (!this.getWorkspace(workspaceId)) {
          return notFound("Workspace not found.");
        }
        const requestId = params.requestId ?? params.request_id;
        if (typeof requestId !== "string" && typeof requestId !== "number") {
          return badRequest("requestId is required.");
        }
        try {
          const settings = await this.storage.readSettings();
          const client = this.buildAppServerClient(settings, workspaceId);
          await client.sendResponse(requestId, params.result ?? null);
          return null;
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "remember_approval_rule": {
        const workspaceId = String(params.workspaceId ?? "");
        if (!this.getWorkspace(workspaceId)) {
          return notFound("Workspace not found.");
        }
        const command = Array.isArray(params.command)
          ? params.command
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean)
          : [];
        if (command.length === 0) {
          return badRequest("Command is required.");
        }
        const rulesPath = path.join(this.resolveCodexHomePath(), "rules", "default.rules");
        try {
          await appendPrefixRule(rulesPath, command);
          return {
            ok: true,
            rulesPath,
          };
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
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
      case "list_threads":
        return await this.listThreadsRpc(params);
      case "resume_thread":
        return await this.resumeThreadRpc(params);
      case "fork_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        const thread = this.getThread(threadId);
        if (!workspace || !thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread or workspace not found.");
        }
        try {
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          const response = await client.forkThread(this.resolveAppServerThreadId(thread));
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
          return rpcBoundaryError(error);
        }
      }
      case "rollback_thread_to_message": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const messageItemId = trimString(params.messageItemId);
        const workspace = this.getWorkspace(workspaceId);
        const thread = this.getThreadForWorkspace(workspaceId, threadId);
        if (!workspace || !thread) {
          return notFound("Thread or workspace not found.");
        }
        if (!messageItemId) {
          return badRequest("Message item id is required.");
        }
        const target = this.findRollbackTarget(thread, messageItemId);
        if (!target) {
          return notFound("Message not found.");
        }
        if (trimString(target.item.type) !== "userMessage") {
          return badRequest("Only user messages can be used as rollback targets.");
        }
        const numTurns = thread.turns.length - target.turnIndex;
        if (numTurns < 1) {
          return badRequest("Rollback target is invalid.");
        }
        const restoredText = extractUserMessageTextFromStoredItem(target.item);
        try {
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          const response = await client.rollbackThread(
            this.resolveAppServerThreadId(thread),
            numTurns,
          );
          const rawThread =
            response.thread && typeof response.thread === "object"
              ? (response.thread as Record<string, unknown>)
              : null;
          if (!rawThread) {
            return notFound("Rolled back thread was not returned by app-server.");
          }
          const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread, thread);
          this.threadsById.set(stored.id, stored);
          this.updateThreadWorkspaceMapping(stored);
          await this.persistThreads();
          return {
            restoredText,
            thread: toThreadResponse(stored),
          };
        } catch (error) {
          return rpcBoundaryError(error);
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
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.compactThread(this.resolveAppServerThreadId(thread));
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "archive_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const thread = this.getThread(threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread not found.");
        }
        try {
          const settings = await this.storage.readSettings();
          const client = this.buildAppServerClient(settings, workspaceId);
          await client.archiveThread(this.resolveAppServerThreadId(thread));
          thread.archivedAt = Date.now();
          thread.updatedAt = Date.now();
          await this.persistThreads();
          return null;
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "set_thread_name": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const name = String(params.name ?? "");
        const thread = this.getThread(threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          return notFound("Thread not found.");
        }
        try {
          const settings = await this.storage.readSettings();
          const client = this.buildAppServerClient(settings, workspaceId);
          await client.setThreadName(this.resolveAppServerThreadId(thread), name);
          thread.name = name || null;
          thread.updatedAt = Date.now();
          await this.persistThreads();
          return null;
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "get_thread_backlog":
      case "add_thread_backlog_item":
      case "update_thread_backlog_item":
      case "delete_thread_backlog_item":
        return await this.handleThreadBacklogRpc(method, params);
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
      case "model_list": {
        try {
          const workspaceId = toNullableString(params.workspaceId);
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.modelList();
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "skills_list": {
        try {
          const workspaceId = String(params.workspaceId ?? "");
          const workspace = workspaceId ? this.getWorkspace(workspaceId) : null;
          const skillsPath = workspace ? path.join(workspace.path, ".agents", "skills") : null;
          const skillsPaths = (skillsPath && (await pathExists(skillsPath))) ? [skillsPath] : [];
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          const response = await client.skillsList({
            ...(workspace ? { cwd: workspace.path } : {}),
            ...(skillsPaths.length > 0 ? { skillsPaths } : {}),
          });
          return {
            ...response,
            sourcePaths: skillsPaths,
            sourceErrors: [],
          };
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "apps_list": {
        try {
          const workspaceId = toNullableString(params.workspaceId);
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.appsList({
            cursor: toNullableString(params.cursor),
            limit:
              typeof params.limit === "number" && Number.isFinite(params.limit)
                ? params.limit
                : null,
            threadId: toNullableString(params.threadId),
          });
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "list_mcp_server_status": {
        try {
          const workspaceId = toNullableString(params.workspaceId);
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.listMcpServerStatus({
            cursor: toNullableString(params.cursor),
            limit:
              typeof params.limit === "number" && Number.isFinite(params.limit)
                ? params.limit
                : null,
          });
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "get_agents_settings":
      case "set_agents_core_settings":
      case "create_agent":
      case "update_agent":
      case "delete_agent":
      case "read_agent_config_toml":
      case "write_agent_config_toml":
        return await this.handleAgentsRpc(method, params);
      case "collaboration_mode_list": {
        try {
          const workspaceId = toNullableString(params.workspaceId);
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.collaborationModeList();
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "experimental_feature_list": {
        try {
          const workspaceId = toNullableString(params.workspaceId);
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.experimentalFeatureList({
            cursor: toNullableString(params.cursor),
            limit:
              typeof params.limit === "number" && Number.isFinite(params.limit)
                ? params.limit
                : null,
          });
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "set_codex_feature_flag":
        return null;
      case "account_rate_limits": {
        try {
          const workspaceId = toNullableString(params.workspaceId);
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.accountRateLimitsRead();
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "account_read":
        return await this.readAccountInfo(String(params.workspaceId ?? ""));
      case "codex_login": {
        const workspaceId = String(params.workspaceId ?? "");
        if (!this.getWorkspace(workspaceId)) {
          return notFound("Workspace not found.");
        }
        try {
          return await this.startCodexLogin(workspaceId);
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "codex_login_cancel": {
        const workspaceId = String(params.workspaceId ?? "");
        if (!this.getWorkspace(workspaceId)) {
          return notFound("Workspace not found.");
        }
        try {
          return await this.cancelCodexLogin(workspaceId);
        } catch (error) {
          return rpcBoundaryError(error);
        }
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
          return rpcBoundaryError(error);
        }
      }
      case "local_usage_snapshot":
      case "codex_doctor":
      case "codex_update":
      case "app_build_type":
      case "is_mobile_runtime":
      case "is_macos_debug_build":
      case "send_notification_fallback":
      case "menu_set_accelerators":
      case "set_tray_recent_threads":
      case "set_tray_session_usage":
      case "tailscale_status":
      case "tailscale_daemon_command_preview":
      case "tailscale_daemon_start":
      case "tailscale_daemon_stop":
      case "tailscale_daemon_status":
      case "dictation_model_status":
      case "dictation_download_model":
      case "dictation_cancel_download":
      case "dictation_remove_model":
      case "dictation_start":
      case "dictation_request_permission":
      case "dictation_stop":
      case "dictation_cancel":
      case "write_text_file":
      case "terminal_open":
      case "terminal_write":
      case "terminal_resize":
      case "terminal_close":
        return await this.handleCompanionRuntimeRpc(method, params);
      case "generate_commit_message":
      {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          return await this.generateCommitMessageForWorkspace(
            workspace,
            toNullableString(params.commitMessageModelId),
          );
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      case "generate_agent_description": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          return await this.generateAgentDescriptionForWorkspace(
            workspace,
            String(params.description ?? ""),
          );
        } catch (error) {
          return rpcBoundaryError(error);
        }
      }
      default:
        return notFound(`Unsupported method: ${method}`);
    }
  }

}
