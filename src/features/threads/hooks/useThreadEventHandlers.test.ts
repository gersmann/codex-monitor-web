import { describe, expect, it } from "vitest";
import {
  buildAppServerDebugPayload,
  getAppServerDebugLabel,
} from "./useThreadEventHandlers";

describe("getAppServerDebugLabel", () => {
  it("maps secondary app-server notification labels to useful debug labels", () => {
    expect(getAppServerDebugLabel("configWarning")).toBe("config warning");
    expect(getAppServerDebugLabel("deprecationNotice")).toBe("deprecation warning");
    expect(getAppServerDebugLabel("model/rerouted")).toBe("model rerouted");
    expect(getAppServerDebugLabel("item/mcpToolCall/progress")).toBe("mcp tool progress");
    expect(getAppServerDebugLabel("fuzzyFileSearch/sessionUpdated")).toBe("fuzzy file search updated");
    expect(getAppServerDebugLabel("fuzzyFileSearch/sessionCompleted")).toBe("fuzzy file search completed");
    expect(getAppServerDebugLabel("mcpServer/oauthLogin/completed")).toBe("mcp oauth completed");
    expect(getAppServerDebugLabel("rawResponseItem/completed")).toBe("raw response completed");
    expect(getAppServerDebugLabel("windows/worldWritableWarning")).toBe("windows writable warning");
    expect(getAppServerDebugLabel("windowsSandbox/setupCompleted")).toBe("windows sandbox setup completed");
  });

  it("falls back to the raw method or event label", () => {
    expect(getAppServerDebugLabel("turn/started")).toBe("turn/started");
    expect(getAppServerDebugLabel("")).toBe("event");
  });
});

describe("buildAppServerDebugPayload", () => {
  it("keeps only compact app-server debug fields", () => {
    const payload = buildAppServerDebugPayload({
      workspace_id: "ws-1",
      message: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            threadId: "thread-1",
            status: "completed",
            items: [{ id: "item-1", text: "large".repeat(100) }],
          },
          message: "x".repeat(500),
        },
      },
    });

    expect(payload).toMatchObject({
      workspaceId: "ws-1",
      method: "turn/completed",
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        threadId: "thread-1",
        status: "completed",
      },
    });
    expect(payload).not.toHaveProperty("items");
    expect(String(payload.message)).toContain("…");
  });
});
