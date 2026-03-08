import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createTwoFilesPatch } from "diff";
import {
  createAgent as createManagedAgent,
  deleteAgent as deleteManagedAgent,
  getAgentsSettings,
  readAgentConfigToml,
  setAgentsCoreSettings,
  updateAgent as updateManagedAgent,
  writeAgentConfigToml,
} from "./agentsConfig.js";
import { buildAppServerEvent } from "./appServer.js";
import {
  isHttpUrl,
  unsupportedRpcMessage,
} from "./parity.js";
import { CompanionStorage } from "./storage.js";
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
} from "./types.js";

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

type BroadcastFn = (message: BroadcastMessage) => void;

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

type DailyUsageTotals = {
  input: number;
  cached: number;
  output: number;
  agentMs: number;
  agentRuns: number;
};

type UsageTotals = {
  input: number;
  cached: number;
  output: number;
};

const APP_SERVER_INIT_TIMEOUT_MS = 15_000;
const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const MAX_ACTIVITY_GAP_MS = 2 * 60 * 1000;
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

const RUN_METADATA_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    worktreeName: { type: "string" },
  },
  required: ["title", "worktreeName"],
  additionalProperties: false,
} as const;
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

function buildAgentDescriptionPrompt(description: string) {
  return (
    "You generate custom coding-agent configuration text.\n" +
    "Return ONLY a JSON object with exactly these keys:\n" +
    "- description: short role summary, one sentence, 4-12 words.\n" +
    "- developerInstructions: multiline instructions for the agent.\n\n" +
    "Requirements:\n" +
    "- Preserve the user's intent, even when the input is short.\n" +
    "- Keep description concise and practical.\n" +
    "- developerInstructions should be actionable and specific.\n" +
    "- developerInstructions must be 3-8 lines.\n" +
    "- Do not include markdown fences.\n\n" +
    "Example:\n" +
    '{"description":"Investigates flaky tests and stabilizes suites","developerInstructions":"Investigate flaky test failures and identify root causes.\\nReproduce failures deterministically before proposing changes.\\nPrefer minimal, safe fixes and add targeted regression coverage."}\n\n' +
    "User prompt:\n" +
    description
  );
}

function parseAgentDescriptionValue(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("No agent configuration was generated");
  }
  const cleaned = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"))
    .join("\n");
  if (!cleaned.trim()) {
    throw new Error("No agent configuration was generated");
  }
  const parsed = extractJsonValue(cleaned);
  if (parsed) {
    const description = trimString(parsed.description);
    const developerInstructions =
      trimString(parsed.developerInstructions) || trimString(parsed.developer_instructions);
    if (description || developerInstructions) {
      return {
        description,
        developerInstructions,
      };
    }
  }

  const cleanedLines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let description: string | null = null;
  let developerInstructions: string | null = null;
  for (let index = 0; index < cleanedLines.length; index += 1) {
    const line = cleanedLines[index]!;
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "description" && !description && value) {
      description = value;
      continue;
    }
    if (
      (key === "developer instructions" || key === "developer_instructions" || key === "instructions") &&
      !developerInstructions
    ) {
      const trailing = cleanedLines.slice(index + 1).join("\n").trim();
      const combined = value && trailing ? `${value}\n${trailing}` : value || trailing;
      if (combined.trim()) {
        developerInstructions = combined;
      }
    }
  }
  if (description || developerInstructions) {
    return {
      description: description ?? "",
      developerInstructions: developerInstructions ?? "",
    };
  }

  const newlineIndex = cleaned.indexOf("\n");
  if (newlineIndex >= 0) {
    const first = cleaned.slice(0, newlineIndex).trim();
    const rest = cleaned.slice(newlineIndex + 1).trim();
    if (first || rest) {
      return {
        description: first,
        developerInstructions: rest,
      };
    }
  }

  return {
    description: cleaned,
    developerInstructions: "",
  };
}

function findLastAgentMessageText(rawThread: JsonRecord, expectedTurnId: string | null) {
  const rawTurns = Array.isArray(rawThread.turns) ? (rawThread.turns as JsonRecord[]) : [];
  const targetTurn =
    (expectedTurnId
      ? rawTurns.find((turn) => trimString(turn.id) === expectedTurnId) ?? null
      : null) ??
    rawTurns[rawTurns.length - 1] ??
    null;
  if (!targetTurn) {
    throw new Error("Detached Codex turn completed without a turn payload.");
  }
  const items = Array.isArray(targetTurn.items) ? (targetTurn.items as JsonRecord[]) : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (trimString(item.type) !== "agentMessage") {
      continue;
    }
    const text = trimString(item.text);
    if (text) {
      return text;
    }
  }
  throw new Error("Detached Codex turn completed without an agent message.");
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

function extractThreadIdFromParams(params: JsonRecord) {
  const direct = trimString(params.threadId) || trimString(params.thread_id);
  if (direct) {
    return direct;
  }
  const turn =
    params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
      ? (params.turn as JsonRecord)
      : null;
  const fromTurn =
    trimString(turn?.threadId) ||
    trimString(turn?.thread_id) ||
    (turn?.thread && typeof turn.thread === "object" && !Array.isArray(turn.thread)
      ? trimString((turn.thread as JsonRecord).id)
      : "");
  if (fromTurn) {
    return fromTurn;
  }
  const item =
    params.item && typeof params.item === "object" && !Array.isArray(params.item)
      ? (params.item as JsonRecord)
      : null;
  const fromItem =
    trimString(item?.threadId) ||
    trimString(item?.thread_id) ||
    (item?.thread && typeof item.thread === "object" && !Array.isArray(item.thread)
      ? trimString((item.thread as JsonRecord).id)
      : "");
  if (fromItem) {
    return fromItem;
  }
  const thread =
    params.thread && typeof params.thread === "object" && !Array.isArray(params.thread)
      ? (params.thread as JsonRecord)
      : null;
  return trimString(thread?.id);
}

function extractTurnIdFromParams(params: JsonRecord) {
  const direct = trimString(params.turnId) || trimString(params.turn_id);
  if (direct) {
    return direct;
  }
  const turn =
    params.turn && typeof params.turn === "object" && !Array.isArray(params.turn)
      ? (params.turn as JsonRecord)
      : null;
  const fromTurn = trimString(turn?.id);
  if (fromTurn) {
    return fromTurn;
  }
  const item =
    params.item && typeof params.item === "object" && !Array.isArray(params.item)
      ? (params.item as JsonRecord)
      : null;
  return trimString(item?.turnId) || trimString(item?.turn_id);
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

function readThreadActivityTimestampMs(rawThread: Record<string, unknown>, rawTurn: Record<string, unknown>) {
  const turnTimestamp =
    readLifecycleTimestampMs(rawTurn.updatedAt) ??
    readLifecycleTimestampMs(rawTurn.updated_at) ??
    readLifecycleTimestampMs(rawTurn.completedAt) ??
    readLifecycleTimestampMs(rawTurn.completed_at) ??
    readLifecycleTimestampMs(rawTurn.startedAt) ??
    readLifecycleTimestampMs(rawTurn.started_at) ??
    readLifecycleTimestampMs(rawTurn.createdAt) ??
    readLifecycleTimestampMs(rawTurn.created_at);
  if (turnTimestamp !== null) {
    return turnTimestamp;
  }
  return (
    readLifecycleTimestampMs(rawThread.updatedAt) ??
    readLifecycleTimestampMs(rawThread.updated_at) ??
    readLifecycleTimestampMs(rawThread.createdAt) ??
    readLifecycleTimestampMs(rawThread.created_at)
  );
}

function normalizeStaleInProgressThread(rawThread: Record<string, unknown>) {
  const turns = Array.isArray(rawThread.turns)
    ? (rawThread.turns as Array<Record<string, unknown>>)
    : [];
  const lastTurn = turns.at(-1);
  if (!lastTurn || typeof lastTurn !== "object") {
    return rawThread;
  }
  if (normalizeLifecycleStatus(lastTurn.status) !== "inprogress") {
    return rawThread;
  }
  const statusType = normalizeThreadStatusType(rawThread.status);
  const directActiveTurnId =
    trimString(rawThread.activeTurnId) || trimString(rawThread.active_turn_id);
  const items = Array.isArray(lastTurn.items) ? lastTurn.items : [];
  if (items.length === 0) {
    return rawThread;
  }
  if (items.some((item) => !isTerminalAppServerItem(item))) {
    return rawThread;
  }
  const allItemsHaveExplicitStatus = items.every((item) => hasExplicitAppServerItemStatus(item));
  const hasExplicitTerminalItem = items.some(
    (item) => hasExplicitAppServerItemStatus(item) && isTerminalAppServerItem(item),
  );
  if (!hasExplicitTerminalItem || !allItemsHaveExplicitStatus) {
    return rawThread;
  }
  const activityTimestamp = readThreadActivityTimestampMs(rawThread, lastTurn);
  const isInactiveThreadStatus =
    statusType === "idle" || statusType === "notloaded" || statusType === "systemerror";
  const isStaleByAge =
    activityTimestamp !== null && Date.now() - activityTimestamp > MAX_ACTIVITY_GAP_MS;
  if (!isInactiveThreadStatus && directActiveTurnId) {
    return rawThread;
  }
  if (!isInactiveThreadStatus && !isStaleByAge) {
    return rawThread;
  }

  lastTurn.status = "completed";
  if (!("error" in lastTurn)) {
    lastTurn.error = null;
  }

  const status =
    rawThread.status && typeof rawThread.status === "object" && !Array.isArray(rawThread.status)
      ? (rawThread.status as JsonRecord)
      : null;
  if (status && normalizeLifecycleStatus(status.type) === "active") {
    rawThread.status = { type: "idle" };
  } else if (normalizeLifecycleStatus(rawThread.status) === "active") {
    rawThread.status = "idle";
  }

  rawThread.activeTurnId = null;
  rawThread.active_turn_id = null;
  return rawThread;
}

function normalizeThreadStatusType(status: unknown) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return trimString(status).toLowerCase().replace(/[\s_-]/g, "");
  }
  const record = status as JsonRecord;
  return trimString(record.type ?? record.statusType ?? record.status_type)
    .toLowerCase()
    .replace(/[\s_-]/g, "");
}

function extractActiveTurnIdFromThread(rawThread: Record<string, unknown>) {
  normalizeStaleInProgressThread(rawThread);
  const direct =
    trimString(rawThread.activeTurnId) ||
    trimString(rawThread.active_turn_id);
  if (direct) {
    return direct;
  }
  const activeTurn =
    rawThread.activeTurn && typeof rawThread.activeTurn === "object" && !Array.isArray(rawThread.activeTurn)
      ? (rawThread.activeTurn as JsonRecord)
      : rawThread.active_turn &&
          typeof rawThread.active_turn === "object" &&
          !Array.isArray(rawThread.active_turn)
        ? (rawThread.active_turn as JsonRecord)
        : null;
  const objectId =
    trimString(activeTurn?.id) ||
    trimString(activeTurn?.turnId) ||
    trimString(activeTurn?.turn_id);
  if (objectId) {
    return objectId;
  }
  const statusType = normalizeThreadStatusType(rawThread.status);
  if (statusType === "active") {
    const turns = Array.isArray(rawThread.turns) ? (rawThread.turns as Record<string, unknown>[]) : [];
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turnId = trimString(turns[index]?.id);
      if (turnId) {
        return turnId;
      }
    }
  }
  return null;
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

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toNullableString(value: unknown) {
  const trimmed = trimString(value);
  return trimmed.length > 0 ? trimmed : null;
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

function formatLocalDayKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function makeDayKeys(days: number) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    keys.push(formatLocalDayKey(date));
  }
  return keys;
}

function dayDirForKey(root: string, dayKey: string) {
  const [year = "1970", month = "01", day = "01"] = dayKey.split("-");
  return path.join(root, year, month, day);
}

function dayKeyForTimestampMs(timestampMs: number) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return null;
  }
  return formatLocalDayKey(new Date(timestampMs));
}

function readTimestampMs(value: JsonRecord) {
  const raw = value.timestamp;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw < 1_000_000_000_000 ? raw * 1000 : raw;
}

function pathMatchesWorkspace(cwd: string, workspacePath: string) {
  const normalizedCwd = normalizeRootPath(cwd);
  const normalizedWorkspace = normalizeRootPath(workspacePath);
  return normalizedCwd === normalizedWorkspace || normalizedCwd.startsWith(`${normalizedWorkspace}/`);
}

function extractCwd(value: JsonRecord) {
  const payload =
    value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
      ? (value.payload as JsonRecord)
      : null;
  return payload ? toNullableString(payload.cwd) : null;
}

function extractModelFromTurnContext(value: JsonRecord) {
  const payload =
    value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
      ? (value.payload as JsonRecord)
      : null;
  if (!payload) {
    return null;
  }
  return (
    toNullableString(payload.model) ||
    (payload.info && typeof payload.info === "object" && !Array.isArray(payload.info)
      ? toNullableString((payload.info as JsonRecord).model)
      : null)
  );
}

function extractModelFromTokenCount(value: JsonRecord) {
  const payload =
    value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
      ? (value.payload as JsonRecord)
      : null;
  const info =
    payload?.info && typeof payload.info === "object" && !Array.isArray(payload.info)
      ? (payload.info as JsonRecord)
      : null;
  return (
    toNullableString(info?.model) ||
    toNullableString(info?.model_name) ||
    toNullableString(payload?.model) ||
    toNullableString(value.model)
  );
}

function readUsageValue(map: JsonRecord | null, keys: string[]) {
  for (const key of keys) {
    const value = map?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
  }
  return 0;
}

function extractTokenUsageInfo(value: JsonRecord) {
  const payload =
    value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
      ? (value.payload as JsonRecord)
      : null;
  const info =
    payload?.info && typeof payload.info === "object" && !Array.isArray(payload.info)
      ? (payload.info as JsonRecord)
      : null;
  if (!info) {
    return null;
  }
  const totalUsage =
    info.total_token_usage &&
    typeof info.total_token_usage === "object" &&
    !Array.isArray(info.total_token_usage)
      ? (info.total_token_usage as JsonRecord)
      : info.totalTokenUsage &&
          typeof info.totalTokenUsage === "object" &&
          !Array.isArray(info.totalTokenUsage)
        ? (info.totalTokenUsage as JsonRecord)
        : null;
  if (totalUsage) {
    return {
      input: readUsageValue(totalUsage, ["input_tokens", "inputTokens"]),
      cached: readUsageValue(totalUsage, [
        "cached_input_tokens",
        "cache_read_input_tokens",
        "cachedInputTokens",
        "cacheReadInputTokens",
      ]),
      output: readUsageValue(totalUsage, ["output_tokens", "outputTokens"]),
      usedTotal: true,
    };
  }
  const lastUsage =
    info.last_token_usage &&
    typeof info.last_token_usage === "object" &&
    !Array.isArray(info.last_token_usage)
      ? (info.last_token_usage as JsonRecord)
      : info.lastTokenUsage &&
          typeof info.lastTokenUsage === "object" &&
          !Array.isArray(info.lastTokenUsage)
        ? (info.lastTokenUsage as JsonRecord)
        : null;
  if (!lastUsage) {
    return null;
  }
  return {
    input: readUsageValue(lastUsage, ["input_tokens", "inputTokens"]),
    cached: readUsageValue(lastUsage, [
      "cached_input_tokens",
      "cache_read_input_tokens",
      "cachedInputTokens",
      "cacheReadInputTokens",
    ]),
    output: readUsageValue(lastUsage, ["output_tokens", "outputTokens"]),
    usedTotal: false,
  };
}

function trackActivity(
  daily: Map<string, DailyUsageTotals>,
  lastActivityMs: number | null,
  timestampMs: number,
) {
  if (lastActivityMs !== null) {
    const delta = timestampMs - lastActivityMs;
    if (delta > 0 && delta <= MAX_ACTIVITY_GAP_MS) {
      const dayKey = dayKeyForTimestampMs(timestampMs);
      if (dayKey) {
        daily.get(dayKey)!.agentMs += delta;
      }
    }
  }
  return timestampMs;
}

async function scanLocalUsageFile(
  filePath: string,
  daily: Map<string, DailyUsageTotals>,
  modelTotals: Map<string, number>,
  workspacePath: string | null,
) {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let previousTotals: UsageTotals | null = null;
  let currentModel: string | null = null;
  let lastActivityMs: number | null = null;
  const seenRuns = new Set<number>();
  let matchKnown = workspacePath === null;
  let matchesWorkspace = workspacePath === null;

  try {
    for await (const line of lines) {
      if (line.length > 512_000) {
        continue;
      }
      let value: JsonRecord;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        value = parsed as JsonRecord;
      } catch {
        continue;
      }

      const entryType = trimString(value.type);
      if (entryType === "session_meta" || entryType === "turn_context") {
        const cwd = extractCwd(value);
        if (cwd && workspacePath) {
          matchesWorkspace = pathMatchesWorkspace(cwd, workspacePath);
          matchKnown = true;
          if (!matchesWorkspace) {
            break;
          }
        }
      }

      if (entryType === "turn_context") {
        currentModel = extractModelFromTurnContext(value) ?? currentModel;
        continue;
      }
      if (entryType === "session_meta") {
        continue;
      }
      if (!matchesWorkspace) {
        if (matchKnown) {
          break;
        }
        continue;
      }
      if (!matchKnown) {
        continue;
      }

      if (entryType === "event_msg" || entryType === "") {
        const payload =
          value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
            ? (value.payload as JsonRecord)
            : null;
        const payloadType = trimString(payload?.type);

        if (payloadType === "agent_message") {
          const timestampMs = readTimestampMs(value);
          if (timestampMs !== null) {
            if (!seenRuns.has(timestampMs)) {
              seenRuns.add(timestampMs);
              const dayKey = dayKeyForTimestampMs(timestampMs);
              if (dayKey) {
                daily.get(dayKey)!.agentRuns += 1;
              }
            }
            lastActivityMs = trackActivity(daily, lastActivityMs, timestampMs);
          }
          continue;
        }

        if (payloadType === "agent_reasoning") {
          const timestampMs = readTimestampMs(value);
          if (timestampMs !== null) {
            lastActivityMs = trackActivity(daily, lastActivityMs, timestampMs);
          }
          continue;
        }

        if (payloadType !== "token_count") {
          continue;
        }

        const tokenUsage = extractTokenUsageInfo(value);
        if (!tokenUsage) {
          continue;
        }
        let delta: UsageTotals = {
          input: tokenUsage.input,
          cached: tokenUsage.cached,
          output: tokenUsage.output,
        };
        if (tokenUsage.usedTotal) {
          const previous: UsageTotals = previousTotals ?? { input: 0, cached: 0, output: 0 };
          delta = {
            input: Math.max(0, tokenUsage.input - previous.input),
            cached: Math.max(0, tokenUsage.cached - previous.cached),
            output: Math.max(0, tokenUsage.output - previous.output),
          };
          previousTotals = {
            input: tokenUsage.input,
            cached: tokenUsage.cached,
            output: tokenUsage.output,
          };
        } else {
          const previous: UsageTotals = previousTotals ?? { input: 0, cached: 0, output: 0 };
          previousTotals = {
            input: previous.input + delta.input,
            cached: previous.cached + delta.cached,
            output: previous.output + delta.output,
          };
        }
        if (delta.input === 0 && delta.cached === 0 && delta.output === 0) {
          continue;
        }
        const timestampMs = readTimestampMs(value);
        if (timestampMs !== null) {
          const dayKey = dayKeyForTimestampMs(timestampMs);
          if (dayKey) {
            const totals = daily.get(dayKey)!;
            const cached = Math.min(delta.cached, delta.input);
            totals.input += delta.input;
            totals.cached += cached;
            totals.output += delta.output;
            const model = currentModel ?? extractModelFromTokenCount(value) ?? "unknown";
            modelTotals.set(model, (modelTotals.get(model) ?? 0) + delta.input + delta.output);
          }
          lastActivityMs = trackActivity(daily, lastActivityMs, timestampMs);
        }
        continue;
      }

      if (entryType === "response_item") {
        const payload =
          value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
            ? (value.payload as JsonRecord)
            : null;
        const role = trimString(payload?.role);
        const payloadType = trimString(payload?.type);
        const timestampMs = readTimestampMs(value);
        if (timestampMs === null) {
          continue;
        }
        if (role === "assistant") {
          if (!seenRuns.has(timestampMs)) {
            seenRuns.add(timestampMs);
            const dayKey = dayKeyForTimestampMs(timestampMs);
            if (dayKey) {
              daily.get(dayKey)!.agentRuns += 1;
            }
          }
          lastActivityMs = trackActivity(daily, lastActivityMs, timestampMs);
        } else if (payloadType !== "message") {
          lastActivityMs = trackActivity(daily, lastActivityMs, timestampMs);
        }
      }
    }
  } finally {
    lines.close();
  }
}

async function buildLocalUsageSnapshot(
  sessionsRoots: string[],
  days: number,
  workspacePath: string | null,
) {
  const dayKeys = makeDayKeys(days);
  const daily = new Map<string, DailyUsageTotals>(
    dayKeys.map((dayKey) => [
      dayKey,
      { input: 0, cached: 0, output: 0, agentMs: 0, agentRuns: 0 },
    ]),
  );
  const modelTotals = new Map<string, number>();

  for (const root of sessionsRoots) {
    for (const dayKey of dayKeys) {
      const dayRoot = dayDirForKey(root, dayKey);
      const entries = await fs.readdir(dayRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name) !== ".jsonl") {
          continue;
        }
        await scanLocalUsageFile(path.join(dayRoot, entry.name), daily, modelTotals, workspacePath);
      }
    }
  }

  const daysList = dayKeys.map((dayKey) => {
    const totals = daily.get(dayKey)!;
    return {
      day: dayKey,
      inputTokens: totals.input,
      cachedInputTokens: totals.cached,
      outputTokens: totals.output,
      totalTokens: totals.input + totals.output,
      agentTimeMs: totals.agentMs,
      agentRuns: totals.agentRuns,
    };
  });
  const totalTokens = daysList.reduce((sum, day) => sum + day.totalTokens, 0);
  const last7 = daysList.slice(-7);
  const last7DaysTokens = last7.reduce((sum, day) => sum + day.totalTokens, 0);
  const last7InputTokens = last7.reduce((sum, day) => sum + day.inputTokens, 0);
  const last7CachedInputTokens = last7.reduce((sum, day) => sum + day.cachedInputTokens, 0);
  const peakDay = daysList.reduce<typeof daysList[number] | null>((best, day) => {
    if (!best || day.totalTokens > best.totalTokens) {
      return day;
    }
    return best;
  }, null);

  return {
    updatedAt: Date.now(),
    days: daysList,
    totals: {
      last7DaysTokens,
      last30DaysTokens: totalTokens,
      averageDailyTokens: last7.length > 0 ? Math.round(last7DaysTokens / last7.length) : 0,
      cacheHitRatePercent:
        last7InputTokens > 0
          ? Math.round((last7CachedInputTokens / last7InputTokens) * 1000) / 10
          : 0,
      peakDay: peakDay && peakDay.totalTokens > 0 ? peakDay.day : null,
      peakDayTokens: peakDay && peakDay.totalTokens > 0 ? peakDay.totalTokens : 0,
    },
    topModels: Array.from(modelTotals.entries())
      .filter(([model, tokens]) => model !== "unknown" && tokens > 0)
      .map(([model, tokens]) => ({
        model,
        tokens,
        sharePercent: totalTokens > 0 ? Math.round((tokens / totalTokens) * 1000) / 10 : 0,
      }))
      .sort((left, right) => right.tokens - left.tokens)
      .slice(0, 4),
  };
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

function buildAccountResponse(response: JsonRecord | null, fallback: AccountFallback | null) {
  const responseAccount =
    response && typeof response.account === "object" && response.account
      ? { ...(response.account as JsonRecord) }
      : response;
  const account =
    responseAccount && typeof responseAccount === "object" && !Array.isArray(responseAccount)
      ? { ...responseAccount }
      : {};
  const accountType = trimString(account.type).toLowerCase();
  const allowFallback =
    Object.keys(account).length === 0 ||
    !accountType ||
    accountType === "chatgpt" ||
    accountType === "unknown";
  if (allowFallback && fallback) {
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
  return {
    account: Object.keys(account).length > 0 ? account : null,
    ...(typeof response?.requiresOpenaiAuth === "boolean"
      ? { requiresOpenaiAuth: response.requiresOpenaiAuth }
      : {}),
  };
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

async function runCommandCapture(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
) {
  return await new Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    error: string | null;
  }>((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        env: options.env,
        timeout: options.timeoutMs ?? 5_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            ok: true,
            stdout,
            stderr,
            error: null,
          });
          return;
        }
        resolve({
          ok: false,
          stdout,
          stderr,
          error: `${stderr || stdout || error.message}`.trim() || error.message,
        });
      },
    );
  });
}

async function runGit(repoRoot: string, args: string[]) {
  return await runCommand("git", args, repoRoot);
}

async function runGh(repoRoot: string, args: string[]) {
  return await runCommand("gh", args, repoRoot);
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

function parseGitHubRepo(remoteUrl: string) {
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

function validateGitHubRepoName(value: string) {
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

function normalizeRepoFullName(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
}

function validateNormalizedRepoName(value: string) {
  const normalized = normalizeRepoFullName(value);
  if (!normalized) {
    throw new Error("Repository name is empty after normalization. Use 'repo' or 'owner/repo'.");
  }
  return normalized;
}

function gitHubRepoNamesMatch(existing: string, requested: string) {
  return normalizeRepoFullName(existing).toLowerCase() === normalizeRepoFullName(requested).toLowerCase();
}

function githubRepoExistsMessage(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("already exists") ||
    lower.includes("name already exists") ||
    lower.includes("has already been taken") ||
    lower.includes("repository with this name already exists")
  );
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

function parseGitHubPullRequestDiff(diff: string) {
  const results: Array<{ path: string; status: string; diff: string }> = [];
  let currentLines: string[] = [];
  let currentOldPath: string | null = null;
  let currentNewPath: string | null = null;
  let currentStatus: string | null = null;

  const finalize = () => {
    if (currentLines.length === 0) {
      return;
    }
    const diffText = currentLines.join("\n");
    if (!diffText.trim()) {
      return;
    }
    const status = currentStatus ?? "M";
    const filePath = status === "D"
      ? currentOldPath
      : currentNewPath ?? currentOldPath;
    if (!filePath) {
      return;
    }
    results.push({
      path: normalizeGitPathForUi(filePath),
      status,
      diff: diffText,
    });
  };

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      finalize();
      currentLines = [line];
      currentOldPath = null;
      currentNewPath = null;
      currentStatus = null;
      const parts = line.slice("diff --git ".length).trim().split(/\s+/);
      const oldPart = parts[0]?.replace(/^a\//, "") ?? "";
      const newPart = parts[1]?.replace(/^b\//, "") ?? "";
      currentOldPath = oldPart || null;
      currentNewPath = newPart || null;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      currentStatus = "A";
    } else if (line.startsWith("deleted file mode ")) {
      currentStatus = "D";
    } else if (line.startsWith("rename from ")) {
      currentStatus = "R";
      currentOldPath = line.slice("rename from ".length).trim() || currentOldPath;
    } else if (line.startsWith("rename to ")) {
      currentStatus = "R";
      currentNewPath = line.slice("rename to ".length).trim() || currentNewPath;
    }
    currentLines.push(line);
  }

  finalize();
  return results;
}

async function getGitHubIssues(workspacePath: string) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const repoName = await githubRepoFromPath(repoRoot);
  const issues = JSON.parse(
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
  ) as Array<{
    number: number;
    title: string;
    url: string;
    updatedAt: string;
  }>;
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

async function getGitHubPullRequests(workspacePath: string) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const repoName = await githubRepoFromPath(repoRoot);
  const pullRequests = JSON.parse(
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
  ) as Array<{
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
  }>;
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

async function getGitHubPullRequestDiff(workspacePath: string, prNumber: number) {
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

async function getGitHubPullRequestComments(workspacePath: string, prNumber: number) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  const repoName = await githubRepoFromPath(repoRoot);
  const commentsEndpoint = `/repos/${repoName}/issues/${prNumber}/comments?per_page=30`;
  const jqFilter = "[.[] | {id, body, createdAt: .created_at, url: .html_url, author: (if .user then {login: .user.login} else null end)}]";
  return JSON.parse((await runGh(repoRoot, ["api", commentsEndpoint, "--jq", jqFilter])).stdout) as Array<{
    author: { login: string } | null;
    body: string;
    createdAt: string;
    id: number;
    url: string;
  }>;
}

async function checkoutGitHubPullRequest(workspacePath: string, prNumber: number) {
  const repoRoot = await resolveGitRootFromPath(workspacePath);
  await runGh(repoRoot, ["pr", "checkout", String(prNumber)]);
}

async function createGitHubRepo(
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

  constructor(
    private readonly storage: CompanionStorage,
    private readonly broadcast: BroadcastFn,
    private readonly requestShutdown?: () => void,
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
      this.appServerThreadWorkspaceIds.set(this.resolveAppServerThreadId(thread), thread.workspaceId);
    });
  }

  async getHealth() {
    return {
      mode: "typescript",
      dataDir: this.dataDir,
      workspaceCount: this.workspacesById.size,
      threadCount: this.threadsById.size,
      connectedWorkspaceCount: this.connectedWorkspaceIds.size,
      appServerClientCount: this.appServerClients.size,
    };
  }

  async close() {
    await Promise.all(Array.from(this.appServerClients.values(), (client) => client.close()));
    this.appServerClients.clear();
    this.appServerClientWorkspaceIds.clear();
    this.appServerThreadWorkspaceIds.clear();
    this.appServerNotificationUnsubscribers.clear();
  }

  private get dataDir() {
    return path.dirname(this.storage.settingsPath);
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
    const client = this.buildAppServerClient(settings);
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
    const fallbackWorkspaceIds = this.workspaceIdsForClient(key);
    return fallbackWorkspaceIds.length > 0 ? [fallbackWorkspaceIds[0]!] : [];
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
        payload["https://api.openai.com/auth"] &&
        typeof payload["https://api.openai.com/auth"] === "object"
          ? (payload["https://api.openai.com/auth"] as JsonRecord)
          : null;
      const profile =
        payload["https://api.openai.com/profile"] &&
        typeof payload["https://api.openai.com/profile"] === "object"
          ? (payload["https://api.openai.com/profile"] as JsonRecord)
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

  private getLoginState(workspaceId: string) {
    const existing = this.loginStateByWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }
    const created: LoginState = { canceled: false, loginId: null, pending: null };
    this.loginStateByWorkspace.set(workspaceId, created);
    return created;
  }

  private async startCodexLogin(workspaceId: string) {
    const state = this.getLoginState(workspaceId);
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
    const state = this.getLoginState(workspaceId);
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
        throw new Error(options.timeoutMessage);
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
      case "open_workspace_in": {
        const targetPath = trimString(params.path);
        if (!targetPath) {
          return badRequest("path is required.");
        }
        if (isHttpUrl(targetPath)) {
          return null;
        }
        return badRequest("open_workspace_in only supports http(s) URLs in the web companion.");
      }
      case "get_open_app_icon":
        return null;
      case "set_workspace_runtime_codex_args":
      {
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
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest("empty command");
        }
        const rulesPath = path.join(this.resolveCodexHomePath(), "rules", "default.rules");
        try {
          await appendPrefixRule(rulesPath, command);
          return {
            ok: true,
            rulesPath,
          };
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
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
              const externalActiveTurnId = extractActiveTurnIdFromThread(thread);
              const externalUpdatedAt = Number(thread.updatedAt ?? thread.updated_at ?? 0);
              const externalCreatedAt = Number(thread.createdAt ?? thread.created_at ?? 0);
              const externalModel = trimString(thread.model);
              const externalEffort = trimString(
                thread.modelReasoningEffort ?? thread.model_reasoning_effort,
              );
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
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.compactThread(this.resolveAppServerThreadId(thread));
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
        try {
          const settings = await this.storage.readSettings();
          const client = this.buildAppServerClient(settings, workspaceId);
          await client.archiveThread(this.resolveAppServerThreadId(thread));
          thread.archivedAt = Date.now();
          thread.updatedAt = Date.now();
          await this.persistThreads();
          return null;
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
        }
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
      case "model_list": {
        try {
          const workspaceId = toNullableString(params.workspaceId);
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.modelList();
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "skills_list": {
        try {
          const workspaceId = String(params.workspaceId ?? "");
          const workspace = workspaceId ? this.getWorkspace(workspaceId) : null;
          const skillsPath = workspace ? path.join(workspace.path, ".agents", "skills") : null;
          const skillsPaths =
            skillsPath &&
            (await fs.stat(skillsPath).then(() => true).catch(() => false))
              ? [skillsPath]
              : [];
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
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
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
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "get_agents_settings":
        try {
          return await getAgentsSettings(this.storage.codexHome);
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      case "set_agents_core_settings": {
        const input =
          params.input && typeof params.input === "object"
            ? (params.input as JsonRecord)
            : {};
        try {
          return await setAgentsCoreSettings(this.storage.codexHome, {
            multiAgentEnabled: Boolean(input.multiAgentEnabled),
            maxThreads:
              typeof input.maxThreads === "number" ? input.maxThreads : 6,
            maxDepth: typeof input.maxDepth === "number" ? input.maxDepth : 1,
          });
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "create_agent": {
        const input =
          params.input && typeof params.input === "object"
            ? (params.input as JsonRecord)
            : {};
        try {
          return await createManagedAgent(this.storage.codexHome, {
            name: trimString(input.name),
            description: toNullableString(input.description),
            developerInstructions: toNullableString(input.developerInstructions),
            template: toNullableString(input.template),
            model: toNullableString(input.model),
            reasoningEffort: toNullableString(input.reasoningEffort),
          });
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "update_agent": {
        const input =
          params.input && typeof params.input === "object"
            ? (params.input as JsonRecord)
            : {};
        try {
          return await updateManagedAgent(this.storage.codexHome, {
            originalName: trimString(input.originalName),
            name: trimString(input.name),
            description: toNullableString(input.description),
            developerInstructions:
              input.developerInstructions === undefined
                ? undefined
                : toNullableString(input.developerInstructions),
            renameManagedFile:
              typeof input.renameManagedFile === "boolean"
                ? input.renameManagedFile
                : true,
          });
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "delete_agent": {
        const input =
          params.input && typeof params.input === "object"
            ? (params.input as JsonRecord)
            : {};
        try {
          return await deleteManagedAgent(this.storage.codexHome, {
            name: trimString(input.name),
            deleteManagedFile: Boolean(input.deleteManagedFile),
          });
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "read_agent_config_toml": {
        const agentName = trimString(params.agentName);
        if (!agentName) {
          return "";
        }
        try {
          return await readAgentConfigToml(this.storage.codexHome, agentName);
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "write_agent_config_toml": {
        const agentName = trimString(params.agentName);
        const content = String(params.content ?? "");
        try {
          await writeAgentConfigToml(this.storage.codexHome, agentName, content);
          return null;
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "collaboration_mode_list": {
        try {
          const workspaceId = toNullableString(params.workspaceId);
          const client = this.buildAppServerClient(await this.storage.readSettings(), workspaceId);
          return await client.collaborationModeList();
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
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
      case "create_github_repo": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          return await createGitHubRepo(
            workspace.path,
            String(params.repo ?? ""),
            String(params.visibility ?? ""),
            toNullableString(params.branch),
          );
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
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
      case "checkout_github_pull_request": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const prNumber =
          typeof params.prNumber === "number" && Number.isFinite(params.prNumber)
            ? params.prNumber
            : Number.parseInt(String(params.prNumber ?? ""), 10);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        if (!Number.isFinite(prNumber)) {
          return badRequest("prNumber is required.");
        }
        try {
          await checkoutGitHubPullRequest(workspace.path, prNumber);
          return null;
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "local_usage_snapshot":
        return await this.getLocalUsageSnapshot(
          typeof params.days === "number" ? params.days : null,
          toNullableString(params.workspacePath),
        );
      case "codex_doctor":
        return await this.runCodexDoctor(
          toNullableString(params.codexBin),
          toNullableString(params.codexArgs),
        );
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
      case "terminal_open":
      case "terminal_write":
      case "terminal_resize":
      case "terminal_close":
      case "write_text_file":
        return badRequest(unsupportedRpcMessage(method));
      case "get_github_issues": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          return await getGitHubIssues(workspace.path);
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "get_github_pull_requests": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        try {
          return await getGitHubPullRequests(workspace.path);
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "get_github_pull_request_diff": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const prNumber =
          typeof params.prNumber === "number" && Number.isFinite(params.prNumber)
            ? params.prNumber
            : Number.parseInt(String(params.prNumber ?? ""), 10);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        if (!Number.isFinite(prNumber)) {
          return badRequest("prNumber is required.");
        }
        try {
          return await getGitHubPullRequestDiff(workspace.path, prNumber);
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
      case "get_github_pull_request_comments": {
        const workspace = this.getWorkspace(String(params.workspaceId ?? ""));
        const prNumber =
          typeof params.prNumber === "number" && Number.isFinite(params.prNumber)
            ? params.prNumber
            : Number.parseInt(String(params.prNumber ?? ""), 10);
        if (!workspace) {
          return notFound("Workspace not found.");
        }
        if (!Number.isFinite(prNumber)) {
          return badRequest("prNumber is required.");
        }
        try {
          return await getGitHubPullRequestComments(workspace.path, prNumber);
        } catch (error) {
          return badRequest(error instanceof Error ? error.message : String(error));
        }
      }
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
          return badRequest(error instanceof Error ? error.message : String(error));
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
          return badRequest(error instanceof Error ? error.message : String(error));
        }
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
