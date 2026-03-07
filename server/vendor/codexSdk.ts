import process from "node:process";
import { spawn } from "node:child_process";
import { Codex } from "./codex-sdk/dist/index.js";
import type {
  Thread,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  Usage,
} from "./codex-sdk/dist/index.js";

export { Codex };
export type { Thread, ThreadEvent, ThreadItem, ThreadOptions, Usage };

export type JsonRecord = Record<string, unknown>;

type AppServerEnvelope =
  | {
      id: number;
      result?: unknown;
      error?: { message?: string };
    }
  | {
      method?: string;
      params?: unknown;
    };

type CodexAppServerClientOptions = {
  codexPath?: string | null;
  env?: NodeJS.ProcessEnv;
  initializeParams: JsonRecord;
  initTimeoutMs?: number;
  requestTimeoutMs?: number;
};

const DEFAULT_APP_SERVER_INIT_TIMEOUT_MS = 15_000;
const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;

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
  private readonly env: NodeJS.ProcessEnv;
  private readonly initializeParams: JsonRecord;
  private readonly initTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: CodexAppServerClientOptions) {
    this.codexPath = trimString(options.codexPath) || "codex";
    this.env = options.env ?? process.env;
    this.initializeParams = options.initializeParams;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_APP_SERVER_INIT_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS;
  }

  async request(method: string, params: JsonRecord) {
    return await new Promise<JsonRecord>((resolve, reject) => {
      const child = spawn(this.codexPath, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env,
      });

      let settled = false;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      const initializeId = 1;
      const requestId = 2;

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.kill();
        callback();
      };

      const fail = (message: string) => {
        finish(() => {
          reject(new Error(message));
        });
      };

      const send = (message: JsonRecord) => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };

      const timer = setTimeout(() => {
        fail(
          `${method} timed out while talking to codex app-server${
            stderrBuffer.trim() ? `: ${stderrBuffer.trim()}` : ""
          }`,
        );
      }, method === "initialize" ? this.initTimeoutMs : this.requestTimeoutMs);
      timer.unref?.();

      child.once("error", (error) => {
        fail(`Failed to start codex app-server: ${error.message}`);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk;
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (!line) {
            newlineIndex = stdoutBuffer.indexOf("\n");
            continue;
          }

          let message: AppServerEnvelope;
          try {
            message = parseEnvelope(line);
          } catch (error) {
            fail(
              `Invalid JSON from codex app-server: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return;
          }

          if ("id" in message && message.id === initializeId) {
            if (message.error && typeof message.error === "object") {
              fail(
                `codex app-server initialize failed: ${
                  trimString(message.error.message) || "unknown error"
                }`,
              );
              return;
            }
            send({ method: "initialized", params: {} });
            send({ id: requestId, method, params });
            newlineIndex = stdoutBuffer.indexOf("\n");
            continue;
          }

          if ("id" in message && message.id === requestId) {
            if (message.error && typeof message.error === "object") {
              fail(
                `codex app-server ${method} failed: ${
                  trimString(message.error.message) || "unknown error"
                }`,
              );
              return;
            }
            finish(() => {
              resolve((message.result ?? {}) as JsonRecord);
            });
            return;
          }

          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });

      send({
        id: initializeId,
        method: "initialize",
        params: this.initializeParams,
      });
    });
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

  async resumeThread(threadId: string) {
    return await this.request("thread/resume", { threadId });
  }

  async forkThread(threadId: string) {
    return await this.request("thread/fork", { threadId });
  }

  async compactThread(threadId: string) {
    return await this.request("thread/compact/start", { threadId });
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
}
