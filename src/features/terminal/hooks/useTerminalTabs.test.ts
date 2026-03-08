// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  readStoredTerminalTabs,
  STORAGE_KEY_TERMINAL_TABS,
  writeStoredTerminalTabs,
} from "./useTerminalTabs";

afterEach(() => {
  window.localStorage.clear();
});

describe("terminal tab storage", () => {
  it("restores saved terminal tabs and active selections", () => {
    window.localStorage.setItem(
      STORAGE_KEY_TERMINAL_TABS,
      JSON.stringify({
        "ws-1": {
          tabs: [{ id: "term-1", title: "Terminal 1", autoNamed: true }],
          activeTerminalId: "term-1",
        },
      }),
    );

    expect(readStoredTerminalTabs()).toEqual({
      "ws-1": {
        tabs: [{ id: "term-1", title: "Terminal 1", autoNamed: true }],
        activeTerminalId: "term-1",
      },
    });
  });

  it("persists terminal tabs keyed by workspace", () => {
    writeStoredTerminalTabs(
      {
        "ws-1": [{ id: "launch", title: "Launch", autoNamed: false }],
      },
      {
        "ws-1": "launch",
      },
    );

    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY_TERMINAL_TABS) ?? "{}")).toEqual({
      "ws-1": {
        tabs: [{ id: "launch", title: "Launch", autoNamed: false }],
        activeTerminalId: "launch",
      },
    });
  });
});
