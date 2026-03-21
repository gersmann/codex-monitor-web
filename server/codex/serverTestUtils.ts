import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { vi } from "vitest";
import { CodexCompanionServer } from "../codex.js";
import { CompanionStorage } from "../storage.js";
import type { StoredThread, StoredWorkspace } from "../types.js";
import type { TerminalRuntime } from "../terminal.js";

const tempDirs: string[] = [];

export function trackTempDir(dir: string) {
  tempDirs.push(dir);
  return dir;
}

export async function createServerFixture(
  broadcast: (message: { event: string; payload: Record<string, unknown> }) => void = () => {},
  terminalRuntime?: TerminalRuntime | null,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-server-"));
  trackTempDir(dir);
  const storage = new CompanionStorage(dir);
  const workspacePath = path.join(dir, "workspace");
  const workspace: StoredWorkspace = {
    id: "ws-1",
    name: "Workspace",
    path: workspacePath,
    settings: {
      sidebarCollapsed: false,
    },
  };
  const thread: StoredThread = {
    id: "thread-1",
    workspaceId: "ws-1",
    sdkThreadId: "sdk-thread-1",
    cwd: workspacePath,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null,
    name: null,
    preview: "Thread One",
    activeTurnId: null,
    turns: [],
    modelId: null,
    effort: null,
    backlog: [],
    tokenUsage: null,
  };
  await storage.writeWorkspaces([workspace]);
  await storage.writeThreads([thread]);
  const server = new CodexCompanionServer(storage, broadcast, undefined, terminalRuntime);
  await server.initialize();
  return { dir, storage, server, workspace, thread };
}

export async function runGit(cwd: string, args: string[]) {
  return await new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve();
    });
  });
}

export async function readGitStdout(cwd: string, args: string[]) {
  return await new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`.trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function installFakeGh(dir: string, scriptBody: string) {
  const binDir = path.join(dir, "bin");
  await fs.mkdir(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "gh");
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env node
${scriptBody}
`,
    "utf8",
  );
  await fs.chmod(scriptPath, 0o755);
  vi.stubEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
}

export async function cleanupServerTestFixtures() {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}
