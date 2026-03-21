import { beforeEach, describe, expect, it, vi } from "vitest";

const agentConfigMocks = vi.hoisted(() => ({
  getAgentsSettings: vi.fn(),
  setAgentsCoreSettings: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
  readAgentConfigToml: vi.fn(),
  writeAgentConfigToml: vi.fn(),
}));

const rpcErrorMocks = vi.hoisted(() => ({
  classifyRpcBoundaryError: vi.fn((error: unknown) => ({
    error: {
      status: 500,
      message: error instanceof Error ? error.message : String(error),
    },
  })),
}));

vi.mock("./agentsConfig.js", () => agentConfigMocks);
vi.mock("./rpcErrors.js", () => rpcErrorMocks);

import { handleAgentsRpc, type AgentsRpcContext } from "./codexAgentsRpc.js";

function createContext(overrides: Partial<AgentsRpcContext> = {}): AgentsRpcContext {
  return {
    codexHome: "/tmp/codex-home",
    badRequest: (message) => ({ error: { status: 400, message } }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("codexAgentsRpc", () => {
  it("returns settings through the direct wrapper", async () => {
    agentConfigMocks.getAgentsSettings.mockResolvedValue({ configPath: "/tmp/codex-home/config.toml" });

    await expect(
      handleAgentsRpc(createContext(), "get_agents_settings", {}),
    ).resolves.toEqual({
      configPath: "/tmp/codex-home/config.toml",
    });
    expect(agentConfigMocks.getAgentsSettings).toHaveBeenCalledWith("/tmp/codex-home");
  });

  it("normalizes create_agent input before delegation", async () => {
    agentConfigMocks.createAgent.mockResolvedValue({ ok: true });

    await expect(
      handleAgentsRpc(createContext(), "create_agent", {
        input: {
          name: "  Alpha  ",
          description: "  ",
          developerInstructions: "  instructions  ",
          template: null,
          model: "  gpt-5  ",
          reasoningEffort: "",
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(agentConfigMocks.createAgent).toHaveBeenCalledWith("/tmp/codex-home", {
      name: "Alpha",
      description: null,
      developerInstructions: "instructions",
      template: null,
      model: "gpt-5",
      reasoningEffort: null,
    });
  });

  it("uses defaults for set_agents_core_settings input", async () => {
    agentConfigMocks.setAgentsCoreSettings.mockResolvedValue({ ok: true });

    await expect(
      handleAgentsRpc(createContext(), "set_agents_core_settings", {
        input: {
          multiAgentEnabled: true,
          maxThreads: 10,
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(agentConfigMocks.setAgentsCoreSettings).toHaveBeenCalledWith("/tmp/codex-home", {
      multiAgentEnabled: true,
      maxThreads: 10,
      maxDepth: 1,
    });
  });

  it("rejects missing agent config names before delegation", async () => {
    await expect(
      handleAgentsRpc(createContext(), "read_agent_config_toml", { agentName: "   " }),
    ).resolves.toEqual({
      error: {
        status: 400,
        message: "Agent name is required.",
      },
    });
    expect(agentConfigMocks.readAgentConfigToml).not.toHaveBeenCalled();
  });

  it("classifies thrown dependency failures at the boundary", async () => {
    agentConfigMocks.deleteAgent.mockRejectedValue(new Error("database offline"));

    await expect(
      handleAgentsRpc(createContext(), "delete_agent", {
        input: { name: "Alpha", deleteManagedFile: true },
      }),
    ).resolves.toEqual({
      error: {
        status: 500,
        message: "database offline",
      },
    });
    expect(rpcErrorMocks.classifyRpcBoundaryError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("writes agent configs and returns null on success", async () => {
    agentConfigMocks.writeAgentConfigToml.mockResolvedValue(undefined);

    await expect(
      handleAgentsRpc(createContext(), "write_agent_config_toml", {
        agentName: "Alpha",
        content: "content",
      }),
    ).resolves.toBeNull();
    expect(agentConfigMocks.writeAgentConfigToml).toHaveBeenCalledWith(
      "/tmp/codex-home",
      "Alpha",
      "content",
    );
  });

  it("returns undefined for unknown methods", async () => {
    await expect(handleAgentsRpc(createContext(), "unknown_method", {})).resolves.toBeUndefined();
  });
});
