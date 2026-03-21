import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { JsonRecord, RpcErrorShape, StoredWorkspace } from "../types.js";

type FileRpcContext = {
  storage: {
    globalAgentsPath: () => string;
    globalConfigPath: () => string;
    readTextFile: (filePath: string) => Promise<{ content: string; truncated: boolean }>;
    writeTextFile: (filePath: string, content: string) => Promise<void>;
    workspaceAgentsPath: (workspacePath: string) => string;
    workspaceConfigPath: (workspacePath: string) => string;
  };
  getWorkspace: (workspaceId: string) => StoredWorkspace | null;
  notFound: (message: string) => RpcErrorShape;
  badRequest: (message: string) => RpcErrorShape;
};

type RpcResult = unknown | RpcErrorShape | undefined;

function isWithinWorkspace(rootPath: string, candidatePath: string) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeGitPathForUi(filePath: string) {
  return filePath.replace(/\\/g, "/");
}

const WORKSPACE_FILE_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  "release-artifacts",
]);

function shouldSkipWorkspaceDirName(name: string) {
  return WORKSPACE_FILE_SKIP_DIRS.has(name);
}

function shouldSkipWorkspaceRelativePath(relativePath: string) {
  return normalizeGitPathForUi(relativePath)
    .split("/")
    .some((segment) => shouldSkipWorkspaceDirName(segment));
}

function getWorkspaceOrNotFound(context: FileRpcContext, workspaceId: string) {
  const workspace = context.getWorkspace(workspaceId);
  if (!workspace) {
    return context.notFound("Workspace not found.");
  }
  return workspace;
}

async function listWorkspaceFilesFromGit(root: string) {
  const listed = await new Promise<{ stdout: string } | null>((resolve) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve({ stdout });
      },
    );
  });
  if (!listed) {
    return null;
  }
  const files = Array.from(
    new Set(
      listed.stdout
        .split("\0")
        .map((entry) => normalizeGitPathForUi(entry.trim()))
        .filter((entry) => entry.length > 0 && !shouldSkipWorkspaceRelativePath(entry)),
    ),
  );
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function listWorkspaceFilesRecursive(root: string, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (shouldSkipWorkspaceDirName(entry.name)) {
      continue;
    }
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listWorkspaceFilesRecursive(root, absolute)));
      continue;
    }
    if (entry.isFile()) {
      const relative = normalizeGitPathForUi(path.relative(root, absolute));
      if (!shouldSkipWorkspaceRelativePath(relative)) {
        files.push(relative);
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function listWorkspaceFiles(root: string) {
  const gitFiles = await listWorkspaceFilesFromGit(root);
  if (gitFiles) {
    return gitFiles;
  }
  return listWorkspaceFilesRecursive(root);
}

async function readWorkspaceFileContents(workspacePath: string, relativePath: string) {
  const workspaceRoot = path.resolve(workspacePath);
  const absolute = path.resolve(workspaceRoot, relativePath);
  if (!isWithinWorkspace(workspaceRoot, absolute)) {
    throw new Error("Invalid workspace file path.");
  }
  const content = await fs.readFile(absolute, "utf8");
  return {
    content,
    truncated: false,
  };
}

async function readImageAsDataUrl(workspacePath: string, imagePath: string) {
  const candidatePath = imagePath.trim();
  if (!candidatePath) {
    throw new Error("Image path is required.");
  }
  const workspaceRoot = path.resolve(workspacePath);
  const resolvedPath = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(workspaceRoot, candidatePath);
  if (!isWithinWorkspace(workspaceRoot, resolvedPath)) {
    throw new Error("Invalid workspace file path.");
  }
  const buffer = await fs.readFile(resolvedPath);
  const extension = path.extname(resolvedPath).slice(1).toLowerCase();
  const subtype = extension === "jpg" ? "jpeg" : extension || "png";
  return `data:image/${subtype};base64,${buffer.toString("base64")}`;
}

function resolveScopedFilePath(
  context: FileRpcContext,
  scope: string,
  kind: string,
  workspaceId: string,
) {
  if (scope === "global" && kind === "agents") {
    return context.storage.globalAgentsPath();
  }
  if (scope === "global" && kind === "config") {
    return context.storage.globalConfigPath();
  }
  if (scope === "workspace") {
    const workspace = context.getWorkspace(workspaceId);
    if (!workspace) {
      return context.notFound("Workspace not found.");
    }
    if (kind === "agents") {
      return context.storage.workspaceAgentsPath(workspace.path);
    }
    if (kind === "config") {
      return context.storage.workspaceConfigPath(workspace.path);
    }
  }
  return context.notFound("Unsupported file scope or kind.");
}

const WORKSPACE_FILE_RPC_HANDLERS = {
  read_image_as_data_url: async (context: FileRpcContext, params: JsonRecord): Promise<RpcResult> => {
    const workspace = getWorkspaceOrNotFound(context, String(params.workspaceId ?? ""));
    if ("error" in workspace) {
      return workspace;
    }
    try {
      return await readImageAsDataUrl(workspace.path, String(params.path ?? ""));
    } catch (error) {
      return context.badRequest(error instanceof Error ? error.message : String(error));
    }
  },
  list_workspace_files: async (context: FileRpcContext, params: JsonRecord): Promise<RpcResult> => {
    const workspace = getWorkspaceOrNotFound(context, String(params.workspaceId ?? ""));
    if ("error" in workspace) {
      return workspace;
    }
    return await listWorkspaceFiles(workspace.path);
  },
  read_workspace_file: async (context: FileRpcContext, params: JsonRecord): Promise<RpcResult> => {
    const workspace = getWorkspaceOrNotFound(context, String(params.workspaceId ?? ""));
    if ("error" in workspace) {
      return workspace;
    }
    try {
      return await readWorkspaceFileContents(workspace.path, String(params.path ?? ""));
    } catch (error) {
      return context.badRequest(error instanceof Error ? error.message : String(error));
    }
  },
} as const;

export async function handleWorkspaceFileRpc(
  context: FileRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  const handler = WORKSPACE_FILE_RPC_HANDLERS[
    method as keyof typeof WORKSPACE_FILE_RPC_HANDLERS
  ];
  if (!handler) {
    return undefined;
  }
  return await handler(context, params);
}

const SCOPED_FILE_RPC_HANDLERS = {
  file_read: async (context: FileRpcContext, params: JsonRecord): Promise<RpcResult> => {
    const scope = String(params.scope ?? "");
    const kind = String(params.kind ?? "");
    const workspaceId = String(params.workspaceId ?? "");
    const filePath = resolveScopedFilePath(context, scope, kind, workspaceId);
    if (filePath && typeof filePath === "object" && "error" in filePath) {
      return filePath;
    }
    return await context.storage.readTextFile(filePath);
  },
  file_write: async (context: FileRpcContext, params: JsonRecord): Promise<RpcResult> => {
    const scope = String(params.scope ?? "");
    const kind = String(params.kind ?? "");
    const workspaceId = String(params.workspaceId ?? "");
    const content = String(params.content ?? "");
    const filePath = resolveScopedFilePath(context, scope, kind, workspaceId);
    if (filePath && typeof filePath === "object" && "error" in filePath) {
      return filePath;
    }
    await context.storage.writeTextFile(filePath, content);
    return null;
  },
} as const;

export async function handleScopedFileRpc(
  context: FileRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  const handler = SCOPED_FILE_RPC_HANDLERS[method as keyof typeof SCOPED_FILE_RPC_HANDLERS];
  if (!handler) {
    return undefined;
  }
  return await handler(context, params);
}
