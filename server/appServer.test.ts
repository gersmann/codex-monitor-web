import { describe, expect, it } from "vitest";
import { buildAppServerEvent } from "./appServer.js";

describe("appServer helpers", () => {
  it("builds a notification payload with params", () => {
    expect(
      buildAppServerEvent("ws-1", "thread/started", {
        threadId: "thread-1",
      }),
    ).toEqual({
      workspace_id: "ws-1",
      message: {
        method: "thread/started",
        params: {
          threadId: "thread-1",
        },
      },
    });
  });

  it("includes message id when provided", () => {
    expect(
      buildAppServerEvent("ws-2", "turn/completed", {}, "req-9"),
    ).toEqual({
      workspace_id: "ws-2",
      message: {
        id: "req-9",
        method: "turn/completed",
        params: {},
      },
    });
  });
});
