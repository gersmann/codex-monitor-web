import { randomUUID } from "node:crypto";
import { buildAppServerUserInputItems, extractUserMessageTextFromStoredItem } from "./codexPrompts.js";
import { errorMessage, trimString, toNullableString } from "./codexCoreUtils.js";
import type { CompanionStorage } from "../storage.js";
import type {
  JsonRecord,
  RpcErrorShape,
  StoredThread,
  StoredThreadCodexParams,
  StoredThreadItem,
  StoredTurn,
  StoredWorkspace,
  ThreadBacklogItem,
} from "../types.js";
import type { CodexAppServerClient } from "../vendor/codexSdk.js";

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
export const NO_THREAD_SCOPE_SUFFIX = "__no_thread__";

function toThreadStatus(thread: StoredThread) {
  return {
    type: thread.activeTurnId ? "active" : "idle",
  } as const;
}

function toRpcTurnStatus(status: StoredTurn["status"]) {
  return status === "active" ? "inProgress" : status;
}

export function toThreadSummary(thread: StoredThread) {
  return {
    id: thread.id,
    cwd: thread.cwd,
    ...(thread.name && thread.name !== thread.preview ? { name: thread.name } : {}),
    preview: thread.preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: toThreadStatus(thread),
    model: thread.modelId,
    modelReasoningEffort: thread.effort,
    source: "appServer",
    activeTurnId: thread.activeTurnId,
    ...(thread.pinnedAt !== null ? { pinnedAt: thread.pinnedAt } : {}),
    ...(thread.detachedReviewParentId !== null
      ? { detachedReviewParentId: thread.detachedReviewParentId }
      : {}),
    ...(thread.codexParams !== null ? { codexParams: thread.codexParams } : {}),
  };
}

export function toThreadResponse(
  thread: StoredThread,
  options: { includeStatus?: boolean } = {},
) {
  return {
    id: thread.id,
    cwd: thread.cwd,
    ...(thread.name && thread.name !== thread.preview ? { name: thread.name } : {}),
    preview: thread.preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(options.includeStatus === false ? {} : { status: toThreadStatus(thread) }),
    activeTurnId: thread.activeTurnId,
    source: "appServer",
    model: thread.modelId,
    modelReasoningEffort: thread.effort,
    ...(thread.pinnedAt !== null ? { pinnedAt: thread.pinnedAt } : {}),
    ...(thread.detachedReviewParentId !== null
      ? { detachedReviewParentId: thread.detachedReviewParentId }
      : {}),
    ...(thread.codexParams !== null ? { codexParams: thread.codexParams } : {}),
    turns: thread.turns.map((turn) => ({
      id: turn.id,
      createdAt: turn.createdAt,
      completedAt: turn.completedAt,
      status: toRpcTurnStatus(turn.status),
      errorMessage: turn.errorMessage,
      items: turn.items,
    })),
    tokenUsage: thread.tokenUsage,
  };
}

export function defaultWorkspaceSettings() {
  return {
    sidebarCollapsed: false,
    sortOrder: null,
    groupId: null,
    cloneSourceWorkspaceId: null,
    gitRoot: null,
    launchScript: null,
    launchScripts: null,
    worktreeSetupScript: null,
    composerDefaults: null,
  };
}

function normalizeRootPath(value: string) {
  return value ? value.replace(/[\\/]+$/, "") : "";
}

function readLifecycleTimestampMs(value: unknown) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function readFirstLifecycleTimestampMs(
  raw: Record<string, unknown>,
  keys: readonly string[],
) {
  for (const key of keys) {
    const timestamp = readLifecycleTimestampMs(raw[key]);
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

function asJsonRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function readTurnItems(rawTurn: Record<string, unknown>) {
  return Array.isArray(rawTurn.items)
    ? (rawTurn.items as Array<Record<string, unknown>>)
    : [];
}

function normalizeLifecycleStatus(value: unknown) {
  const normalized = trimString(value).toLowerCase();
  return normalized ? normalized.replace(/[\s_-]/g, "") : null;
}

function isTerminalAppServerItem(item: unknown) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  const record = item as Record<string, unknown>;
  const normalizedStatus =
    normalizeLifecycleStatus(record.status) ??
    normalizeLifecycleStatus(record.itemStatus) ??
    normalizeLifecycleStatus(record.item_status);
  return normalizedStatus !== null;
}

function hasExplicitAppServerItemStatus(item: unknown) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  const record = item as JsonRecord;
  return (normalizeLifecycleStatus(record.status) ?? "").length > 0;
}

function hasExplicitTerminalItemStatuses(items: unknown[]) {
  return (
    items.length > 0 &&
    items.every((item) => isTerminalAppServerItem(item) && hasExplicitAppServerItemStatus(item))
  );
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
  if (statusType && isInactiveThreadStatus(statusType)) {
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

export function normalizeThreadStatusType(status: unknown) {
  const record = asJsonRecord(status);
  if (!record) {
    return trimString(status).toLowerCase().replace(/[\s_-]/g, "");
  }
  return trimString(record.type ?? record.statusType ?? record.status_type)
    .toLowerCase()
    .replace(/[\s_-]/g, "");
}

function extractEmbeddedThreadId(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? trimString((value as Record<string, unknown>).id)
    : "";
}

function extractThreadIdFromRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const record = value as Record<string, unknown>;
  return (
    trimString(record.threadId) ||
    trimString(record.thread_id) ||
    extractEmbeddedThreadId(record.thread) ||
    extractEmbeddedThreadId(record.threadSummary)
  );
}

export function extractThreadIdFromParams(params: JsonRecord) {
  return (
    extractThreadIdFromRecord(params) ||
    extractThreadIdFromRecord(params.data) ||
    extractThreadIdFromRecord(params.payload)
  );
}

function extractTurnIdFromTurnRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? trimString((value as Record<string, unknown>).id)
    : "";
}

function extractTurnIdFromItemRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const record = value as Record<string, unknown>;
  return trimString(record.turnId) || trimString(record.turn_id);
}

export function extractTurnIdFromParams(params: JsonRecord) {
  return (
    trimString(params.turnId) ||
    trimString(params.turn_id) ||
    extractTurnIdFromTurnRecord(params.turn) ||
    extractTurnIdFromItemRecord(params.item)
  );
}

function extractActiveTurnRecord(rawThread: Record<string, unknown>) {
  return rawThread.activeTurn && typeof rawThread.activeTurn === "object"
    ? (rawThread.activeTurn as Record<string, unknown>)
    : rawThread.active_turn && typeof rawThread.active_turn === "object"
      ? (rawThread.active_turn as Record<string, unknown>)
      : null;
}

function extractTurnObjectId(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? trimString((value as Record<string, unknown>).id)
    : "";
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

export function extractActiveTurnIdFromThread(rawThread: Record<string, unknown>) {
  normalizeStaleInProgressThread(rawThread);
  const direct = readDirectActiveTurnId(rawThread);
  if (direct) {
    return direct;
  }
  const activeTurnRecord = extractActiveTurnRecord(rawThread);
  const fromRecord = extractTurnObjectId(activeTurnRecord);
  if (fromRecord) {
    return fromRecord;
  }
  if (normalizeThreadStatusType(rawThread.status) !== "active") {
    return null;
  }
  return findLatestTurnId(readThreadTurns(rawThread));
}

function toStoredItemId(turnId: string, itemId: string) {
  return itemId.startsWith(`${turnId}:`) ? itemId : `${turnId}:${itemId}`;
}

export function appServerItemIdMatches(storedItemId: string, requestedItemId: string) {
  return (
    storedItemId === requestedItemId ||
    storedItemId.endsWith(`:${requestedItemId}`) ||
    requestedItemId.endsWith(`:${storedItemId}`)
  );
}

function toStoredItemFromAppServer(turnId: string, item: JsonRecord): StoredThreadItem {
  const itemId = trimString(item.id) || `item-${randomUUID()}`;
  return {
    ...item,
    id: toStoredItemId(turnId, itemId),
  };
}

function appServerTurnStatus(value: unknown): StoredTurn["status"] {
  switch (trimString(value).toLowerCase()) {
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

function coerceAccessMode(value: unknown): StoredThreadCodexParams["accessMode"] {
  const normalized = trimString(value).toLowerCase();
  if (normalized === "read-only" || normalized === "current" || normalized === "full-access") {
    return normalized;
  }
  return null;
}

function coerceServiceTier(value: unknown): StoredThreadCodexParams["serviceTier"] {
  const normalized = trimString(value).toLowerCase();
  if (normalized === "fast" || normalized === "flex") {
    return normalized;
  }
  return null;
}

export function normalizeStoredThreadCodexParamsPatch(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as JsonRecord;
  const normalized: Partial<StoredThreadCodexParams> = {
    updatedAt: Date.now(),
  };
  if ("modelId" in record || "model" in record) {
    normalized.modelId = toNullableString(record.modelId ?? record.model);
  }
  if ("effort" in record || "modelReasoningEffort" in record) {
    normalized.effort = toNullableString(record.effort ?? record.modelReasoningEffort);
  }
  if ("serviceTier" in record) {
    normalized.serviceTier = coerceServiceTier(record.serviceTier);
  }
  if ("accessMode" in record) {
    normalized.accessMode = coerceAccessMode(record.accessMode);
  }
  if ("collaborationModeId" in record || "collaborationMode" in record) {
    normalized.collaborationModeId = toNullableString(
      record.collaborationModeId ?? record.collaborationMode,
    );
  }
  if ("codexArgsOverride" in record || "codexArgs" in record) {
    normalized.codexArgsOverride = toNullableString(record.codexArgsOverride ?? record.codexArgs);
  }
  return normalized;
}

export function mergeStoredThreadCodexParams(
  existing: StoredThreadCodexParams | null,
  patch: Partial<StoredThreadCodexParams>,
) {
  return {
    modelId: patch.modelId ?? existing?.modelId ?? null,
    effort: patch.effort ?? existing?.effort ?? null,
    serviceTier: patch.serviceTier ?? existing?.serviceTier ?? null,
    accessMode: patch.accessMode ?? existing?.accessMode ?? null,
    collaborationModeId: patch.collaborationModeId ?? existing?.collaborationModeId ?? null,
    codexArgsOverride: patch.codexArgsOverride ?? existing?.codexArgsOverride ?? null,
    updatedAt: patch.updatedAt ?? existing?.updatedAt ?? Date.now(),
  } satisfies StoredThreadCodexParams;
}

export function getOptionalServiceTier(
  params: JsonRecord,
  key: string,
): "fast" | "flex" | null | undefined {
  if (!(key in params)) {
    return undefined;
  }
  const normalized = trimString(params[key]).toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "fast" || normalized === "flex") {
    return normalized;
  }
  return null;
}

export function approvalPolicyForAccessMode(accessMode: string | null) {
  return accessMode === "full-access" ? "never" : "on-request";
}

export function buildSandboxPolicy(workspacePath: string, accessMode: string | null) {
  switch (accessMode) {
    case "full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return { type: "readOnly" };
    default:
      return {
        type: "workspaceWrite",
        writableRoots: [workspacePath],
        networkAccess: true,
      };
  }
}

type BuildClient = (settings: JsonRecord, workspaceId?: string | null) => CodexAppServerClient;

export type ThreadStateServiceContext = {
  storage: CompanionStorage;
  workspacesById: Map<string, StoredWorkspace>;
  threadsById: Map<string, StoredThread>;
  appServerThreadWorkspaceIds: Map<string, string>;
  readSettings: () => Promise<JsonRecord>;
  buildAppServerClient: BuildClient;
  notFound: (message: string) => RpcErrorShape;
  badRequest: (message: string) => RpcErrorShape;
  rpcBoundaryError: (error: unknown) => RpcErrorShape;
};

export class ThreadStateService {
  constructor(private readonly context: ThreadStateServiceContext) {}

  listThreads() {
    return Array.from(this.context.threadsById.values());
  }

  getWorkspace(workspaceId: string) {
    return this.context.workspacesById.get(workspaceId) ?? null;
  }

  getThread(threadId: string) {
    return this.context.threadsById.get(threadId) ?? null;
  }

  getThreadForWorkspace(workspaceId: string, threadId: string) {
    const thread = this.getThread(threadId);
    if (!thread || thread.workspaceId !== workspaceId) {
      return null;
    }
    return thread;
  }

  async persistThreads() {
    await this.context.storage.writeThreads(Array.from(this.context.threadsById.values()));
  }

  async persistWorkspaces() {
    await this.context.storage.writeWorkspaces(Array.from(this.context.workspacesById.values()));
  }

  patchThreadCodexParamsRecord(
    workspaceId: string,
    threadId: string,
    patch: Partial<StoredThreadCodexParams>,
  ) {
    const thread = this.getThreadForWorkspace(workspaceId, threadId);
    if (!thread) {
      return null;
    }
    thread.codexParams = mergeStoredThreadCodexParams(thread.codexParams, patch);
    thread.updatedAt = Date.now();
    return thread;
  }

  patchWorkspaceComposerDefaultsRecord(
    workspaceId: string,
    patch: Partial<StoredThreadCodexParams>,
  ) {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) {
      return null;
    }
    workspace.settings = {
      ...workspace.settings,
      composerDefaults: mergeStoredThreadCodexParams(
        workspace.settings.composerDefaults ?? null,
        patch,
      ),
    };
    return workspace;
  }

  splitThreadScopeKey(key: string) {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= key.length - 1) {
      return null;
    }
    return {
      workspaceId: key.slice(0, separatorIndex),
      threadId: key.slice(separatorIndex + 1),
    };
  }

  async importClientThreadMetadata(params: JsonRecord) {
    const pinnedThreads =
      params.pinnedThreads && typeof params.pinnedThreads === "object"
        ? (params.pinnedThreads as Record<string, unknown>)
        : {};
    const threadCodexParams =
      params.threadCodexParams && typeof params.threadCodexParams === "object"
        ? (params.threadCodexParams as Record<string, unknown>)
        : {};
    const detachedReviewLinks =
      params.detachedReviewLinks && typeof params.detachedReviewLinks === "object"
        ? (params.detachedReviewLinks as Record<string, unknown>)
        : {};
    const customNames =
      params.customNames && typeof params.customNames === "object"
        ? (params.customNames as Record<string, unknown>)
        : {};
    let didChangeThreads = false;
    let didChangeWorkspaces = false;

    for (const [key, value] of Object.entries(pinnedThreads)) {
      const scope = this.splitThreadScopeKey(key);
      const pinnedAt = typeof value === "number" && Number.isFinite(value) ? value : null;
      if (!scope || pinnedAt === null) {
        continue;
      }
      const thread = this.getThreadForWorkspace(scope.workspaceId, scope.threadId);
      if (!thread) {
        continue;
      }
      if (thread.pinnedAt === null || pinnedAt > thread.pinnedAt) {
        thread.pinnedAt = pinnedAt;
        didChangeThreads = true;
      }
    }

    for (const [key, value] of Object.entries(threadCodexParams)) {
      const scope = this.splitThreadScopeKey(key);
      const patch = normalizeStoredThreadCodexParamsPatch(value);
      if (!scope || !patch) {
        continue;
      }
      if (scope.threadId === NO_THREAD_SCOPE_SUFFIX) {
        const workspace = this.patchWorkspaceComposerDefaultsRecord(scope.workspaceId, patch);
        if (workspace) {
          didChangeWorkspaces = true;
        }
        continue;
      }
      const thread = this.patchThreadCodexParamsRecord(scope.workspaceId, scope.threadId, patch);
      if (thread) {
        didChangeThreads = true;
      }
    }

    for (const [workspaceId, links] of Object.entries(detachedReviewLinks)) {
      if (!links || typeof links !== "object") {
        continue;
      }
      for (const [childId, parentId] of Object.entries(links as Record<string, unknown>)) {
        const thread = this.getThreadForWorkspace(workspaceId, childId);
        if (!thread || typeof parentId !== "string" || !parentId.trim()) {
          continue;
        }
        if (!thread.detachedReviewParentId) {
          thread.detachedReviewParentId = parentId;
          didChangeThreads = true;
        }
      }
    }

    for (const [key, value] of Object.entries(customNames)) {
      const scope = this.splitThreadScopeKey(key);
      const name = typeof value === "string" ? value.trim() : "";
      if (!scope || !name) {
        continue;
      }
      const thread = this.getThreadForWorkspace(scope.workspaceId, scope.threadId);
      if (!thread || thread.name) {
        continue;
      }
      thread.name = name;
      didChangeThreads = true;
    }

    await Promise.all([
      didChangeThreads ? this.persistThreads() : Promise.resolve(),
      didChangeWorkspaces ? this.persistWorkspaces() : Promise.resolve(),
    ]);

    return {
      imported: {
        pinnedThreads: Object.keys(pinnedThreads).length,
        threadCodexParams: Object.keys(threadCodexParams).length,
        detachedReviewLinks: Object.keys(detachedReviewLinks).length,
        customNames: Object.keys(customNames).length,
      },
    };
  }

  createBacklogItem(text: string): ThreadBacklogItem {
    const now = Date.now();
    return {
      id: randomUUID(),
      text,
      createdAt: now,
      updatedAt: now,
    };
  }

  sortBacklog(items: ThreadBacklogItem[]) {
    items.sort((a, b) => b.createdAt - a.createdAt);
    return items;
  }

  findRollbackTarget(thread: StoredThread, messageItemId: string) {
    for (let index = 0; index < thread.turns.length; index += 1) {
      const turn = thread.turns[index]!;
      const item = turn.items.find((entry) =>
        appServerItemIdMatches(trimString(entry.id), messageItemId),
      );
      if (!item) {
        continue;
      }
      return { turnIndex: index, turn, item };
    }
    return null;
  }

  findThreadBySdkThreadId(threadId: string) {
    return (
      Array.from(this.context.threadsById.values()).find(
        (entry) => entry.sdkThreadId === threadId || entry.id === threadId,
      ) ?? null
    );
  }

  resolveWorkspaceIdForCwd(cwd: string) {
    const normalizedCwd = normalizeRootPath(cwd);
    if (!normalizedCwd) {
      return null;
    }
    const matches = Array.from(this.context.workspacesById.values())
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

  resolveAppServerThreadId(thread: StoredThread) {
    return thread.sdkThreadId || thread.id;
  }

  buildStoredThreadFromAppServer(
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
      preview: existing?.name || existing?.preview || trimString(rawThread.preview) || "New Agent",
      activeTurnId,
      turns,
      modelId: existing?.modelId ?? null,
      effort: existing?.effort ?? null,
      pinnedAt: existing?.pinnedAt ?? null,
      detachedReviewParentId: existing?.detachedReviewParentId ?? null,
      codexParams: existing?.codexParams ?? null,
      backlog: existing?.backlog ?? [],
      tokenUsage: existing?.tokenUsage ?? null,
    };
  }

  updateThreadWorkspaceMapping(thread: StoredThread) {
    this.context.appServerThreadWorkspaceIds.set(this.resolveAppServerThreadId(thread), thread.workspaceId);
  }

  findThreadByAppServerThreadId(threadId: string) {
    const mappedWorkspaceId = this.context.appServerThreadWorkspaceIds.get(threadId) ?? null;
    if (mappedWorkspaceId) {
      const directMatch = Array.from(this.context.threadsById.values()).find(
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

  clearStoredActiveTurn(thread: StoredThread, turnId?: string | null) {
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

  async refreshThreadStateFromAppServer(
    settings: JsonRecord,
    workspaceId: string,
    thread: StoredThread,
  ) {
    const client = this.context.buildAppServerClient(settings, workspaceId);
    const response = await client.readThreadWithTurns(this.resolveAppServerThreadId(thread));
    const rawThread =
      response.thread && typeof response.thread === "object"
        ? (response.thread as Record<string, unknown>)
        : null;
    if (!rawThread) {
      return thread;
    }
    const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread, thread);
    this.context.threadsById.set(stored.id, stored);
    this.updateThreadWorkspaceMapping(stored);
    await this.persistThreads();
    return stored;
  }

  upsertStoredTurn(
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

  upsertStoredItem(thread: StoredThread, turnId: string, item: JsonRecord) {
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

  findStoredThreadForTurn(workspaceIds: string[], turnId: string) {
    for (const thread of this.context.threadsById.values()) {
      if (!workspaceIds.includes(thread.workspaceId)) {
        continue;
      }
      if (thread.activeTurnId === turnId || thread.turns.some((turn) => turn.id === turnId)) {
        return thread;
      }
    }
    return null;
  }

  findStoredThreadByTurnId(turnId: string) {
    for (const thread of this.context.threadsById.values()) {
      if (thread.activeTurnId === turnId || thread.turns.some((turn) => turn.id === turnId)) {
        return thread;
      }
    }
    return null;
  }

  async applyAppServerNotificationToState(
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
      this.context.threadsById.set(stored.id, stored);
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
        if (statusType === "idle" || statusType === "notloaded" || statusType === "systemerror") {
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

  async syncStoredThreadFromAppServer(
    workspaceId: string,
    threadId: string,
    existing?: StoredThread | null,
  ) {
    const result = await this.resumeThreadFromCodexAppServer(threadId);
    const rawThread =
      result.thread && typeof result.thread === "object"
        ? (result.thread as Record<string, unknown>)
        : result;
    const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread, existing);
    this.context.threadsById.set(stored.id, stored);
    this.updateThreadWorkspaceMapping(stored);
    await this.persistThreads();
    return stored;
  }

  async listThreadsFromCodexAppServer(
    workspaceId: string,
    cursor: string | null,
    limit: number | null,
    sortKey: "created_at" | "updated_at",
  ) {
    const settings = await this.context.readSettings();
    const client = this.context.buildAppServerClient(settings, workspaceId);
    return await client.listThreads({
      cursor,
      limit,
      sortKey,
      sourceKinds: APP_SERVER_SOURCE_KINDS,
    });
  }

  async resumeThreadFromCodexAppServer(threadId: string) {
    const settings = await this.context.readSettings();
    const client = this.context.buildAppServerClient(settings);
    return await client.resumeThread(threadId);
  }

  listLocalThreadSummaries(
    workspaceId: string,
    sortKey: "created_at" | "updated_at",
  ): ReturnType<typeof toThreadSummary>[] {
    return Array.from(this.context.threadsById.values())
      .filter((thread) => thread.workspaceId === workspaceId && thread.archivedAt === null)
      .sort((left, right) =>
        sortKey === "created_at" ? right.createdAt - left.createdAt : right.updatedAt - left.updatedAt,
      )
      .map(toThreadSummary);
  }

  mergeThreadListData(
    workspaceId: string,
    localOnlyThreads: ReturnType<typeof toThreadSummary>[],
    externalData: Record<string, unknown>[],
  ) {
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
          name: localThread.name,
          preview: trimString(thread.preview) || localThread.preview,
          createdAt: externalCreatedAt || localThread.createdAt,
          updatedAt: externalUpdatedAt || localThread.updatedAt,
          pinnedAt: localThread.pinnedAt,
          detachedReviewParentId: localThread.detachedReviewParentId,
          codexParams: localThread.codexParams,
          ...(externalActiveTurnId ? { activeTurnId: externalActiveTurnId } : {}),
          ...(externalModel || localThread.modelId ? { model: externalModel || localThread.modelId } : {}),
          ...(externalEffort || localThread.effort
            ? { modelReasoningEffort: externalEffort || localThread.effort }
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

  async listThreadsRpc(params: JsonRecord): Promise<unknown | RpcErrorShape> {
    const workspaceId = String(params.workspaceId ?? "");
    const sortKey =
      String(params.sortKey ?? "updated_at") === "created_at" ? "created_at" : "updated_at";
    const cursor = toNullableString(params.cursor);
    const limit =
      typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : null;
    if (!this.getWorkspace(workspaceId)) {
      return this.context.notFound("Workspace not found.");
    }

    const localOnlyThreads = this.listLocalThreadSummaries(workspaceId, sortKey);
    try {
      const result = await this.listThreadsFromCodexAppServer(workspaceId, cursor, limit, sortKey);
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

  async resumeThreadRpc(params: JsonRecord): Promise<unknown | RpcErrorShape> {
    const workspaceId = String(params.workspaceId ?? "");
    const threadId = String(params.threadId ?? "");
    const thread = this.getThread(threadId);
    if (thread && thread.id !== thread.sdkThreadId) {
      return { thread: toThreadResponse(thread) };
    }
    try {
      const result = await this.resumeThreadFromCodexAppServer(threadId);
      const rawThread =
        result.thread && typeof result.thread === "object"
          ? (result.thread as Record<string, unknown>)
          : null;
      if (!rawThread) {
        return this.context.notFound("Thread not found.");
      }
      const resolvedWorkspaceId =
        workspaceId || this.resolveWorkspaceIdForCwd(trimString(rawThread.cwd)) || thread?.workspaceId || null;
      if (!resolvedWorkspaceId) {
        return { thread: rawThread };
      }
      const stored = this.buildStoredThreadFromAppServer(resolvedWorkspaceId, rawThread, thread);
      this.context.threadsById.set(stored.id, stored);
      await this.persistThreads();
      return { thread: toThreadResponse(stored) };
    } catch (error) {
      if (!thread) {
        return this.context.notFound("Thread not found.");
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

  async handleRpc(method: string, params: JsonRecord): Promise<unknown | RpcErrorShape | undefined> {
    switch (method) {
      case "start_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        if (!workspace) {
          return this.context.notFound("Workspace not found.");
        }
        try {
          const settings = await this.context.readSettings();
          const client = this.context.buildAppServerClient(settings, workspaceId);
          const response = await client.startThread({
            cwd: workspace.path,
            approvalPolicy: "on-request",
          });
          const rawThread =
            response.thread && typeof response.thread === "object"
              ? (response.thread as Record<string, unknown>)
              : null;
          if (!rawThread) {
            return this.context.badRequest("codex app-server did not return a thread.");
          }
          const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread);
          stored.modelId = toNullableString(response.model) ?? stored.modelId;
          this.context.threadsById.set(stored.id, stored);
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
          return this.context.rpcBoundaryError(error);
        }
      }
      case "send_user_message": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        let thread = this.getThread(threadId) ?? this.findThreadBySdkThreadId(threadId);
        if (!workspace || !thread || thread.workspaceId !== workspaceId) {
          return this.context.notFound("Thread or workspace not found.");
        }
        try {
          const settings = await this.context.readSettings();
          const client = this.context.buildAppServerClient(settings, workspaceId);
          if (thread.activeTurnId) {
            thread = await this.refreshThreadStateFromAppServer(settings, workspaceId, thread);
            if (thread.activeTurnId) {
              return this.context.notFound("A turn is already active for this thread.");
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
            return this.context.badRequest("codex app-server did not return a turn.");
          }
          const storedTurn = this.upsertStoredTurn(thread, rawTurn);
          thread.activeTurnId = storedTurn.id;
          thread.updatedAt = Date.now();
          thread.modelId = toNullableString(params.model) ?? thread.modelId;
          thread.effort = toNullableString(params.effort) ?? thread.effort;
          await this.persistThreads();
          return { turn: { id: storedTurn.id, threadId: thread.id } };
        } catch (error) {
          return this.context.rpcBoundaryError(error);
        }
      }
      case "turn_interrupt": {
        const threadId = String(params.threadId ?? "");
        const workspaceId = String(params.workspaceId ?? "");
        const thread = this.getThread(threadId) ?? this.findThreadBySdkThreadId(threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          return this.context.notFound("No active turn found.");
        }
        const turnId = toNullableString(params.turnId) ?? thread.activeTurnId;
        if (!turnId) {
          return this.context.notFound("No active turn found.");
        }
        try {
          const settings = await this.context.readSettings();
          const client = this.context.buildAppServerClient(settings, workspaceId);
          await client.interruptTurn({
            threadId: this.resolveAppServerThreadId(thread),
            turnId,
          });
          return { turnId };
        } catch (error) {
          return this.context.rpcBoundaryError(error);
        }
      }
      case "turn_steer": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const turnId = String(params.turnId ?? "");
        const thread = this.getThread(threadId);
        if (!workspaceId || !thread || thread.workspaceId !== workspaceId) {
          return this.context.notFound("Thread or workspace not found.");
        }
        if (!turnId.trim()) {
          return this.context.badRequest("Missing active turn id.");
        }
        try {
          const client = this.context.buildAppServerClient(await this.context.readSettings(), workspaceId);
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
          return this.context.rpcBoundaryError(error);
        }
      }
      case "start_review": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        const thread = this.getThread(threadId);
        if (!workspace || !thread || thread.workspaceId !== workspaceId) {
          return this.context.notFound("Thread or workspace not found.");
        }
        try {
          const client = this.context.buildAppServerClient(await this.context.readSettings(), workspaceId);
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
            const reviewThread = await this.syncStoredThreadFromAppServer(workspaceId, reviewThreadId);
            reviewThread.detachedReviewParentId = thread.id;
            reviewThread.updatedAt = Date.now();
            await this.persistThreads();
          }
          return response;
        } catch (error) {
          return this.context.rpcBoundaryError(error);
        }
      }
      case "respond_to_server_request": {
        const workspaceId = String(params.workspaceId ?? "");
        if (!this.getWorkspace(workspaceId)) {
          return this.context.notFound("Workspace not found.");
        }
        const requestId = params.requestId ?? params.request_id;
        if (typeof requestId !== "string" && typeof requestId !== "number") {
          return this.context.badRequest("requestId is required.");
        }
        try {
          const settings = await this.context.readSettings();
          const client = this.context.buildAppServerClient(settings, workspaceId);
          await client.sendResponse(requestId, params.result ?? null);
          return null;
        } catch (error) {
          return this.context.rpcBoundaryError(error);
        }
      }
      case "thread_live_subscribe":
      case "thread_live_unsubscribe": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        if (!this.getWorkspace(workspaceId)) {
          return this.context.notFound("Workspace not found.");
        }
        if (!threadId.trim()) {
          return this.context.badRequest("threadId is required.");
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
          return this.context.notFound("Thread or workspace not found.");
        }
        try {
          const client = this.context.buildAppServerClient(await this.context.readSettings(), workspaceId);
          const response = await client.forkThread(this.resolveAppServerThreadId(thread));
          const rawThread =
            response.thread && typeof response.thread === "object"
              ? (response.thread as Record<string, unknown>)
              : null;
          if (rawThread) {
            const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread);
            this.context.threadsById.set(stored.id, stored);
            await this.persistThreads();
          }
          return response;
        } catch (error) {
          return this.context.rpcBoundaryError(error);
        }
      }
      case "rollback_thread_to_message": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const messageItemId = trimString(params.messageItemId);
        const workspace = this.getWorkspace(workspaceId);
        const thread = this.getThreadForWorkspace(workspaceId, threadId);
        if (!workspace || !thread) {
          return this.context.notFound("Thread or workspace not found.");
        }
        if (!messageItemId) {
          return this.context.badRequest("Message item id is required.");
        }
        const target = this.findRollbackTarget(thread, messageItemId);
        if (!target) {
          return this.context.notFound("Message not found.");
        }
        if (trimString(target.item.type) !== "userMessage") {
          return this.context.badRequest("Only user messages can be used as rollback targets.");
        }
        const numTurns = thread.turns.length - target.turnIndex;
        if (numTurns < 1) {
          return this.context.badRequest("Rollback target is invalid.");
        }
        const restoredText = extractUserMessageTextFromStoredItem(target.item);
        try {
          const client = this.context.buildAppServerClient(await this.context.readSettings(), workspaceId);
          const response = await client.rollbackThread(this.resolveAppServerThreadId(thread), numTurns);
          const rawThread =
            response.thread && typeof response.thread === "object"
              ? (response.thread as Record<string, unknown>)
              : null;
          if (!rawThread) {
            return this.context.notFound("Rolled back thread was not returned by app-server.");
          }
          const stored = this.buildStoredThreadFromAppServer(workspaceId, rawThread, thread);
          this.context.threadsById.set(stored.id, stored);
          this.updateThreadWorkspaceMapping(stored);
          await this.persistThreads();
          return { restoredText, thread: toThreadResponse(stored, { includeStatus: false }) };
        } catch (error) {
          return this.context.rpcBoundaryError(error);
        }
      }
      case "compact_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const workspace = this.getWorkspace(workspaceId);
        const thread = this.getThread(threadId);
        if (!workspace || !thread || thread.workspaceId !== workspaceId) {
          return this.context.notFound("Thread or workspace not found.");
        }
        try {
          const client = this.context.buildAppServerClient(await this.context.readSettings(), workspaceId);
          return await client.compactThread(this.resolveAppServerThreadId(thread));
        } catch (error) {
          return this.context.rpcBoundaryError(error);
        }
      }
      case "archive_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const thread = this.getThread(threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          return this.context.notFound("Thread not found.");
        }
        try {
          const settings = await this.context.readSettings();
          const client = this.context.buildAppServerClient(settings, workspaceId);
          await client.archiveThread(this.resolveAppServerThreadId(thread));
          thread.archivedAt = Date.now();
          thread.updatedAt = Date.now();
          await this.persistThreads();
          return null;
        } catch (error) {
          return this.context.rpcBoundaryError(error);
        }
      }
      case "set_thread_name": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const name = String(params.name ?? "");
        const thread = this.getThread(threadId);
        if (!thread || thread.workspaceId !== workspaceId) {
          return this.context.notFound("Thread not found.");
        }
        try {
          const settings = await this.context.readSettings();
          const client = this.context.buildAppServerClient(settings, workspaceId);
          await client.setThreadName(this.resolveAppServerThreadId(thread), name);
          thread.name = name || null;
          thread.updatedAt = Date.now();
          await this.persistThreads();
          return null;
        } catch (error) {
          return this.context.rpcBoundaryError(error);
        }
      }
      case "pin_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const thread = this.getThreadForWorkspace(workspaceId, threadId);
        if (!thread) {
          return this.context.notFound("Thread not found.");
        }
        thread.pinnedAt = Date.now();
        thread.updatedAt = Date.now();
        await this.persistThreads();
        return { pinnedAt: thread.pinnedAt };
      }
      case "unpin_thread": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const thread = this.getThreadForWorkspace(workspaceId, threadId);
        if (!thread) {
          return this.context.notFound("Thread not found.");
        }
        thread.pinnedAt = null;
        thread.updatedAt = Date.now();
        await this.persistThreads();
        return null;
      }
      case "patch_thread_codex_params": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const patch = normalizeStoredThreadCodexParamsPatch(params.patch);
        if (!patch) {
          return this.context.badRequest("Thread codex params patch is required.");
        }
        const thread = this.patchThreadCodexParamsRecord(workspaceId, threadId, patch);
        if (!thread) {
          return this.context.notFound("Thread not found.");
        }
        await this.persistThreads();
        return { codexParams: thread.codexParams };
      }
      case "clear_thread_codex_params": {
        const workspaceId = String(params.workspaceId ?? "");
        const threadId = String(params.threadId ?? "");
        const thread = this.getThreadForWorkspace(workspaceId, threadId);
        if (!thread) {
          return this.context.notFound("Thread not found.");
        }
        thread.codexParams = null;
        thread.updatedAt = Date.now();
        await this.persistThreads();
        return null;
      }
      case "patch_workspace_composer_defaults": {
        const workspaceId = String(params.workspaceId ?? "");
        const patch = normalizeStoredThreadCodexParamsPatch(params.patch);
        if (!patch) {
          return this.context.badRequest("Workspace composer defaults patch is required.");
        }
        const workspace = this.patchWorkspaceComposerDefaultsRecord(workspaceId, patch);
        if (!workspace) {
          return this.context.notFound("Workspace not found.");
        }
        await this.persistWorkspaces();
        return { ...workspace };
      }
      case "import_client_thread_metadata":
        return await this.importClientThreadMetadata(params);
      default:
        return undefined;
    }
  }
}
