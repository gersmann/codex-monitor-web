import { describe, expect, it } from "vitest";
import { getLayoutMode } from "./useLayoutMode";

describe("getLayoutMode", () => {
  it("uses width-based phone and tablet breakpoints for web layouts", () => {
    expect(getLayoutMode(430, false)).toBe("phone");
    expect(getLayoutMode(932, false)).toBe("tablet");
    expect(getLayoutMode(1280, false)).toBe("desktop");
  });

  it("still forces phone layout for native mobile runtime", () => {
    expect(getLayoutMode(932, true)).toBe("phone");
  });
});
