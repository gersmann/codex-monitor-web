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

function parseFirstJsonDocument(raw: string) {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let started = false;
  let startIndex = -1;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];

    if (!started) {
      if (character === "{" || character === "[") {
        started = true;
        startIndex = index;
        depth = 1;
      } else if (!/\s/.test(character)) {
        return null;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }

    if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        const candidate = raw.slice(startIndex, index + 1);
        try {
          return JSON.parse(candidate) as unknown;
        } catch {
          return null;
        }
      }
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
    if (error instanceof SyntaxError) {
      const raw = await fs.readFile(filePath, "utf8");
      const recovered = parseFirstJsonDocument(raw);
      if (recovered !== null) {
        await writeJsonFile(filePath, recovered);
        return recovered as T;
      }
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  await ensureParent(filePath);
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

function normalizeWorkspace(raw: StoredWorkspace): StoredWorkspace {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.path,
    kind: raw.kind,
    parentId: raw.parentId ?? null,
    worktree: raw.worktree ?? null,
    settings: {
      sidebarCollapsed: Boolean(raw.settings?.sidebarCollapsed),
      sortOrder: raw.settings?.sortOrder ?? null,
      groupId: raw.settings?.groupId ?? null,
      cloneSourceWorkspaceId: raw.settings?.cloneSourceWorkspaceId ?? null,
      gitRoot: raw.settings?.gitRoot ?? null,
      launchScript: raw.settings?.launchScript ?? null,
      launchScripts: raw.settings?.launchScripts ?? null,
      worktreeSetupScript: raw.settings?.worktreeSetupScript ?? null,
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

function normalizeThread(raw: StoredThread): StoredThread {
  const backlog = (Array.isArray(raw.backlog) ? raw.backlog : [])
    .map((item): ThreadBacklogItem => ({
      id: String(item.id ?? ""),
      text: String(item.text ?? ""),
      createdAt: Number(item.createdAt ?? 0),
      updatedAt: Number(item.updatedAt ?? item.createdAt ?? 0),
    }))
    .filter((item) => item.id && item.text.trim().length > 0)
    .sort((a, b) => b.createdAt - a.createdAt);
  return {
    ...raw,
    sdkThreadId: raw.sdkThreadId ?? null,
    archivedAt: raw.archivedAt ?? null,
    name: raw.name ?? null,
    preview: raw.preview ?? "New Agent",
    activeTurnId: raw.activeTurnId ?? null,
    modelId: raw.modelId ?? null,
    effort: raw.effort ?? null,
    backlog,
    tokenUsage: raw.tokenUsage ?? null,
    turns: Array.isArray(raw.turns)
      ? raw.turns.map((turn) => ({
          ...turn,
          completedAt: turn.completedAt ?? null,
          status: turn.status,
          errorMessage: turn.errorMessage ?? null,
          items: normalizeTurnItems(turn.id, turn.items),
        }))
      : [],
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
    return readJsonFile<JsonRecord>(this.settingsPath, {});
  }

  async writeSettings(settings: JsonRecord) {
    await writeJsonFile(this.settingsPath, settings);
    return settings;
  }

  async readWorkspaces() {
    const workspaces = await readJsonFile<StoredWorkspace[]>(this.workspacesPath, []);
    return workspaces.map(normalizeWorkspace);
  }

  async writeWorkspaces(workspaces: StoredWorkspace[]) {
    await writeJsonFile(this.workspacesPath, workspaces);
  }

  async readThreads() {
    const file = await readJsonFile<ThreadsFile>(this.threadsPath, { threads: [] });
    return file.threads.map(normalizeThread);
  }

  async writeThreads(threads: StoredThread[]) {
    await writeJsonFile(this.threadsPath, { threads });
  }

  async readTextFile(filePath: string): Promise<TextFileResponse> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      return { exists: true, content, truncated: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, content: "", truncated: false };
      }
      throw error;
    }
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
