import { randomUUID } from "node:crypto";
import { trimString, toNullableString } from "./codexCoreUtils.js";
import type { JsonRecord, StoredThread, StoredThreadItem, StoredTurn } from "../types.js";

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
    ...(thread.activeTurnId ? { activeTurnId: thread.activeTurnId } : {}),
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

export function toOptionalTimestamp(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
  }
  return null;
}

export function normalizeThreadStatusType(status: unknown) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return trimString(status).toLowerCase();
  }
  const record = status as Record<string, unknown>;
  return trimString(record.type ?? record.statusType ?? record.status_type).toLowerCase();
}

export function extractActiveTurnIdFromThread(rawThread: Record<string, unknown>) {
  const direct = trimString(rawThread.activeTurnId) || trimString(rawThread.active_turn_id);
  if (direct) {
    return direct;
  }
  const activeTurn =
    rawThread.activeTurn && typeof rawThread.activeTurn === "object" && !Array.isArray(rawThread.activeTurn)
      ? (rawThread.activeTurn as Record<string, unknown>)
      : rawThread.active_turn &&
          typeof rawThread.active_turn === "object" &&
          !Array.isArray(rawThread.active_turn)
        ? (rawThread.active_turn as Record<string, unknown>)
        : null;
  return activeTurn ? trimString(activeTurn.id) || null : null;
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

export function toStoredItemFromAppServer(turnId: string, item: JsonRecord): StoredThreadItem {
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

export function buildStoredTurnFromAppServerThread(
  threadId: string,
  threadCreatedAt: number,
  threadUpdatedAt: number,
  rawTurn: Record<string, unknown>,
  index: number,
  existing?: StoredTurn,
): StoredTurn {
  const turnId = trimString(rawTurn.id) || existing?.id || `${threadId}:turn-${index + 1}`;
  const status = appServerTurnStatus(rawTurn.status ?? existing?.status);
  const rawItems = Array.isArray(rawTurn.items)
    ? (rawTurn.items as Record<string, unknown>[])
    : null;
  const items =
    rawItems?.map((item, itemIndex) => ({
      ...item,
      id: trimString(item.id) || existing?.items[itemIndex]?.id || `${turnId}:item-${itemIndex + 1}`,
    })) ?? existing?.items ?? [];
  const createdAt =
    toOptionalTimestamp(rawTurn.createdAt ?? rawTurn.created_at) ??
    existing?.createdAt ??
    threadCreatedAt;
  const completedAtFromPayload =
    toOptionalTimestamp(rawTurn.completedAt ?? rawTurn.completed_at) ??
    toOptionalTimestamp(rawTurn.finishedAt ?? rawTurn.finished_at);
  const completedAt =
    completedAtFromPayload ??
    (status === "active" ? null : existing?.completedAt ?? threadUpdatedAt);
  return {
    id: turnId,
    createdAt,
    completedAt,
    status,
    errorMessage:
      toNullableString(rawTurn.errorMessage ?? rawTurn.error_message ?? rawTurn.error) ??
      existing?.errorMessage ??
      null,
    items,
  };
}
