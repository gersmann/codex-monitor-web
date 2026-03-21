import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveCodexHome,
  resolveGlobalPromptsDir,
  resolveSettingsPath,
  resolveThreadsPath,
  resolveWorkspacePromptsDir,
  resolveWorkspacesPath,
} from "./paths.js";
import type {
  JsonRecord,
  StoredThread,
  ThreadBacklogItem,
  StoredWorkspace,
  TextFileResponse,
  ThreadsFile,
} from "./types.js";

async function ensureParent(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

const pendingJsonWrites = new Map<string, Promise<void>>();

type JsonScannerState = {
  inString: boolean;
  escaped: boolean;
  depth: number;
  started: boolean;
  startIndex: number;
};

function createJsonScannerState(): JsonScannerState {
  return {
    inString: false,
    escaped: false,
    depth: 0,
    started: false,
    startIndex: -1,
  };
}

function tryStartJsonDocument(state: JsonScannerState, character: string, index: number) {
  if (character === "{" || character === "[") {
    state.started = true;
    state.startIndex = index;
    state.depth = 1;
    return true;
  }
  return /\s/.test(character);
}

function stepJsonStringState(state: JsonScannerState, character: string) {
  if (state.escaped) {
    state.escaped = false;
    return;
  }
  if (character === "\\") {
    state.escaped = true;
    return;
  }
  if (character === "\"") {
    state.inString = false;
  }
}

function stepJsonNestingState(state: JsonScannerState, character: string) {
  if (character === "{" || character === "[") {
    state.depth += 1;
    return false;
  }
  if (character === "}" || character === "]") {
    state.depth -= 1;
    return state.depth === 0 && state.startIndex >= 0;
  }
  return false;
}

function parseFirstJsonDocument(raw: string) {
  const state = createJsonScannerState();
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (!state.started) {
      if (!tryStartJsonDocument(state, character, index)) {
        return null;
      }
      continue;
    }

    if (state.inString) {
      stepJsonStringState(state, character);
      continue;
    }

    if (character === "\"") {
      state.inString = true;
      continue;
    }

    if (!stepJsonNestingState(state, character)) {
      continue;
    }
    const candidate = raw.slice(state.startIndex, index + 1);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }

  return null;
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function recoverJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return await readJsonFile(filePath, fallback);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    const raw = await fs.readFile(filePath, "utf8");
    const recovered = parseFirstJsonDocument(raw);
    if (recovered !== null) {
      await writeJsonFile(filePath, recovered);
      return recovered as T;
    }
    throw error;
  }
}

async function syncParentDirectory(filePath: string) {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(path.dirname(filePath), "r");
    await handle.sync();
  } catch {
    // Best-effort durability only. Some platforms/filesystems don't support directory sync.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeJsonFileAtomically(filePath: string, value: unknown) {
  await ensureParent(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const contents = JSON.stringify(value, null, 2);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tempPath, "w");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
  try {
    await fs.rename(tempPath, filePath);
    await syncParentDirectory(filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  const previous = pendingJsonWrites.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await writeJsonFileAtomically(filePath, value);
  });
  pendingJsonWrites.set(filePath, next);
  try {
    await next;
  } finally {
    if (pendingJsonWrites.get(filePath) === next) {
      pendingJsonWrites.delete(filePath);
    }
  }
}

function normalizeWorkspace(raw: StoredWorkspace): StoredWorkspace {
  const settings = withDefault(raw.settings, { sidebarCollapsed: false });
  return {
    id: raw.id,
    name: raw.name,
    path: raw.path,
    kind: raw.kind,
    parentId: nullableValue(raw.parentId),
    worktree: nullableValue(raw.worktree),
    settings: {
      sidebarCollapsed: Boolean(settings.sidebarCollapsed),
      sortOrder: nullableValue(settings.sortOrder),
      groupId: nullableValue(settings.groupId),
      cloneSourceWorkspaceId: nullableValue(settings.cloneSourceWorkspaceId),
      gitRoot: nullableValue(settings.gitRoot),
      launchScript: nullableValue(settings.launchScript),
      launchScripts: nullableValue(settings.launchScripts),
      worktreeSetupScript: nullableValue(settings.worktreeSetupScript),
    },
  };
}

function normalizeTurnItems(
  turnId: string,
  rawItems: StoredThread["turns"][number]["items"],
) {
  const seenIds = new Set<string>();
  return (Array.isArray(rawItems) ? rawItems : []).map((item, index) => {
    const rawId = typeof item?.id === "string" ? item.id : "";
    let nextId = rawId;
    if (!nextId || seenIds.has(nextId)) {
      const baseId = rawId ? `${turnId}:${rawId}` : `${turnId}:item-${index}`;
      nextId = seenIds.has(baseId) ? `${baseId}-${index}` : baseId;
    }
    seenIds.add(nextId);
    return {
      ...item,
      id: nextId,
    };
  });
}

function normalizeThreadBacklog(rawBacklog: StoredThread["backlog"] | unknown) {
  const backlogItems = Array.isArray(rawBacklog) ? rawBacklog : [];
  return backlogItems
    .map((item): ThreadBacklogItem => ({
      id: String(item.id ?? ""),
      text: String(item.text ?? ""),
      createdAt: Number(item.createdAt ?? 0),
      updatedAt: Number(item.updatedAt ?? item.createdAt ?? 0),
    }))
    .filter((item) => item.id && item.text.trim().length > 0)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function normalizeThreadTurns(rawTurns: StoredThread["turns"] | unknown) {
  if (!Array.isArray(rawTurns)) {
    return [];
  }
  return rawTurns.map((turn) => ({
    ...turn,
    completedAt: nullableValue(turn.completedAt),
    status: turn.status,
    errorMessage: nullableValue(turn.errorMessage),
    items: normalizeTurnItems(turn.id, turn.items),
  }));
}

function nullableValue<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

function withDefault<T>(value: T | null | undefined, fallback: T): T {
  return value === null || value === undefined ? fallback : value;
}

function normalizeThread(raw: StoredThread): StoredThread {
  return {
    ...raw,
    sdkThreadId: nullableValue(raw.sdkThreadId),
    archivedAt: nullableValue(raw.archivedAt),
    name: nullableValue(raw.name),
    preview: withDefault(raw.preview, "New Agent"),
    activeTurnId: nullableValue(raw.activeTurnId),
    modelId: nullableValue(raw.modelId),
    effort: nullableValue(raw.effort),
    backlog: normalizeThreadBacklog(raw.backlog),
    tokenUsage: nullableValue(raw.tokenUsage),
    turns: normalizeThreadTurns(raw.turns),
  };
}

export class CompanionStorage {
  constructor(private readonly dataDir: string) {}

  get settingsPath() {
    return resolveSettingsPath(this.dataDir);
  }

  get workspacesPath() {
    return resolveWorkspacesPath(this.dataDir);
  }

  get threadsPath() {
    return resolveThreadsPath(this.dataDir);
  }

  get codexHome() {
    return resolveCodexHome();
  }

  async readSettings() {
    return recoverJsonFile<JsonRecord>(this.settingsPath, {});
  }

  async writeSettings(settings: JsonRecord) {
    await writeJsonFile(this.settingsPath, settings);
    return settings;
  }

  async readWorkspaces() {
    const workspaces = await recoverJsonFile<StoredWorkspace[]>(this.workspacesPath, []);
    return workspaces.map(normalizeWorkspace);
  }

  async writeWorkspaces(workspaces: StoredWorkspace[]) {
    await writeJsonFile(this.workspacesPath, workspaces);
  }

  async readThreads() {
    const file = await recoverJsonFile<ThreadsFile>(this.threadsPath, { threads: [] });
    return file.threads.map(normalizeThread);
  }

  async writeThreads(threads: StoredThread[]) {
    await writeJsonFile(this.threadsPath, { threads });
  }

  async readTextFile(filePath: string): Promise<TextFileResponse> {
    const content = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (content === null) {
      return { exists: false, content: "", truncated: false };
    }
    return { exists: true, content, truncated: false };
  }

  async writeTextFile(filePath: string, content: string) {
    await ensureParent(filePath);
    await fs.writeFile(filePath, content, "utf8");
  }

  globalAgentsPath() {
    return path.join(this.codexHome, "AGENTS.md");
  }

  globalConfigPath() {
    return path.join(this.codexHome, "config.toml");
  }

  workspaceAgentsPath(workspacePath: string) {
    return path.join(workspacePath, "AGENTS.md");
  }

  workspaceConfigPath(workspacePath: string) {
    return path.join(workspacePath, ".codex", "config.toml");
  }

  workspacePromptsDir(workspaceId: string) {
    return resolveWorkspacePromptsDir(this.dataDir, workspaceId);
  }

  globalPromptsDir() {
    return resolveGlobalPromptsDir(this.dataDir);
  }
}
