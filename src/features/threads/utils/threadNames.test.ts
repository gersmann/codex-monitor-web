import { describe, expect, it } from "vitest";
import { getServerThreadName, resolveThreadSummaryName } from "./threadNames";

describe("threadNames", () => {
  it("normalizes missing or blank server names to null", () => {
    expect(getServerThreadName(undefined)).toBeNull();
    expect(getServerThreadName(null)).toBeNull();
    expect(getServerThreadName("   ")).toBeNull();
  });

  it("prefers custom names over all other thread labels", () => {
    expect(
      resolveThreadSummaryName({
        customName: "Custom Title",
        serverName: "Server Title",
        preview: "Preview Title",
        fallbackName: "Agent 1",
      }),
    ).toBe("Custom Title");
  });

  it("prefers server-provided names over preview text", () => {
    expect(
      resolveThreadSummaryName({
        serverName: "Server Title",
        preview: "Preview Title",
        fallbackName: "Agent 1",
      }),
    ).toBe("Server Title");
  });

  it("falls back to a truncated preview when no explicit thread name exists", () => {
    expect(
      resolveThreadSummaryName({
        preview: "This is a very long preview title that should be truncated",
        fallbackName: "Agent 1",
      }),
    ).toBe("This is a very long preview title that…");
  });

  it("falls back to the synthetic agent label when no names are available", () => {
    expect(
      resolveThreadSummaryName({
        preview: "   ",
        fallbackName: "Agent 7",
      }),
    ).toBe("Agent 7");
  });
});
