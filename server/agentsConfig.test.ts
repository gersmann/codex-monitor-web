import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgent,
  deleteAgent,
  getAgentsSettings,
  readAgentConfigToml,
  setAgentsCoreSettings,
  updateAgent,
  writeAgentConfigToml,
} from "./agentsConfig.js";

const tempDirs: string[] = [];

async function createCodexHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-agents-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("agentsConfig", () => {
  it("reads agent settings from CODEX_HOME/config.toml", async () => {
    const codexHome = await createCodexHome();
    await fs.mkdir(path.join(codexHome, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      [
        "[features]",
        "multi_agent = true",
        "",
        "[agents]",
        "max_threads = 8",
        "max_depth = 2",
        "",
        "[agents.researcher]",
        'description = "Research-focused role"',
        'config_file = "agents/researcher.toml"',
        "",
        "[agents.external]",
        'description = "External role"',
        'config_file = "/tmp/external-agent.toml"',
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(codexHome, "agents", "researcher.toml"),
      'model = "gpt-5-codex"\ndeveloper_instructions = "Investigate first."\n',
      "utf8",
    );

    const settings = await getAgentsSettings(codexHome);

    expect(settings).toMatchObject({
      configPath: path.join(codexHome, "config.toml"),
      multiAgentEnabled: true,
      maxThreads: 8,
      maxDepth: 2,
    });
    expect(settings.agents).toEqual([
      {
        name: "external",
        description: "External role",
        developerInstructions: null,
        configFile: "/tmp/external-agent.toml",
        resolvedPath: "/tmp/external-agent.toml",
        managedByApp: false,
        fileExists: false,
      },
      {
        name: "researcher",
        description: "Research-focused role",
        developerInstructions: "Investigate first.",
        configFile: "agents/researcher.toml",
        resolvedPath: path.join(codexHome, "agents", "researcher.toml"),
        managedByApp: true,
        fileExists: true,
      },
    ]);
  });

  it("writes multi-agent core settings into config.toml", async () => {
    const codexHome = await createCodexHome();

    const settings = await setAgentsCoreSettings(codexHome, {
      multiAgentEnabled: true,
      maxThreads: 10,
      maxDepth: 3,
    });

    expect(settings).toMatchObject({
      multiAgentEnabled: true,
      maxThreads: 10,
      maxDepth: 3,
    });
    const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(config).toContain("[features]");
    expect(config).toContain("multi_agent = true");
    expect(config).toContain("[agents]");
    expect(config).toContain("max_threads = 10");
    expect(config).toContain("max_depth = 3");
  });

  it("creates, updates, reads, writes, and deletes managed agents via config.toml", async () => {
    const codexHome = await createCodexHome();
    await setAgentsCoreSettings(codexHome, {
      multiAgentEnabled: false,
      maxThreads: 6,
      maxDepth: 1,
    });

    const created = await createAgent(codexHome, {
      name: "Researcher",
      description: "Research-focused role",
      developerInstructions: "Investigate first.",
      model: "gpt-5-codex",
      reasoningEffort: "high",
    });

    expect(created.agents).toHaveLength(1);
    expect(created.agents[0]).toMatchObject({
      name: "researcher",
      configFile: "agents/researcher.toml",
      managedByApp: true,
    });
    const createdConfigPath = path.join(codexHome, "agents", "researcher.toml");
    await expect(fs.readFile(createdConfigPath, "utf8")).resolves.toContain(
      'developer_instructions = "Investigate first."',
    );

    const updated = await updateAgent(codexHome, {
      originalName: "researcher",
      name: "researcher-v2",
      description: "Updated role",
      developerInstructions: "Prefer deterministic fixes.",
      renameManagedFile: true,
    });

    expect(updated.agents[0]).toMatchObject({
      name: "researcher-v2",
      description: "Updated role",
      configFile: "agents/researcher-v2.toml",
      developerInstructions: "Prefer deterministic fixes.",
    });
    await expect(fs.stat(path.join(codexHome, "agents", "researcher.toml"))).rejects.toThrow();
    await expect(
      fs.readFile(path.join(codexHome, "agents", "researcher-v2.toml"), "utf8"),
    ).resolves.toContain('developer_instructions = "Prefer deterministic fixes."');

    expect(await readAgentConfigToml(codexHome, "researcher-v2")).toContain(
      'developer_instructions = "Prefer deterministic fixes."',
    );
    await writeAgentConfigToml(
      codexHome,
      "researcher-v2",
      'model = "gpt-5-codex"\ndeveloper_instructions = "Edited manually."\n',
    );
    expect(await readAgentConfigToml(codexHome, "researcher-v2")).toContain(
      'developer_instructions = "Edited manually."',
    );

    const deleted = await deleteAgent(codexHome, {
      name: "researcher-v2",
      deleteManagedFile: true,
    });

    expect(deleted.agents).toEqual([]);
    await expect(fs.stat(path.join(codexHome, "agents", "researcher-v2.toml"))).rejects.toThrow();
  });

  it("rejects managed config editing for external agent config files", async () => {
    const codexHome = await createCodexHome();
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      [
        "[agents.external]",
        'description = "External role"',
        'config_file = "/tmp/external-agent.toml"',
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(readAgentConfigToml(codexHome, "external")).rejects.toThrow(
      "config_file is not managed by CodexMonitor",
    );
    await expect(
      updateAgent(codexHome, {
        originalName: "external",
        name: "external",
        description: "External role",
        developerInstructions: "Do not change",
      }),
    ).rejects.toThrow("config_file is external");
  });
});
