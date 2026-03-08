// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  readTerminalPanelOpenState,
  STORAGE_KEY_TERMINAL_PANEL,
  writeTerminalPanelOpenState,
} from "./usePanelVisibility";

afterEach(() => {
  window.localStorage.clear();
});

describe("terminal panel storage", () => {
  it("restores terminal panel open state per workspace", () => {
    window.localStorage.setItem(
      STORAGE_KEY_TERMINAL_PANEL,
      JSON.stringify({
        "ws-1": true,
      }),
    );

    expect(readTerminalPanelOpenState()).toEqual({
      "ws-1": true,
    });
  });

  it("persists terminal panel open state", () => {
    writeTerminalPanelOpenState({
      "ws-1": true,
      "ws-2": false,
    });

    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY_TERMINAL_PANEL) ?? "{}")).toEqual({
      "ws-1": true,
      "ws-2": false,
    });
  });
});
