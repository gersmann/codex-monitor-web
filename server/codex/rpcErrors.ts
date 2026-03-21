import type { RpcErrorShape } from "../types.js";

type RpcBoundaryMessageRule = {
  status: 400 | 404;
  match: "exact" | "contains";
  patterns: readonly string[];
};

const RPC_BOUNDARY_MESSAGE_RULES: RpcBoundaryMessageRule[] = [
  {
    status: 404,
    match: "exact",
    patterns: [
      "workspace not found.",
      "thread not found.",
      "message not found.",
      "backlog item not found.",
      "source workspace not found.",
      "parent workspace not found.",
      "worktree parent not found.",
      "no active turn found.",
      "rolled back thread was not returned by app-server.",
    ],
  },
  {
    status: 404,
    match: "contains",
    patterns: ["not found"],
  },
  {
    status: 400,
    match: "exact",
    patterns: [
      "invalid scope.",
      "invalid workspace file path.",
      "prompt path is not within allowed directories.",
      "workspace path is not accessible.",
      "workspace path is not a directory.",
      "prompt already exists.",
      "prompt with that name already exists.",
      "prompt is already in that scope.",
      "not a worktree workspace.",
      "branch name is required.",
      "copies folder and copy name are required.",
      "both old and new branch names are required.",
      "no changes to apply.",
      "only user messages can be used as rollback targets.",
      "rollback target is invalid.",
      "timed out.",
      "agent name is required.",
      "unsupported file scope or kind.",
      "open_workspace_in only supports http(s) urls in the web companion.",
    ],
  },
  {
    status: 400,
    match: "contains",
    patterns: [
      "is required.",
      "path is required.",
      "command is required.",
      "terminalid is required.",
      "already points to",
      "already exists",
      "invalid",
      "missing",
      "not a ",
      "external",
      "config_file is external; edit that file directly to change developer_instructions",
      "config_file is not managed by codexmonitor",
      "does not define config_file",
      "timed out",
    ],
  },
];

function rpcError(status: number, message: string): RpcErrorShape {
  return { error: { status, message } };
}

function normalizedMessage(error: unknown) {
  return error instanceof Error ? error.message.trim().toLowerCase() : "";
}

function ruleMatches(message: string, rule: RpcBoundaryMessageRule) {
  return rule.patterns.some((pattern) =>
    rule.match === "exact" ? message === pattern : message.includes(pattern),
  );
}

export function isRpcErrorShape(value: unknown): value is RpcErrorShape {
  return Boolean(
    value &&
      typeof value === "object" &&
      "error" in value &&
      typeof (value as { error?: unknown }).error === "object",
  );
}

export function classifyRpcBoundaryError(
  error: unknown,
  fallbackMessage = "Internal server error.",
): RpcErrorShape {
  if (isRpcErrorShape(error)) {
    return error;
  }
  const message = normalizedMessage(error);
  if (!message) {
    return rpcError(500, fallbackMessage);
  }
  for (const rule of RPC_BOUNDARY_MESSAGE_RULES) {
    if (ruleMatches(message, rule)) {
      return rpcError(rule.status, error instanceof Error ? error.message : fallbackMessage);
    }
  }
  return rpcError(500, error instanceof Error ? error.message : fallbackMessage);
}
