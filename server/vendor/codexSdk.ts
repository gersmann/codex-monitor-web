import process from "node:process";
import { spawn } from "node:child_process";

export type JsonRecord = Record<string, unknown>;

type AppServerEnvelope =
  | {
      id: number | string;
      result?: unknown;
      error?: { message?: string };
    }
  | {
      id?: number | string;
      method?: string;
      params?: unknown;
    };

export type AppServerNotificationMessage = {
  id?: number | string;
  method: string;
  params: JsonRecord;
};

type CodexAppServerClientOptions = {
  codexPath?: string | null;
  cliArgs?: string[];
  env?: NodeJS.ProcessEnv;
  initializeParams: JsonRecord;
  initTimeoutMs?: number;
  requestTimeoutMs?: number;
};

const DEFAULT_APP_SERVER_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;

export function buildAppServerEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  delete nextEnv.NODE_ENV;
  delete nextEnv.VITEST;
  return nextEnv;
}

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseEnvelope(line: string): AppServerEnvelope {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid app-server JSON envelope.");
  }
  return parsed as AppServerEnvelope;
}

export class CodexAppServerClient {
  private readonly codexPath: string;
  private readonly cliArgs: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly initializeParams: JsonRecord;
  private readonly initTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private child: ReturnType<typeof spawn> | null = null;
  private startPromise: Promise<void> | null = null;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private readonly listeners = new Set<(message: AppServerNotificationMessage) => void>();
  private readonly pending = new Map<
    number | string,
    {
      method: string;
      resolve: (value: JsonRecord) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private recentStderr = "";

  constructor(options: CodexAppServerClientOptions) {
    this.codexPath = trimString(options.codexPath) || "codex";
    this.cliArgs = Array.isArray(options.cliArgs)
      ? options.cliArgs.filter((value) => typeof value === "string" && value.trim().length > 0)
      : [];
    this.env = buildAppServerEnv(options.env ?? process.env);
    this.initializeParams = options.initializeParams;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_APP_SERVER_INIT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS;
  }

  private send(message: JsonRecord) {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error("codex app-server is not connected.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAllPending(message: string) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private resetProcess(message: string) {
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = "";
    this.startPromise = null;
    if (child && !child.killed) {
      child.kill();
    }
    this.rejectAllPending(message);
  }

  private handleEnvelope(message: AppServerEnvelope) {
    if ("method" in message && typeof message.method === "string") {
      const params =
        message.params && typeof message.params === "object" && !Array.isArray(message.params)
          ? (message.params as JsonRecord)
          : {};
      for (const listener of this.listeners) {
        listener({
          id: typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined,
          method: message.method,
          params,
        });
      }
      return;
    }

    if (
      "id" in message &&
      (typeof message.id === "number" || typeof message.id === "string") &&
      !("method" in message)
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message && message.error && typeof message.error === "object") {
        pending.reject(
          new Error(
            `codex app-server ${pending.method} failed: ${
              trimString(message.error.message) || "unknown error"
            }`,
          ),
        );
        return;
      }
      pending.resolve((("result" in message ? message.result : {}) ?? {}) as JsonRecord);
    }
  }

  private attachProcess(child: ReturnType<typeof spawn>) {
    if (!child.stdin || !child.stdout || !child.stderr) {
      this.resetProcess("codex app-server stdio is not available.");
      return;
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.recentStderr += chunk;
      if (this.recentStderr.length > 8_192) {
        this.recentStderr = this.recentStderr.slice(-8_192);
      }
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk;
      let newlineIndex = this.stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            this.handleEnvelope(parseEnvelope(line));
          } catch (error) {
            this.resetProcess(
              `Invalid JSON from codex app-server: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return;
          }
        }
        newlineIndex = this.stdoutBuffer.indexOf("\n");
      }
    });

    child.once("error", (error) => {
      this.resetProcess(`Failed to start codex app-server: ${error.message}`);
    });

    child.once("exit", (code, signal) => {
      this.resetProcess(
        `codex app-server exited unexpectedly${
          code !== null ? ` with code ${code}` : ""
        }${signal ? ` (${signal})` : ""}${
          this.recentStderr.trim() ? `: ${this.recentStderr.trim()}` : ""
        }`,
      );
    });
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) {
      return;
    }
    if (this.startPromise) {
      return await this.startPromise;
    }

    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.codexPath, [...this.cliArgs, "app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env,
      });
      if (!child.stdin || !child.stdout || !child.stderr) {
        reject(new Error("codex app-server stdio is not available."));
        return;
      }
      this.child = child;
      this.attachProcess(child);

      const initializeId = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.resetProcess(
          `initialize timed out while talking to codex app-server${
            this.recentStderr.trim() ? `: ${this.recentStderr.trim()}` : ""
          }`,
        );
        reject(
          new Error(
            `initialize timed out while talking to codex app-server${
              this.recentStderr.trim() ? `: ${this.recentStderr.trim()}` : ""
            }`,
          ),
        );
      }, this.initTimeoutMs);
      timer.unref?.();

      this.pending.set(initializeId, {
        method: "initialize",
        resolve: () => {
          clearTimeout(timer);
          try {
            this.send({ method: "initialized", params: {} });
            resolve();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          } finally {
            this.startPromise = null;
          }
        },
        reject: (error) => {
          clearTimeout(timer);
          this.startPromise = null;
          reject(error);
        },
        timer,
      });

      try {
        this.send({
          id: initializeId,
          method: "initialize",
          params: this.initializeParams,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(initializeId);
        this.startPromise = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return await this.startPromise;
  }

  onNotification(listener: (message: AppServerNotificationMessage) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close() {
    if (!this.child) {
      return;
    }
    const child = this.child;
    this.child = null;
    this.stdoutBuffer = "";
    this.startPromise = null;
    this.rejectAllPending("codex app-server closed");
    child.kill();
  }

  async request(method: string, params: JsonRecord) {
    await this.ensureStarted();
    return await new Promise<JsonRecord>((resolve, reject) => {
      const requestId = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            `${method} timed out while talking to codex app-server${
              this.recentStderr.trim() ? `: ${this.recentStderr.trim()}` : ""
            }`,
          ),
        );
      }, this.requestTimeoutMs);
      timer.unref?.();

      this.pending.set(requestId, {
        method,
        resolve,
        reject,
        timer,
      });

      try {
        this.send({ id: requestId, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async sendResponse(id: number | string, result: unknown) {
    await this.ensureStarted();
    this.send({
      id,
      result,
    });
  }

  async startThread(params: {
    cwd: string;
    approvalPolicy: "on-request" | "never";
  }) {
    return await this.request("thread/start", params);
  }

  async listThreads(params: {
    cursor: string | null;
    limit: number | null;
    sortKey: "created_at" | "updated_at";
    sourceKinds: string[];
  }) {
    return await this.request("thread/list", params);
  }

  async readThread(threadId: string) {
    return await this.request("thread/read", { threadId });
  }

  async readThreadWithTurns(threadId: string) {
    return await this.request("thread/read", { threadId, includeTurns: true });
  }

  async resumeThread(threadId: string) {
    return await this.request("thread/resume", { threadId });
  }

  async forkThread(threadId: string) {
    return await this.request("thread/fork", { threadId });
  }

  async compactThread(threadId: string) {
    return await this.request("thread/compact/start", { threadId });
  }

  async archiveThread(threadId: string) {
    return await this.request("thread/archive", { threadId });
  }

  async setThreadName(threadId: string, name: string) {
    return await this.request("thread/name/set", { threadId, name });
  }

  async startTurn(params: {
    threadId: string;
    input: JsonRecord[];
    cwd: string;
    approvalPolicy: "on-request" | "never";
    sandboxPolicy: JsonRecord;
    model?: string | null;
    effort?: string | null;
    serviceTier?: "fast" | "flex" | null;
    collaborationMode?: unknown;
    outputSchema?: unknown;
  }) {
    return await this.request("turn/start", params);
  }

  async waitForNotification<T>(
    matcher: (message: AppServerNotificationMessage) => T | null | undefined,
    timeoutMs = this.requestTimeoutMs,
  ) {
    await this.ensureStarted();
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        fn();
      };
      const unsubscribe = this.onNotification((message) => {
        try {
          const matched = matcher(message);
          if (matched !== null && matched !== undefined) {
            finish(() => resolve(matched));
          }
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      });
      const timer = setTimeout(() => {
        finish(() => reject(new Error("Timed out while waiting for app-server notification.")));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  async interruptTurn(params: { threadId: string; turnId: string }) {
    return await this.request("turn/interrupt", params);
  }

  async steerTurn(params: {
    threadId: string;
    expectedTurnId: string;
    input: JsonRecord[];
  }) {
    return await this.request("turn/steer", params);
  }

  async startReview(params: {
    threadId: string;
    target: JsonRecord;
    delivery?: string | null;
  }) {
    return await this.request("review/start", params);
  }

  async modelList() {
    return await this.request("model/list", {});
  }

  async experimentalFeatureList(params: { cursor?: string | null; limit?: number | null } = {}) {
    return await this.request("experimentalFeature/list", params);
  }

  async collaborationModeList() {
    return await this.request("collaborationMode/list", {});
  }

  async listMcpServerStatus(params: { cursor?: string | null; limit?: number | null } = {}) {
    return await this.request("mcpServerStatus/list", params);
  }

  async accountRateLimitsRead() {
    return await this.request("account/rateLimits/read", {});
  }

  async accountRead() {
    return await this.request("account/read", {});
  }

  async startLogin(type: "chatgpt" | "apiKey" = "chatgpt") {
    return await this.request("account/login/start", { type });
  }

  async cancelLogin(loginId: string) {
    return await this.request("account/login/cancel", { loginId });
  }

  async skillsList(params: { cwd?: string; skillsPaths?: string[] } = {}) {
    return await this.request("skills/list", params);
  }

  async appsList(params: { cursor?: string | null; limit?: number | null; threadId?: string | null } = {}) {
    return await this.request("app/list", params);
  }
}
