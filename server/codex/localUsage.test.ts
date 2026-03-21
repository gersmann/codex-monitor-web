import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLocalUsageSnapshot } from "./localUsage.js";

const tempDirs: string[] = [];

function dayDirectory(root: string, date = new Date()) {
  const year = `${date.getFullYear()}`;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return path.join(root, year, month, day);
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("localUsage", () => {
  it("builds a usage snapshot from session jsonl files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-usage-"));
    tempDirs.push(root);
    const workspacePath = path.join(root, "workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const fileDir = dayDirectory(root);
    await fs.mkdir(fileDir, { recursive: true });

    const baseMs = Date.now() - 60_000;
    const lines = [
      {
        type: "session_meta",
        timestamp: new Date(baseMs).toISOString(),
        payload: { cwd: workspacePath },
      },
      {
        type: "turn_context",
        timestamp: new Date(baseMs + 5_000).toISOString(),
        payload: { cwd: workspacePath, model: "gpt-5" },
      },
      {
        type: "event_msg",
        timestamp: new Date(baseMs + 10_000).toISOString(),
        payload: { type: "agent_message" },
      },
      {
        type: "event_msg",
        timestamp: new Date(baseMs + 20_000).toISOString(),
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 3,
            },
          },
        },
      },
    ];
    await fs.writeFile(
      path.join(fileDir, "session.jsonl"),
      lines.map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8",
    );

    const snapshot = await buildLocalUsageSnapshot([root], 1, workspacePath);
    expect(snapshot.days).toHaveLength(1);
    expect(snapshot.days[0]?.inputTokens).toBe(10);
    expect(snapshot.days[0]?.cachedInputTokens).toBe(2);
    expect(snapshot.days[0]?.outputTokens).toBe(3);
    expect(snapshot.totals.last30DaysTokens).toBe(13);
    expect(snapshot.topModels).toEqual([
      expect.objectContaining({ model: "gpt-5", tokens: 13 }),
    ]);
  });

  it("ignores sessions that do not match the requested workspace path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-usage-"));
    tempDirs.push(root);
    const workspacePath = path.join(root, "workspace");
    const otherPath = path.join(root, "other");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(otherPath, { recursive: true });
    const fileDir = dayDirectory(root);
    await fs.mkdir(fileDir, { recursive: true });

    const lines = [
      {
        type: "session_meta",
        timestamp: new Date().toISOString(),
        payload: { cwd: otherPath },
      },
      {
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 20, output_tokens: 5 } },
        },
      },
    ];
    await fs.writeFile(
      path.join(fileDir, "session.jsonl"),
      lines.map((entry) => JSON.stringify(entry)).join("\n"),
      "utf8",
    );

    const snapshot = await buildLocalUsageSnapshot([root], 1, workspacePath);
    expect(snapshot.totals.last30DaysTokens).toBe(0);
    expect(snapshot.topModels).toEqual([]);
  });
});
