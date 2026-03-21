import { unsupportedRpcMessage } from "../parity.js";
import {
  defineRpcMethod,
  dispatchTypedRpc,
  isRpcError,
} from "./rpcHandlerRegistry.js";
import { classifyRpcBoundaryError } from "./rpcErrors.js";
import type { JsonRecord, RpcErrorShape, StoredWorkspace } from "../types.js";

type TerminalRuntimeLike = {
  openSession: (options: {
    workspaceId: string;
    terminalId: string;
    cwd: string;
    cols: number;
    rows: number;
    restoreOnly: boolean;
  }) => Promise<unknown>;
  writeSession: (workspaceId: string, terminalId: string, data: string) => Promise<void>;
  resizeSession: (workspaceId: string, terminalId: string, cols: number, rows: number) => Promise<void>;
  closeSession: (workspaceId: string, terminalId: string) => Promise<void>;
};

export type RuntimeRpcContext = {
  terminalRuntime: TerminalRuntimeLike | null;
  getWorkspace: (workspaceId: string) => StoredWorkspace | null;
  getLocalUsageSnapshot: (days: number | null, workspacePath: string | null) => Promise<unknown>;
  runCodexDoctor: (codexBin: string | null, codexArgs: string | null) => Promise<unknown>;
  badRequest: (message: string) => RpcErrorShape;
  notFound: (message: string) => RpcErrorShape;
};

type ResolvedTerminalTarget = {
  runtime: TerminalRuntimeLike;
  workspace: StoredWorkspace;
  terminalId: string;
};
type TerminalTargetParams = {
  target: ResolvedTerminalTarget;
};
type TerminalOpenParams = TerminalTargetParams & {
  cols: number;
  rows: number;
  restoreOnly: boolean;
};
type TerminalWriteParams = TerminalTargetParams & {
  data: string;
};
type TerminalResizeParams = TerminalTargetParams & {
  cols: number;
  rows: number;
};
type LocalUsageSnapshotParams = {
  days: number | null;
  workspacePath: string | null;
};
type CodexDoctorParams = {
  codexBin: string | null;
  codexArgs: string | null;
};

const UNSUPPORTED_RUNTIME_METHODS = new Set([
  "menu_set_accelerators",
  "set_tray_recent_threads",
  "set_tray_session_usage",
  "tailscale_status",
  "tailscale_daemon_command_preview",
  "tailscale_daemon_start",
  "tailscale_daemon_stop",
  "tailscale_daemon_status",
  "dictation_model_status",
  "dictation_download_model",
  "dictation_cancel_download",
  "dictation_remove_model",
  "dictation_start",
  "dictation_request_permission",
  "dictation_stop",
  "dictation_cancel",
  "write_text_file",
]);
const CODEX_UPDATE_RESPONSE = {
  ok: false,
  method: "unknown",
  package: null,
  beforeVersion: null,
  afterVersion: null,
  upgraded: false,
  output: null,
  details: "Codex update is not implemented in the web companion.",
};

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toNullableString(value: unknown) {
  const trimmed = trimString(value);
  return trimmed.length > 0 ? trimmed : null;
}

function resolveTerminalTarget(
  context: RuntimeRpcContext,
  method: string,
  params: JsonRecord,
): ResolvedTerminalTarget | RpcErrorShape {
  if (!context.terminalRuntime) {
    return context.badRequest(unsupportedRpcMessage(method));
  }
  const workspace = context.getWorkspace(String(params.workspaceId ?? ""));
  if (!workspace) {
    return context.notFound("Workspace not found.");
  }
  const terminalId = trimString(params.terminalId);
  if (!terminalId) {
    return context.badRequest("terminalId is required.");
  }
  return {
    runtime: context.terminalRuntime,
    workspace,
    terminalId,
  };
}

function parseTerminalOpenParams(
  context: RuntimeRpcContext,
  params: JsonRecord,
): TerminalOpenParams | RpcErrorShape {
  const target = resolveTerminalTarget(context, "terminal_open", params);
  if (isRpcError(target)) {
    return target;
  }
  return {
    target,
    cols: Number(params.cols ?? 120),
    rows: Number(params.rows ?? 40),
    restoreOnly: params.restoreOnly === true,
  };
}

function parseTerminalWriteParams(
  context: RuntimeRpcContext,
  params: JsonRecord,
): TerminalWriteParams | RpcErrorShape {
  const target = resolveTerminalTarget(context, "terminal_write", params);
  if (isRpcError(target)) {
    return target;
  }
  return {
    target,
    data: String(params.data ?? ""),
  };
}

function parseTerminalResizeParams(
  context: RuntimeRpcContext,
  params: JsonRecord,
): TerminalResizeParams | RpcErrorShape {
  const target = resolveTerminalTarget(context, "terminal_resize", params);
  if (isRpcError(target)) {
    return target;
  }
  return {
    target,
    cols: Number(params.cols ?? 120),
    rows: Number(params.rows ?? 40),
  };
}

function parseTerminalCloseParams(
  context: RuntimeRpcContext,
  params: JsonRecord,
): TerminalTargetParams | RpcErrorShape {
  const target = resolveTerminalTarget(context, "terminal_close", params);
  if (isRpcError(target)) {
    return target;
  }
  return { target };
}

function parseLocalUsageSnapshotParams(
  _context: RuntimeRpcContext,
  params: JsonRecord,
): LocalUsageSnapshotParams {
  return {
    days: typeof params.days === "number" ? params.days : null,
    workspacePath: toNullableString(params.workspacePath),
  };
}

function parseCodexDoctorParams(
  _context: RuntimeRpcContext,
  params: JsonRecord,
): CodexDoctorParams {
  return {
    codexBin: toNullableString(params.codexBin),
    codexArgs: toNullableString(params.codexArgs),
  };
}

const COMPANION_RUNTIME_RPC_HANDLERS = {
  terminal_open: defineRpcMethod(parseTerminalOpenParams, (_context, { target, cols, rows, restoreOnly }) =>
    executeTerminalOperation(() =>
      target.runtime.openSession({
        workspaceId: target.workspace.id,
        terminalId: target.terminalId,
        cwd: target.workspace.path,
        cols,
        rows,
        restoreOnly,
      }),
    )),
  terminal_write: defineRpcMethod(parseTerminalWriteParams, (_context, { target, data }) =>
    executeTerminalOperation(() =>
      target.runtime.writeSession(target.workspace.id, target.terminalId, data).then(() => null),
    )),
  terminal_resize: defineRpcMethod(parseTerminalResizeParams, (_context, { target, cols, rows }) =>
    executeTerminalOperation(() =>
      target.runtime.resizeSession(target.workspace.id, target.terminalId, cols, rows).then(() => null),
    )),
  terminal_close: defineRpcMethod(parseTerminalCloseParams, (_context, { target }) =>
    executeTerminalOperation(() =>
      target.runtime.closeSession(target.workspace.id, target.terminalId).then(() => null),
    )),
  local_usage_snapshot: defineRpcMethod(
    parseLocalUsageSnapshotParams,
    (context, params) => context.getLocalUsageSnapshot(params.days, params.workspacePath),
  ),
  codex_doctor: defineRpcMethod(parseCodexDoctorParams, (context, params) =>
    context.runCodexDoctor(params.codexBin, params.codexArgs),
  ),
  codex_update: defineRpcMethod(() => undefined, () => CODEX_UPDATE_RESPONSE),
  app_build_type: defineRpcMethod(() => undefined, () => "release"),
  is_mobile_runtime: defineRpcMethod(() => undefined, () => false),
  is_macos_debug_build: defineRpcMethod(() => undefined, () => false),
  send_notification_fallback: defineRpcMethod(() => undefined, () => null),
};

function executeTerminalOperation<T>(
  operation: () => Promise<T>,
): Promise<T | RpcErrorShape> {
  return operation().catch((error) => classifyRpcBoundaryError(error));
}

export function handleCompanionRuntimeRpc(
  context: RuntimeRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  if (UNSUPPORTED_RUNTIME_METHODS.has(method)) {
    return Promise.resolve(context.badRequest(unsupportedRpcMessage(method)));
  }
  return dispatchTypedRpc(COMPANION_RUNTIME_RPC_HANDLERS, context, method, params);
}
