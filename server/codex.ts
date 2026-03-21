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
  runGit,
  runGitCommit,
  runGitNoIndexDiff,
  tryRunGit,
} from "./codex/gitRuntime.js";
import { handleCompanionRuntimeRpc as dispatchCompanionRuntimeRpc } from "./codex/codexRpcRuntime.js";
import { handleThreadBacklogRpc as dispatchThreadBacklogRpc } from "./codex/codexRpcThreadBacklog.js";
import { classifyRpcBoundaryError } from "./codex/rpcErrors.js";
import { buildLocalUsageSnapshot } from "./codex/localUsage.js";
import { handlePromptRpc as dispatchPromptRpc } from "./codex/codexPromptRpc.js";
import { AccountRuntimeService } from "./codex/codexAccountRuntimeService.js";
import { AppServerRuntimeService } from "./codex/codexAppServerRuntimeService.js";
import { errorMessage } from "./codex/codexCoreUtils.js";
import { GenerationRuntimeService } from "./codex/codexGenerationRuntimeService.js";
import { ThreadStateService } from "./codex/codexThreadStateService.js";
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
  StoredThreadCodexParams,
  StoredWorkspace,
} from "./types.js";
export {
  buildAppServerUserInputItems,
  buildRunMetadataPrompt,
  parseRunMetadataValue,
} from "./codex/codexPrompts.js";

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

function mapPathValidationError(error: unknown): RpcErrorShape {
  const message = errorMessage(error);
  if (message === "Workspace not found.") {
    return notFound(message);
  }
  return badRequest(message);
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
    composerDefaults: null,
  };
}

function mergeStoredThreadCodexParams(
  current: StoredThreadCodexParams | null,
  patch: Partial<StoredThreadCodexParams>,
): StoredThreadCodexParams | null {
  const nextBase: StoredThreadCodexParams = {
    modelId: current?.modelId ?? null,
    effort: current?.effort ?? null,
    ...(Object.prototype.hasOwnProperty.call(current ?? {}, "serviceTier")
      ? { serviceTier: current?.serviceTier }
      : {}),
    accessMode: current?.accessMode ?? null,
    collaborationModeId: current?.collaborationModeId ?? null,
    ...(Object.prototype.hasOwnProperty.call(current ?? {}, "codexArgsOverride")
      ? { codexArgsOverride: current?.codexArgsOverride }
      : {}),
    updatedAt: current?.updatedAt ?? 0,
  };
  const next: StoredThreadCodexParams = { ...nextBase, ...patch, updatedAt: Date.now() };
  const hasMeaningfulValue =
    next.modelId !== null ||
    next.effort !== null ||
    next.serviceTier !== undefined ||
    next.accessMode !== null ||
    next.collaborationModeId !== null ||
    next.codexArgsOverride !== undefined;
  return hasMeaningfulValue ? next : null;
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
  private readonly threadState: ThreadStateService;
  private readonly appServerRuntime: AppServerRuntimeService;
  private readonly accountRuntime: AccountRuntimeService;
  private readonly generationRuntime: GenerationRuntimeService;

  constructor(
    private readonly storage: CompanionStorage,
    private readonly broadcast: BroadcastFn,
    private readonly requestShutdown?: () => void,
    terminalRuntime?: TerminalRuntime | null,
  ) {
    this.terminalRuntime = terminalRuntime ?? createTerminalRuntime(broadcast);
    this.terminalEnabled = this.terminalRuntime !== null;
    this.threadState = new ThreadStateService({
      storage: this.storage,
      workspacesById: this.workspacesById,
      threadsById: this.threadsById,
      appServerThreadWorkspaceIds: this.appServerThreadWorkspaceIds,
      readSettings: () => this.storage.readSettings(),
      buildAppServerClient: (settings, workspaceId) => this.buildAppServerClient(settings, workspaceId),
      notFound,
      badRequest,
      rpcBoundaryError,
    });
    this.appServerRuntime = new AppServerRuntimeService({
      broadcast: this.broadcast,
      appServerClients: this.appServerClients,
      appServerClientWorkspaceIds: this.appServerClientWorkspaceIds,
      appServerNotificationUnsubscribers: this.appServerNotificationUnsubscribers,
      connectedWorkspaceIds: this.connectedWorkspaceIds,
      threadState: this.threadState,
      appServerClientKey: this.appServerClientKey.bind(this),
      appServerClientOptions: this.appServerClientOptions.bind(this),
    });
    this.accountRuntime = new AccountRuntimeService({
      settingsPath: this.storage.settingsPath,
      getWorkspace: this.getWorkspace.bind(this),
      readSettings: () => this.storage.readSettings(),
      buildAppServerClient: (settings, workspaceId) => this.buildAppServerClient(settings, workspaceId),
      readAuthAccountFallback: () => this.readAuthAccountFallback(),
      loginStateByWorkspace: this.loginStateByWorkspace,
      notFound,
    });
    this.generationRuntime = new GenerationRuntimeService({
      storage: this.storage,
      readSettings: () => this.storage.readSettings(),
      createDetachedAppServerClient: (settings, workspaceId) =>
        this.createDetachedAppServerClient(settings, workspaceId),
      emit: this.emit.bind(this),
      codexCommand: this.codexCommand.bind(this),
      resolveRuntimeCodexArgs: this.resolveRuntimeCodexArgs.bind(this),
      localUsageCacheTtlMs: CodexCompanionServer.LOCAL_USAGE_CACHE_TTL_MS,
      localUsageSnapshotCache: this.localUsageSnapshotCache,
      localUsageSnapshotInFlight: this.localUsageSnapshotInFlight,
    });
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
      this.appServerThreadWorkspaceIds.set(
        this.threadState.resolveAppServerThreadId(thread),
        thread.workspaceId,
      );
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
    await this.appServerRuntime.close();
    await this.terminalRuntime?.closeAll();
    this.appServerThreadWorkspaceIds.clear();
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

  private patchThreadCodexParamsRecord(
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

  private patchWorkspaceComposerDefaultsRecord(
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

  private splitThreadScopeKey(key: string) {
    const separatorIndex = key.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= key.length - 1) {
      return null;
    }
    return {
      workspaceId: key.slice(0, separatorIndex),
      threadId: key.slice(separatorIndex + 1),
    };
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
    return this.appServerRuntime.createDetachedAppServerClient(settings, workspaceId);
  }

  private async readAuthAccountFallback() {
    return await this.accountRuntime.readAuthAccountFallbackFromDisk();
  }

  private buildAppServerClient(settings: JsonRecord, workspaceId?: string | null) {
    return this.appServerRuntime.buildAppServerClient(settings, workspaceId);
  }

  private async resetAppServerClients() {
    await this.appServerRuntime.resetAppServerClients();
  }

  private hasActiveAppServerRuntime() {
    return this.appServerRuntime.hasActiveAppServerRuntime();
  }

  private resolveAppServerThreadId(thread: StoredThread) {
    return this.threadState.resolveAppServerThreadId(thread);
  }

  private async syncStoredThreadFromAppServer(
    workspaceId: string,
    threadId: string,
    existing?: StoredThread | null,
  ) {
    return await this.threadState.syncStoredThreadFromAppServer(workspaceId, threadId, existing);
  }

  private async handleAppServerNotification(
    key: string,
    message: AppServerNotificationMessage,
  ) {
    await this.appServerRuntime.handleAppServerNotification(key, message);
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
        getLocalUsageSnapshot: this.generationRuntime.getLocalUsageSnapshot.bind(this.generationRuntime),
        runCodexDoctor: this.generationRuntime.runCodexDoctor.bind(this.generationRuntime),
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

  private async handleThreadBacklogRpc(
    method: string,
    params: JsonRecord,
  ): Promise<RpcDispatchResult> {
    const result = await dispatchThreadBacklogRpc(
      {
        getThreadForWorkspace: this.threadState.getThreadForWorkspace.bind(this.threadState),
        createBacklogItem: this.threadState.createBacklogItem.bind(this.threadState),
        sortBacklog: this.threadState.sortBacklog.bind(this.threadState),
        persistThreads: this.threadState.persistThreads.bind(this.threadState),
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
      case "start_thread":
      case "send_user_message":
      case "turn_interrupt":
      case "turn_steer":
      case "start_review":
      case "respond_to_server_request":
      case "remember_approval_rule": {
        const result = await this.threadState.handleRpc(method, params);
        if (result !== undefined) {
          return result;
        }
        if (method === "remember_approval_rule") {
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
          const rulesPath = path.join(this.accountRuntime.resolveCodexHomePath(), "rules", "default.rules");
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
        return RPC_UNHANDLED;
      }
      case "thread_live_subscribe":
      case "thread_live_unsubscribe":
      case "list_threads":
      case "resume_thread":
      case "fork_thread":
      case "rollback_thread_to_message":
      case "compact_thread":
      case "archive_thread":
      case "set_thread_name":
      case "pin_thread":
      case "unpin_thread":
      case "patch_thread_codex_params":
      case "clear_thread_codex_params":
      case "patch_workspace_composer_defaults":
      case "import_client_thread_metadata": {
        const result = await this.threadState.handleRpc(method, params);
        return result === undefined ? RPC_UNHANDLED : result;
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
      case "codex_login":
      case "codex_login_cancel": {
        try {
          const result = await this.accountRuntime.handleRpc(method, params);
          return result === undefined ? RPC_UNHANDLED : result;
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
          return await this.generationRuntime.generateRunMetadataForWorkspace(workspace, prompt);
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
          return await this.generationRuntime.generateCommitMessageForWorkspace(
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
          return await this.generationRuntime.generateAgentDescriptionForWorkspace(
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
