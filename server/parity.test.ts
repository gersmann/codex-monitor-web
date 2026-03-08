import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INTENTIONALLY_UNSUPPORTED_RPC_METHODS,
  PARTIAL_PARITY_RPC_METHODS,
  SUPPORTED_WITHOUT_EXPLICIT_CASE,
  WEB_ADAPTED_RPC_METHODS,
} from "./parity.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(filePath: string) {
  return fs.readFileSync(path.join(repoRoot, filePath), "utf8");
}

function serverHandledMethods() {
  const text = read("server/codex.ts");
  const start = text.indexOf("async handleRpc(");
  return new Set(
    [...text.slice(start).matchAll(/case\s+"([a-z0-9_]+)"\s*:/g)].map((match) => match[1]),
  );
}

function frontendInvokeMethods() {
  const text = read("src/services/tauri.ts");
  return new Set(
    [...text.matchAll(/invoke(?:<[^>]+>)?\("([a-z0-9_]+)"/g)].map((match) => match[1]),
  );
}

function daemonRpcMethods() {
  const rpcDir = path.join(repoRoot, "src-tauri/src/bin/codex_monitor_daemon/rpc");
  const methods = new Set<string>();
  for (const entry of fs.readdirSync(rpcDir)) {
    if (!entry.endsWith(".rs")) {
      continue;
    }
    const text = fs.readFileSync(path.join(rpcDir, entry), "utf8");
    for (const match of text.matchAll(/"([a-z0-9_]+)"\s*=>/g)) {
      methods.add(match[1]);
    }
  }
  return methods;
}

describe("web parity matrix", () => {
  it("keeps policy buckets disjoint", () => {
    const methodToBucket = new Map<string, string>();
    for (const [bucket, methods] of [
      ["web-adapted", WEB_ADAPTED_RPC_METHODS],
      ["unsupported", INTENTIONALLY_UNSUPPORTED_RPC_METHODS],
      ["partial", PARTIAL_PARITY_RPC_METHODS],
    ] as const) {
      for (const method of methods) {
        const existing = methodToBucket.get(method);
        expect(existing, `${method} must not appear in both ${existing} and ${bucket}`).toBeUndefined();
        methodToBucket.set(method, bucket);
      }
    }
  });

  it("classifies every frontend invoke target", () => {
    const handled = serverHandledMethods();
    const uncovered = [...frontendInvokeMethods()].filter(
      (method) => !handled.has(method) && !SUPPORTED_WITHOUT_EXPLICIT_CASE.has(method),
    );
    expect(uncovered).toEqual([]);
  });

  it("covers every legacy daemon rpc method with either support or explicit policy", () => {
    const handled = serverHandledMethods();
    const allowed = new Set<string>([
      ...WEB_ADAPTED_RPC_METHODS,
      ...INTENTIONALLY_UNSUPPORTED_RPC_METHODS,
      ...PARTIAL_PARITY_RPC_METHODS,
    ]);
    const missing = [...daemonRpcMethods()].filter(
      (method) => !handled.has(method) && !allowed.has(method),
    );
    expect(missing).toEqual([]);
  });

  it("keeps partial parity methods explicit in the backend", () => {
    const handled = serverHandledMethods();
    const missing = PARTIAL_PARITY_RPC_METHODS.filter((method) => !handled.has(method));
    expect(missing).toEqual([]);
  });
});
