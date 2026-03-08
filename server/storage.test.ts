import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionStorage } from "./storage.js";

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-storage-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

describe("CompanionStorage", () => {
  it("recovers threads.json when trailing non-JSON garbage is appended", async () => {
    const dir = await createTempDir();
    const storage = new CompanionStorage(dir);
    const valid = {
      threads: [
        {
          id: "thread-1",
          workspaceId: "ws-1",
          sdkThreadId: "sdk-thread-1",
          cwd: "/tmp/ws-1",
          createdAt: 1,
          updatedAt: 2,
          archivedAt: null,
          name: "Pinned local title",
          preview: "Pinned local title",
          activeTurnId: null,
          turns: [],
          modelId: null,
          effort: null,
          tokenUsage: null,
        },
      ],
    };

    await fs.mkdir(path.dirname(storage.threadsPath), { recursive: true });
    await fs.writeFile(
      storage.threadsPath,
      `${JSON.stringify(valid, null, 2)}corrupted trailing assistant text`,
      "utf8",
    );

    const threads = await storage.readThreads();

    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe("thread-1");

    const repaired = JSON.parse(await fs.readFile(storage.threadsPath, "utf8")) as typeof valid;
    expect(repaired).toEqual(valid);
  });
});
