import { trimString, toNullableString } from "./codexCoreUtils.js";
import type { JsonRecord, StoredThreadCodexParams } from "../types.js";

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
