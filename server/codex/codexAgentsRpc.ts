import {
  createAgent as createManagedAgent,
  deleteAgent as deleteManagedAgent,
  getAgentsSettings,
  readAgentConfigToml,
  setAgentsCoreSettings,
  updateAgent as updateManagedAgent,
  writeAgentConfigToml,
} from "./agentsConfig.js";
import { classifyRpcBoundaryError } from "./rpcErrors.js";
import type { JsonRecord, RpcErrorShape } from "../types.js";

export type AgentsRpcContext = {
  codexHome: string;
  badRequest: (message: string) => RpcErrorShape;
};

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toNullableString(value: unknown) {
  const trimmed = trimString(value);
  return trimmed.length > 0 ? trimmed : null;
}

type AgentsRpcHandler = (
  context: AgentsRpcContext,
  params: JsonRecord,
) => unknown | RpcErrorShape | undefined | Promise<unknown | RpcErrorShape | undefined>;

function readInputRecord(params: JsonRecord) {
  return params.input && typeof params.input === "object"
    ? (params.input as JsonRecord)
    : {};
}

function handleAgentOperation<T>(
  operation: () => Promise<T>,
): Promise<T | RpcErrorShape> {
  return Promise.resolve()
    .then(operation)
    .catch((error) => classifyRpcBoundaryError(error));
}

const AGENT_RPC_HANDLERS: Record<string, AgentsRpcHandler> = {
  get_agents_settings: (context) => handleAgentOperation(() => getAgentsSettings(context.codexHome)),
  set_agents_core_settings: (context, params) => {
    const input = readInputRecord(params);
    return handleAgentOperation(() =>
      setAgentsCoreSettings(context.codexHome, {
        multiAgentEnabled: Boolean(input.multiAgentEnabled),
        maxThreads: typeof input.maxThreads === "number" ? input.maxThreads : 6,
        maxDepth: typeof input.maxDepth === "number" ? input.maxDepth : 1,
      }),
    );
  },
  create_agent: (context, params) => {
    const input = readInputRecord(params);
    return handleAgentOperation(() =>
      createManagedAgent(context.codexHome, {
        name: trimString(input.name),
        description: toNullableString(input.description),
        developerInstructions: toNullableString(input.developerInstructions),
        template: toNullableString(input.template),
        model: toNullableString(input.model),
        reasoningEffort: toNullableString(input.reasoningEffort),
      }),
    );
  },
  update_agent: (context, params) => {
    const input = readInputRecord(params);
    return handleAgentOperation(() =>
      updateManagedAgent(context.codexHome, {
        originalName: trimString(input.originalName),
        name: trimString(input.name),
        description: toNullableString(input.description),
        developerInstructions:
          input.developerInstructions === undefined
            ? undefined
            : toNullableString(input.developerInstructions),
        renameManagedFile:
          typeof input.renameManagedFile === "boolean"
            ? input.renameManagedFile
            : true,
      }),
    );
  },
  delete_agent: (context, params) => {
    const input = readInputRecord(params);
    return handleAgentOperation(() =>
      deleteManagedAgent(context.codexHome, {
        name: trimString(input.name),
        deleteManagedFile: Boolean(input.deleteManagedFile),
      }),
    );
  },
  read_agent_config_toml: (context, params) => {
    const agentName = trimString(params.agentName);
    if (!agentName) {
      return context.badRequest("Agent name is required.");
    }
    return handleAgentOperation(() => readAgentConfigToml(context.codexHome, agentName));
  },
  write_agent_config_toml: (context, params) => {
    const agentName = trimString(params.agentName);
    const content = String(params.content ?? "");
    return handleAgentOperation(() => writeAgentConfigToml(context.codexHome, agentName, content).then(() => null));
  },
};

export function handleAgentsRpc(
  context: AgentsRpcContext,
  method: string,
  params: JsonRecord,
): Promise<unknown | RpcErrorShape | undefined> {
  const handler = AGENT_RPC_HANDLERS[method];
  return handler
    ? Promise.resolve(handler(context, params))
    : Promise.resolve(undefined);
}
