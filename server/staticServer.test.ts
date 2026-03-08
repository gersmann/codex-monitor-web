import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  contentTypeForPath,
  readStaticResponse,
  resolveStaticFile,
} from "./staticServer.js";

const tempDirs: string[] = [];

async function makeStaticRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-monitor-static-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await import("node:fs/promises").then(({ rm }) =>
        rm(dir, { recursive: true, force: true }),
      );
    }),
  );
});

describe("staticServer", () => {
  it("serves a direct file when it exists", async () => {
    const root = await makeStaticRoot();
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "assets", "app.js"), "console.log('ok');");

    const filePath = await resolveStaticFile(root, "/assets/app.js");

    expect(filePath).toBe(path.join(root, "assets", "app.js"));
  });

  it("falls back to index.html for SPA routes", async () => {
    const root = await makeStaticRoot();
    await writeFile(path.join(root, "index.html"), "<html>shell</html>");

    const filePath = await resolveStaticFile(root, "/threads/thread-1");

    expect(filePath).toBe(path.join(root, "index.html"));
  });

  it("rejects traversal outside the static root", async () => {
    const root = await makeStaticRoot();
    await writeFile(path.join(root, "index.html"), "<html>shell</html>");

    const filePath = await resolveStaticFile(root, "/../../etc/passwd");

    expect(filePath).toBe(path.join(root, "index.html"));
  });

  it("reads the resolved file body for responses", async () => {
    const root = await makeStaticRoot();
    await writeFile(path.join(root, "index.html"), "<html>shell</html>");

    const response = await readStaticResponse(root, "/");

    expect(response).toEqual({
      filePath: path.join(root, "index.html"),
      body: Buffer.from("<html>shell</html>"),
    });
  });

  it("returns the correct content type for known extensions", () => {
    expect(contentTypeForPath("/tmp/app.js")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(contentTypeForPath("/tmp/app.woff2")).toBe("font/woff2");
    expect(contentTypeForPath("/tmp/blob.bin")).toBe("application/octet-stream");
  });
});
