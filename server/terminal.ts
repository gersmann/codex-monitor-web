import process from "node:process";
import { spawn, type IPty } from "node-pty";

export type TerminalOutputPayload = {
  workspaceId: string;
  terminalId: string;
  data: string;
};

export type TerminalExitPayload = {
  workspaceId: string;
  terminalId: string;
};

export type TerminalBroadcastMessage =
  | {
      event: "terminal-output";
      payload: TerminalOutputPayload;
    }
  | {
      event: "terminal-exit";
      payload: TerminalExitPayload;
    };

export type TerminalRuntime = {
  openSession: (params: {
    workspaceId: string;
    terminalId: string;
    cwd: string;
    cols: number;
    rows: number;
    restoreOnly?: boolean;
  }) => Promise<{ id: string }>;
  writeSession: (workspaceId: string, terminalId: string, data: string) => Promise<void>;
  resizeSession: (
    workspaceId: string,
    terminalId: string,
    cols: number,
    rows: number,
  ) => Promise<void>;
  closeSession: (workspaceId: string, terminalId: string) => Promise<void>;
  closeAll: () => Promise<void>;
};

type TerminalSession = {
  key: string;
  workspaceId: string;
  terminalId: string;
  pty: IPty;
};

function terminalKey(workspaceId: string, terminalId: string) {
  return `${workspaceId}:${terminalId}`;
}

function normalizeDimension(value: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(2, Math.round(value));
}

function isWindows() {
  return process.platform === "win32";
}

function resolveShellPath() {
  if (isWindows()) {
    return process.env.COMSPEC?.trim() || "powershell.exe";
  }
  return process.env.SHELL?.trim() || "/bin/zsh";
}

function resolveShellArgs(shellPath: string) {
  if (isWindows()) {
    const normalized = shellPath.toLowerCase();
    if (
      normalized.includes("powershell") ||
      normalized.endsWith("pwsh.exe") ||
      normalized.endsWith("\\pwsh")
    ) {
      return ["-NoLogo", "-NoExit"];
    }
    if (normalized.endsWith("cmd.exe") || normalized.endsWith("\\cmd")) {
      return ["/K"];
    }
    return [];
  }
  return ["-i"];
}

function resolveLocale() {
  const candidate =
    process.env.LC_ALL?.trim() || process.env.LANG?.trim() || "en_US.UTF-8";
  const normalized = candidate.toLowerCase();
  if (normalized.includes("utf-8") || normalized.includes("utf8")) {
    return candidate;
  }
  return "en_US.UTF-8";
}

function buildTerminalEnv() {
  const locale = resolveLocale();
  return {
    ...process.env,
    TERM: "xterm-256color",
    LANG: locale,
    LC_ALL: locale,
    LC_CTYPE: locale,
  };
}

export function isTerminalFeatureEnabled() {
  return process.env.CODEX_MONITOR_ENABLE_TERMINAL?.trim() === "1";
}

export class NodePtyTerminalManager implements TerminalRuntime {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly broadcast: (message: TerminalBroadcastMessage) => void,
  ) {}

  async openSession(params: {
    workspaceId: string;
    terminalId: string;
    cwd: string;
    cols: number;
    rows: number;
    restoreOnly?: boolean;
  }) {
    const cols = normalizeDimension(params.cols, 120);
    const rows = normalizeDimension(params.rows, 40);
    const key = terminalKey(params.workspaceId, params.terminalId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.pty.resize(cols, rows);
      return { id: existing.terminalId };
    }
    if (params.restoreOnly) {
      throw new Error("Terminal session not found");
    }

    const shellPath = resolveShellPath();
    const pty = spawn(shellPath, resolveShellArgs(shellPath), {
      name: "xterm-256color",
      cols,
      rows,
      cwd: params.cwd,
      env: buildTerminalEnv(),
    });

    const session: TerminalSession = {
      key,
      workspaceId: params.workspaceId,
      terminalId: params.terminalId,
      pty,
    };
    this.sessions.set(key, session);

    pty.onData((data) => {
      this.broadcast({
        event: "terminal-output",
        payload: {
          workspaceId: params.workspaceId,
          terminalId: params.terminalId,
          data,
        },
      });
    });

    pty.onExit(() => {
      const current = this.sessions.get(key);
      if (current !== session) {
        return;
      }
      this.sessions.delete(key);
      this.broadcast({
        event: "terminal-exit",
        payload: {
          workspaceId: params.workspaceId,
          terminalId: params.terminalId,
        },
      });
    });

    return { id: session.terminalId };
  }

  async writeSession(workspaceId: string, terminalId: string, data: string) {
    const session = this.sessions.get(terminalKey(workspaceId, terminalId));
    if (!session) {
      throw new Error("Terminal session not found");
    }
    session.pty.write(data);
  }

  async resizeSession(workspaceId: string, terminalId: string, cols: number, rows: number) {
    const session = this.sessions.get(terminalKey(workspaceId, terminalId));
    if (!session) {
      throw new Error("Terminal session not found");
    }
    session.pty.resize(normalizeDimension(cols, 120), normalizeDimension(rows, 40));
  }

  async closeSession(workspaceId: string, terminalId: string) {
    const key = terminalKey(workspaceId, terminalId);
    const session = this.sessions.get(key);
    if (!session) {
      throw new Error("Terminal session not found");
    }
    this.sessions.delete(key);
    session.pty.kill();
  }

  async closeAll() {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    for (const session of sessions) {
      session.pty.kill();
    }
  }
}

export function createTerminalRuntime(
  broadcast: (message: TerminalBroadcastMessage) => void,
) {
  if (!isTerminalFeatureEnabled()) {
    return null;
  }
  return new NodePtyTerminalManager(broadcast);
}
