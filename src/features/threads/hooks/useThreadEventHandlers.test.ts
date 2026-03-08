import { describe, expect, it } from "vitest";
import { getAppServerDebugLabel } from "./useThreadEventHandlers";

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
