import os from "node:os";
import path from "node:path";

function defaultDataRoot() {
  if (process.env.CODEX_MONITOR_DATA_DIR) {
    return path.resolve(process.env.CODEX_MONITOR_DATA_DIR);
  }

  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "codex-monitor");
    case "win32":
      return path.join(
        process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
        "codex-monitor",
      );
    default:
      return path.join(
        process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
        "codex-monitor",
      );
  }
}

export function resolveDataDir() {
  return defaultDataRoot();
}

export function resolveCodexHome() {
  if (process.env.CODEX_HOME) {
    return path.resolve(process.env.CODEX_HOME);
  }
  return path.join(os.homedir(), ".codex");
}

export function resolveSettingsPath(dataDir: string) {
  return path.join(dataDir, "settings.json");
}

export function resolveWorkspacesPath(dataDir: string) {
  return path.join(dataDir, "workspaces.json");
}

export function resolveThreadsPath(dataDir: string) {
  return path.join(dataDir, "threads.json");
}

export function resolveWorkspacePromptsDir(dataDir: string, workspaceId: string) {
  return path.join(dataDir, "workspaces", workspaceId, "prompts");
}

export function resolveGlobalPromptsDir(dataDir: string) {
  return path.join(dataDir, "prompts");
}
