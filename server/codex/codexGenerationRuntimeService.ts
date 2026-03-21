import path from "node:path";
import process from "node:process";
import {
  buildAgentDescriptionPrompt,
  buildRunMetadataPrompt,
  findLastAgentMessageText,
  parseAgentDescriptionValue,
  parseRunMetadataValue,
} from "./codexPrompts.js";
import { buildWorkingTreeDiffs } from "./gitInspection.js";
import { runCommandCapture } from "./gitRuntime.js";
import { buildLocalUsageSnapshot } from "./localUsage.js";
import { toNullableString } from "./codexCoreUtils.js";
import type { JsonRecord, StoredWorkspace } from "../types.js";
import type { CompanionStorage } from "../storage.js";
import type { CodexAppServerClient } from "../vendor/codexSdk.js";

const RUN_METADATA_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    worktreeName: { type: "string" },
  },
  required: ["title", "worktreeName"],
  additionalProperties: false,
} as const;

function buildCommitMessagePrompt(diff: string, template: string) {
  const defaultTemplate = template.trim() || "Summarize the changes into a concise git commit message.";
  return `${defaultTemplate}\n\nDiff:\n${diff}`.trim();
}

function buildCommitMessagePromptForDiff(diff: string, template: string) {
  const normalizedDiff = diff.trim();
  if (!normalizedDiff) {
    throw new Error("No diff available for commit message generation.");
  }
  return buildCommitMessagePrompt(normalizedDiff, template);
}

function parseCodexArgs(value: string | null) {
  if (!value) {
    return [];
  }
  return value
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildCodexPathEnv(codexBin: string | null) {
  if (!codexBin) {
    return null;
  }
  const codexDir = path.dirname(codexBin);
  const currentPath = process.env.PATH ?? "";
  if (!codexDir || currentPath.split(path.delimiter).includes(codexDir)) {
    return currentPath;
  }
  return `${codexDir}${path.delimiter}${currentPath}`;
}

function extractThreadIdFromResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as JsonRecord;
  const embeddedThread =
    record.thread && typeof record.thread === "object" && !Array.isArray(record.thread)
      ? (record.thread as JsonRecord)
      : null;
  return (
    toNullableString(record.threadId) ??
    toNullableString(record.thread_id) ??
    toNullableString(record.id) ??
    toNullableString(embeddedThread?.id) ??
    null
  );
}

function extractTurnIdFromResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as JsonRecord;
  const embeddedTurn =
    record.turn && typeof record.turn === "object" && !Array.isArray(record.turn)
      ? (record.turn as JsonRecord)
      : null;
  return (
    toNullableString(record.turnId) ??
    toNullableString(record.turn_id) ??
    toNullableString(embeddedTurn?.id) ??
    null
  );
}

type CreateDetachedClient = (settings: JsonRecord, workspaceId?: string | null) => CodexAppServerClient;
type EmitFn = (workspaceId: string, method: string, params?: JsonRecord, id?: string | number) => void;

export type GenerationRuntimeContext = {
  storage: CompanionStorage;
  readSettings: () => Promise<JsonRecord>;
  createDetachedAppServerClient: CreateDetachedClient;
  emit: EmitFn;
  codexCommand: (settings: JsonRecord) => string;
  resolveRuntimeCodexArgs: (settings: JsonRecord, workspaceId?: string | null) => string | null;
  localUsageCacheTtlMs: number;
  localUsageSnapshotCache: Map<string, { expiresAt: number; snapshot: Awaited<ReturnType<typeof buildLocalUsageSnapshot>> }>;
  localUsageSnapshotInFlight: Map<string, Promise<Awaited<ReturnType<typeof buildLocalUsageSnapshot>>>>;
};

export class GenerationRuntimeService {
  constructor(private readonly context: GenerationRuntimeContext) {}

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
    const settings = await this.context.readSettings();
    const client = this.context.createDetachedAppServerClient(settings, workspace.id);
    let threadId: string | null = null;
    try {
      const threadResponse = await client.startThread({
        cwd: workspace.path,
        approvalPolicy: "never",
      });
      threadId = extractThreadIdFromResponse(threadResponse);
      if (!threadId) {
        throw new Error("Detached background thread did not return an id.");
      }
      this.context.emit(workspace.id, "codex/backgroundThread", {
        threadId,
        action: "hide",
      });

      let responseText = "";
      const unsubscribe = client.onNotification((message) => {
        if (message.method !== "item/agentMessage/delta") {
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
        const completedTurnId =
          typeof message.params.turnId === "string"
            ? message.params.turnId
            : typeof message.params.turn_id === "string"
              ? message.params.turn_id
              : null;
        if (expectedTurnId && completedTurnId && completedTurnId !== expectedTurnId) {
          return null;
        }
        return message.params;
      });

      const turnResponse = await client.startTurn({
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd: workspace.path,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
        model: options.model ?? undefined,
        outputSchema: options.outputSchema,
      });
      expectedTurnId = extractTurnIdFromResponse(turnResponse);

      const completed = await completion;
      unsubscribe();
      const completedTurn =
        completed.turn && typeof completed.turn === "object" && !Array.isArray(completed.turn)
          ? (completed.turn as JsonRecord)
          : null;
      const status = typeof completedTurn?.status === "string" ? completedTurn.status.trim().toLowerCase() : "";
      if (status && status !== "completed") {
        const turnError =
          (completedTurn?.error && typeof completedTurn.error === "object"
            ? String((completedTurn.error as JsonRecord).message ?? "").trim()
            : "") || String(completed.message ?? "").trim();
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

  async generateRunMetadataForWorkspace(workspace: StoredWorkspace, prompt: string) {
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

  async generateCommitMessageForWorkspace(
    workspace: StoredWorkspace,
    commitMessageModelId: string | null,
  ) {
    const settings = await this.context.readSettings();
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

  async generateAgentDescriptionForWorkspace(
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

  async runCodexDoctor(codexBin: string | null, codexArgs: string | null) {
    const settings = await this.context.readSettings();
    const resolvedBin = codexBin?.trim() ? codexBin.trim() : this.context.codexCommand(settings);
    const resolvedArgs = codexArgs?.trim()
      ? codexArgs.trim()
      : this.context.resolveRuntimeCodexArgs(settings, null);
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
    const nodeDetails = nodeResult.ok ? null : nodeResult.error || "Node failed to start.";
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

  async getLocalUsageSnapshot(days: number | null, workspacePath: string | null) {
    const requestedDays = Number.isFinite(days) ? Math.trunc(days ?? 30) : 30;
    const clampedDays = Math.min(Math.max(requestedDays || 30, 1), 90);
    const normalizedWorkspacePath = toNullableString(workspacePath)
      ? String(workspacePath).replace(/[\\/]+$/, "")
      : null;
    const cacheKey = JSON.stringify({ days: clampedDays, workspacePath: normalizedWorkspacePath });
    const now = Date.now();
    const cached = this.context.localUsageSnapshotCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.snapshot;
    }
    const inFlight = this.context.localUsageSnapshotInFlight.get(cacheKey);
    if (inFlight) {
      return await inFlight;
    }
    const sessionsRoots = [path.join(this.context.storage.codexHome, "sessions")];
    const loadPromise = buildLocalUsageSnapshot(sessionsRoots, clampedDays, normalizedWorkspacePath);
    this.context.localUsageSnapshotInFlight.set(cacheKey, loadPromise);
    try {
      const snapshot = await loadPromise;
      this.context.localUsageSnapshotCache.set(cacheKey, {
        expiresAt: now + this.context.localUsageCacheTtlMs,
        snapshot,
      });
      return snapshot;
    } finally {
      this.context.localUsageSnapshotInFlight.delete(cacheKey);
    }
  }
}
