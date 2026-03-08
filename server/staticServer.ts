import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function candidateStaticDirs() {
  const envDir = process.env.CODEX_MONITOR_WEB_STATIC_DIR?.trim();
  const candidates = [
    envDir ? path.resolve(process.cwd(), envDir) : null,
    path.resolve(process.cwd(), "dist"),
    fileURLToPath(new URL("../dist", import.meta.url)),
    fileURLToPath(new URL("../../dist", import.meta.url)),
  ];
  return candidates.filter((value, index, values): value is string => {
    return Boolean(value) && values.indexOf(value) === index;
  });
}

export function resolveStaticRoot() {
  return candidateStaticDirs().find((candidate) => existsSync(candidate)) ?? null;
}

export function contentTypeForPath(filePath: string) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ??
    "application/octet-stream";
}

function safeRelativePath(pathname: string) {
  const decodedPath = decodeURIComponent(pathname);
  const trimmed = decodedPath.replace(/^\/+/, "");
  const normalized = path.posix.normalize(`/${trimmed}`);
  if (normalized.includes("\0")) {
    return null;
  }
  return normalized.slice(1);
}

export async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
): Promise<string | null> {
  const relativePath = safeRelativePath(pathname);
  if (relativePath === null) {
    return null;
  }

  const requestedPath =
    relativePath.length > 0 ? path.resolve(staticRoot, relativePath) : path.join(staticRoot, "index.html");
  if (!requestedPath.startsWith(path.resolve(staticRoot))) {
    return null;
  }

  try {
    const requestedStats = await stat(requestedPath);
    if (requestedStats.isFile()) {
      return requestedPath;
    }
  } catch {
    // Fall back to SPA shell.
  }

  const fallbackPath = path.join(staticRoot, "index.html");
  try {
    const fallbackStats = await stat(fallbackPath);
    if (fallbackStats.isFile()) {
      return fallbackPath;
    }
  } catch {
    // Missing frontend build output.
  }
  return null;
}

export async function readStaticResponse(
  staticRoot: string,
  pathname: string,
): Promise<{ filePath: string; body: Buffer } | null> {
  const filePath = await resolveStaticFile(staticRoot, pathname);
  if (!filePath) {
    return null;
  }
  return {
    filePath,
    body: await readFile(filePath),
  };
}
