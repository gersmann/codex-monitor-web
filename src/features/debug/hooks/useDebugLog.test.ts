import { describe, expect, it } from "vitest";
import { summarizePayload, trimDebugEntries } from "./useDebugLog";

describe("summarizePayload", () => {
  it("deeply summarizes nested arrays, objects, and long strings", () => {
    const result = summarizePayload({
      method: "turn/completed",
      params: {
        thread: {
          id: "thread-1",
          items: [
            { id: "item-1", text: "a".repeat(400) },
            { id: "item-2", text: "b".repeat(400) },
            { id: "item-3", text: "c".repeat(400) },
            { id: "item-4", text: "d".repeat(400) },
          ],
        },
      },
    }) as Record<string, unknown>;

    expect(result.method).toBe("turn/completed");
    expect(result.params).toMatchObject({
      thread: {
        id: "thread-1",
        items: {
          _type: "array",
          count: 4,
        },
      },
    });
  });
});

describe("trimDebugEntries", () => {
  it("keeps the newest entries within the total byte budget", () => {
    const entries = Array.from({ length: 220 }, (_, index) => ({
      id: `entry-${index}`,
      timestamp: index,
      source: "event" as const,
      label: "debug",
      payload: { text: "x".repeat(4_000) },
    }));

    const trimmed = trimDebugEntries(entries);

    expect(trimmed.length).toBeLessThan(200);
    expect(trimmed[0]?.id).not.toBe("entry-0");
    expect(trimmed[trimmed.length - 1]?.id).toBe("entry-219");
  });
});
