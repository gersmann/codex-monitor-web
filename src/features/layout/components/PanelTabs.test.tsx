import { describe, expect, it } from "vitest";
import { defaultPanelTabs, webPanelTabs } from "./PanelTabs";

describe("PanelTabs", () => {
  it("adds a web-only backlog tab after the default panel tabs", () => {
    expect(defaultPanelTabs.map((tab) => tab.id)).toEqual(["git", "files", "prompts"]);
    expect(webPanelTabs.map((tab) => tab.id)).toEqual([
      "git",
      "files",
      "prompts",
      "backlog",
    ]);
  });
});
