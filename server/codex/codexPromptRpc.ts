import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./promptFrontmatter.js";
import { defineRpcMethod, dispatchTypedRpc } from "./rpcHandlerRegistry.js";
import type { JsonRecord, RpcErrorShape, StoredWorkspace } from "../types.js";

type PromptScope = "workspace" | "global";

type PromptEntry = {
  name: string;
  path: string;
  description: string | null;
  argumentHint: string | null;
  content: string;
  scope: PromptScope;
};

type PromptStorageLike = {
  workspacePromptsDir: (workspaceId: string) => string;
  globalPromptsDir: () => string;
};

export type PromptRpcContext = {
  storage: PromptStorageLike;
  getWorkspace: (workspaceId: string) => StoredWorkspace | null;
  badRequest: (message: string) => RpcErrorShape;
  notFound: (message: string) => RpcErrorShape;
  mapPathValidationError: (error: unknown) => RpcErrorShape;
};

function isWithinRoot(rootPath: string, candidatePath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function serializePromptWithFrontmatter(
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

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toNullableString(value: unknown) {
  const trimmed = trimString(value);
  return trimmed.length > 0 ? trimmed : null;
}

async function fileExists(targetPath: string) {
  try {
    return (await fs.stat(targetPath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseWorkspaceIdParam(_context: PromptRpcContext, params: JsonRecord) {
  return {
    workspaceId: String(params.workspaceId ?? ""),
  };
}

function parsePromptWorkspaceDirParams(
  _context: PromptRpcContext,
  params: JsonRecord,
) {
  return {
    workspaceId: String(params.workspaceId ?? ""),
  };
}

function parsePromptGlobalDirParams(_context: PromptRpcContext, _params: JsonRecord) {
  return {};
}

function parsePromptCreateParams(_context: PromptRpcContext, params: JsonRecord) {
  return {
    workspaceId: String(params.workspaceId ?? ""),
    scope: String(params.scope ?? ""),
    name: trimString(params.name),
    description: toNullableString(params.description),
    argumentHint: toNullableString(params.argumentHint),
    content: String(params.content ?? ""),
  };
}

function parsePromptUpdateParams(_context: PromptRpcContext, params: JsonRecord) {
  return {
    workspaceId: String(params.workspaceId ?? ""),
    currentPath: String(params.path ?? ""),
    name: trimString(params.name),
    description: toNullableString(params.description),
    argumentHint: toNullableString(params.argumentHint),
    content: String(params.content ?? ""),
  };
}

function parsePromptDeleteParams(_context: PromptRpcContext, params: JsonRecord) {
  return {
    workspaceId: String(params.workspaceId ?? ""),
    promptPath: String(params.path ?? ""),
  };
}

function parsePromptMoveParams(_context: PromptRpcContext, params: JsonRecord) {
  return {
    workspaceId: String(params.workspaceId ?? ""),
    promptPath: String(params.path ?? ""),
    scope: String(params.scope ?? ""),
  };
}

function definePromptRpcMethod<Params, Result>(
  parse: (context: PromptRpcContext, params: JsonRecord) => Params | RpcErrorShape,
  handle: (
    context: PromptRpcContext,
    params: Params,
  ) => Result | RpcErrorShape | Promise<Result | RpcErrorShape>,
) {
  return defineRpcMethod<PromptRpcContext, Params, Result>(parse, handle);
}

function promptDirectoryForScope(
  context: PromptRpcContext,
  scope: string,
  workspaceId: string,
): string {
  if (scope === "workspace") {
    const workspace = context.getWorkspace(workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found.");
    }
    return context.storage.workspacePromptsDir(workspace.id);
  }
  if (scope === "global") {
    return context.storage.globalPromptsDir();
  }
  throw new Error("Invalid scope.");
}

async function readPromptEntries(
  context: PromptRpcContext,
  workspaceId: string,
): Promise<PromptEntry[]> {
  const workspace = context.getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }
  const promptRoots: Array<{ dir: string; scope: PromptScope }> = [
    { dir: context.storage.workspacePromptsDir(workspace.id), scope: "workspace" },
    { dir: context.storage.globalPromptsDir(), scope: "global" },
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

async function ensurePromptPathAllowed(
  context: PromptRpcContext,
  workspaceId: string,
  promptPath: string,
) {
  const workspace = context.getWorkspace(workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }
  const allowedRoots = [
    path.resolve(context.storage.workspacePromptsDir(workspace.id)),
    path.resolve(context.storage.globalPromptsDir()),
  ];
  const resolved = path.resolve(promptPath);
  if (!allowedRoots.some((root) => isWithinRoot(root, resolved))) {
    throw new Error("Prompt path is not within allowed directories.");
  }
}

const PROMPT_RPC_HANDLERS = {
  prompts_list: definePromptRpcMethod(parseWorkspaceIdParam, async (context, params) => {
    try {
      return await readPromptEntries(context, params.workspaceId);
    } catch (error) {
      return context.mapPathValidationError(error);
    }
  }),
  prompts_workspace_dir: definePromptRpcMethod(parsePromptWorkspaceDirParams, async (context, params) => {
    const workspace = context.getWorkspace(params.workspaceId);
    if (!workspace) {
      return context.notFound("Workspace not found.");
    }
    const promptsDir = context.storage.workspacePromptsDir(workspace.id);
    await fs.mkdir(promptsDir, { recursive: true });
    return promptsDir;
  }),
  prompts_global_dir: definePromptRpcMethod(parsePromptGlobalDirParams, async (context) => {
    const promptsDir = context.storage.globalPromptsDir();
    await fs.mkdir(promptsDir, { recursive: true });
    return promptsDir;
  }),
  prompts_create: definePromptRpcMethod(parsePromptCreateParams, async (context, params) => {
    if (!params.name) {
      return context.badRequest("Prompt name is required.");
    }
    try {
      const promptDir = promptDirectoryForScope(context, params.scope, params.workspaceId);
      await fs.mkdir(promptDir, { recursive: true });
      const promptPath = path.join(promptDir, `${params.name}.md`);
      if (await fileExists(promptPath)) {
        return context.badRequest("Prompt already exists.");
      }
      await fs.writeFile(
        promptPath,
        serializePromptWithFrontmatter(params.description, params.argumentHint, params.content),
        "utf8",
      );
      return {
        name: params.name,
        path: promptPath,
        description: params.description,
        argumentHint: params.argumentHint,
        content: params.content,
        scope: params.scope,
      };
    } catch (error) {
      return context.mapPathValidationError(error);
    }
  }),
  prompts_update: definePromptRpcMethod(parsePromptUpdateParams, async (context, params) => {
    if (!params.name) {
      return context.badRequest("Prompt name is required.");
    }
    try {
      await ensurePromptPathAllowed(context, params.workspaceId, params.currentPath);
      const nextPath = path.join(path.dirname(params.currentPath), `${params.name}.md`);
      if (nextPath !== params.currentPath && (await fileExists(nextPath))) {
        return context.badRequest("Prompt with that name already exists.");
      }
      await fs.writeFile(
        nextPath,
        serializePromptWithFrontmatter(params.description, params.argumentHint, params.content),
        "utf8",
      );
      if (nextPath !== params.currentPath) {
        await fs.rm(params.currentPath, { force: true });
      }
      const workspaceRoot = path.resolve(context.storage.workspacePromptsDir(params.workspaceId));
      return {
        name: params.name,
        path: nextPath,
        description: params.description,
        argumentHint: params.argumentHint,
        content: params.content,
        scope: isWithinRoot(workspaceRoot, path.resolve(nextPath)) ? "workspace" : "global",
      };
    } catch (error) {
      return context.mapPathValidationError(error);
    }
  }),
  prompts_delete: definePromptRpcMethod(parsePromptDeleteParams, async (context, params) => {
    try {
      await ensurePromptPathAllowed(context, params.workspaceId, params.promptPath);
      await fs.rm(params.promptPath, { force: true });
      return null;
    } catch (error) {
      return context.mapPathValidationError(error);
    }
  }),
  prompts_move: definePromptRpcMethod(parsePromptMoveParams, async (context, params) => {
    try {
      await ensurePromptPathAllowed(context, params.workspaceId, params.promptPath);
      const nextDir = promptDirectoryForScope(context, params.scope, params.workspaceId);
      await fs.mkdir(nextDir, { recursive: true });
      const nextPath = path.join(nextDir, path.basename(params.promptPath));
      if (path.resolve(nextPath) === path.resolve(params.promptPath)) {
        return context.badRequest("Prompt is already in that scope.");
      }
      await fs.rename(params.promptPath, nextPath);
      const parsed = parseFrontmatter(await fs.readFile(nextPath, "utf8"));
      return {
        name: path.basename(nextPath, ".md"),
        path: nextPath,
        description: parsed.description,
        argumentHint: parsed.argumentHint,
        content: parsed.body,
        scope: params.scope,
      };
    } catch (error) {
      return context.mapPathValidationError(error);
    }
  }),
} as const;

export function handlePromptRpc(
  context: PromptRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  return dispatchTypedRpc(PROMPT_RPC_HANDLERS, context, method, params);
}
