import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveCodexHome,
  resolveDataDir,
  resolveGlobalPromptsDir,
  resolveSettingsPath,
  resolveThreadsPath,
  resolveWorkspacePromptsDir,
  resolveWorkspacesPath,
} from "./paths.js";

const originalDataDir = process.env.CODEX_MONITOR_DATA_DIR;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.CODEX_MONITOR_DATA_DIR;
  } else {
    process.env.CODEX_MONITOR_DATA_DIR = originalDataDir;
  }

  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
});

describe("paths helpers", () => {
  it("resolves CODEX_MONITOR_DATA_DIR when configured", () => {
    process.env.CODEX_MONITOR_DATA_DIR = "./tmp-data";

    expect(resolveDataDir()).toBe(path.resolve("./tmp-data"));
  });

  it("resolves CODEX_HOME when configured", () => {
    process.env.CODEX_HOME = "./tmp-codex-home";

    expect(resolveCodexHome()).toBe(path.resolve("./tmp-codex-home"));
  });

  it("builds storage and prompt paths from data root", () => {
    const dataDir = "/tmp/codex-monitor-data";

    expect(resolveSettingsPath(dataDir)).toBe("/tmp/codex-monitor-data/settings.json");
    expect(resolveWorkspacesPath(dataDir)).toBe("/tmp/codex-monitor-data/workspaces.json");
    expect(resolveThreadsPath(dataDir)).toBe("/tmp/codex-monitor-data/threads.json");
    expect(resolveWorkspacePromptsDir(dataDir, "ws-42")).toBe(
      "/tmp/codex-monitor-data/workspaces/ws-42/prompts",
    );
    expect(resolveGlobalPromptsDir(dataDir)).toBe("/tmp/codex-monitor-data/prompts");
  });

  it("falls back to ~/.codex when CODEX_HOME is unset", () => {
    delete process.env.CODEX_HOME;

    expect(resolveCodexHome()).toBe(path.join(os.homedir(), ".codex"));
  });
});
