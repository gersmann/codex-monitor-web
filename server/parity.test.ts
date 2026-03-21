import { describe, expect, it } from "vitest";
import { FRONTEND_RPC_METHODS } from "../src/services/tauriRpcRegistry.js";
import {
  INTENTIONALLY_UNSUPPORTED_RPC_METHODS,
  PARTIAL_PARITY_RPC_METHODS,
  SUPPORTED_WITHOUT_EXPLICIT_CASE,
  WEB_ADAPTED_RPC_METHODS,
} from "./parity.js";
import { DAEMON_RPC_METHODS, WEB_COMPANION_RPC_METHODS } from "./codex/rpcRegistry.js";

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
    const handled = new Set<string>(WEB_COMPANION_RPC_METHODS);
    const uncovered = FRONTEND_RPC_METHODS.filter(
      (method) => !handled.has(method) && !SUPPORTED_WITHOUT_EXPLICIT_CASE.has(method),
    );
    expect(uncovered).toEqual([]);
  });

  it("covers every legacy daemon rpc method with either support or explicit policy", () => {
    const handled = new Set<string>(WEB_COMPANION_RPC_METHODS);
    const allowed = new Set<string>([
      ...WEB_ADAPTED_RPC_METHODS,
      ...INTENTIONALLY_UNSUPPORTED_RPC_METHODS,
      ...PARTIAL_PARITY_RPC_METHODS,
    ]);
    const missing = DAEMON_RPC_METHODS.filter(
      (method) => !handled.has(method) && !allowed.has(method),
    );
    expect(missing).toEqual([]);
  });

  it("keeps partial parity methods explicit in the backend", () => {
    const handled = new Set<string>(WEB_COMPANION_RPC_METHODS);
    const missing = PARTIAL_PARITY_RPC_METHODS.filter((method) => !handled.has(method));
    expect(missing).toEqual([]);
  });
});
