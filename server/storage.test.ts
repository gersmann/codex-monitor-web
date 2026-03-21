import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionStorage } from "./storage.js";

const tempDirs: string[] = [];

async function createTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-monitor-storage-"));
  tempDirs.push(dir);
  return dir;
}

function createDeferred() {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return {
    promise,
    resolve: () => resolve?.(),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
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
          backlog: [],
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

  it("defaults backlog to an empty list for older stored threads", async () => {
    const dir = await createTempDir();
    const storage = new CompanionStorage(dir);
    await fs.mkdir(path.dirname(storage.threadsPath), { recursive: true });
    await fs.writeFile(
      storage.threadsPath,
      JSON.stringify({
        threads: [
          {
            id: "thread-1",
            workspaceId: "ws-1",
            sdkThreadId: null,
            cwd: "/tmp/ws-1",
            createdAt: 1,
            updatedAt: 2,
            archivedAt: null,
            name: null,
            preview: "Thread",
            activeTurnId: null,
            turns: [],
            modelId: null,
            effort: null,
            tokenUsage: null,
          },
        ],
      }),
      "utf8",
    );

    const threads = await storage.readThreads();

    expect(threads[0]?.backlog).toEqual([]);
  });

  it("serializes concurrent thread writes and keeps only the final state", async () => {
    const dir = await createTempDir();
    const storage = new CompanionStorage(dir);
    const unblockFirstRename = createDeferred();
    const originalRename = fs.rename.bind(fs);
    let renameCalls = 0;

    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        await unblockFirstRename.promise;
      }
      return originalRename(from, to);
    });

    const firstThread = {
      id: "thread-1",
      workspaceId: "ws-1",
      sdkThreadId: "sdk-thread-1",
      cwd: "/tmp/ws-1",
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      name: "First",
      preview: "First",
      activeTurnId: null,
      turns: [],
      modelId: null,
      effort: null,
      pinnedAt: null,
      detachedReviewParentId: null,
      codexParams: null,
      backlog: [],
      tokenUsage: null,
    };
    const secondThread = {
      ...firstThread,
      updatedAt: 2,
      name: "Second",
      preview: "Second",
    };

    const firstWrite = storage.writeThreads([firstThread]);
    await vi.waitFor(() => {
      expect(renameCalls).toBe(1);
    });

    const secondWrite = storage.writeThreads([secondThread]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(renameCalls).toBe(1);

    unblockFirstRename.resolve();
    await Promise.all([firstWrite, secondWrite]);

    const threads = await storage.readThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0]?.name).toBe("Second");

    const entries = await fs.readdir(dir);
    expect(entries.filter((entry) => entry.includes(".threads.json."))).toEqual([]);
  });
});
