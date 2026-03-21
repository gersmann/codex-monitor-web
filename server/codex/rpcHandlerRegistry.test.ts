import { describe, expect, it, vi } from "vitest";
import { defineRpcMethod, dispatchTypedRpc } from "./rpcHandlerRegistry.js";
import type { JsonRecord } from "../types.js";

describe("rpcHandlerRegistry", () => {
  it("returns parser errors without calling the handler", async () => {
    let handlerCalled = false;
    const registry = {
      demo: defineRpcMethod(
        () => ({ error: { status: 400, message: "Name is required." } }),
        () => {
          handlerCalled = true;
          return { ok: true };
        },
      ),
    };

    const result = await dispatchTypedRpc(registry, {}, "demo", {});

    expect(result).toEqual({
      error: {
        status: 400,
        message: "Name is required.",
      },
    });
    expect(handlerCalled).toBe(false);
  });

  it("dispatches parsed params to the handler", async () => {
    const handle = vi.fn((_context: unknown, params: { name: string }) => ({
      ok: params.name,
    }));
    const registry = {
      demo: defineRpcMethod(
        (_context: unknown, params: JsonRecord) => {
          const name = typeof params.name === "string" ? params.name.trim() : "";
          return { name };
        },
        handle,
      ),
    };

    const result = await dispatchTypedRpc(registry, {}, "demo", { name: " demo " });

    expect(result).toEqual({ ok: "demo" });
    expect(handle).toHaveBeenCalledWith({}, { name: "demo" });
  });

  it("returns undefined for unknown methods", async () => {
    const registry = {
      demo: defineRpcMethod(() => ({ name: "demo" }), () => ({ ok: true })),
    };

    await expect(dispatchTypedRpc(registry, {}, "missing", {})).resolves.toBeUndefined();
  });
});
