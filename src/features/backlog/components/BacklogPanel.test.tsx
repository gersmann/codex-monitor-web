import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ThreadBacklogItem } from "@/types";
import { BacklogPanel } from "./BacklogPanel";

const item: ThreadBacklogItem = {
  id: "backlog-1",
  text: "Follow up on the refactor after the test run finishes.",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const baseProps = {
  filePanelMode: "backlog" as const,
  onFilePanelModeChange: () => {},
  onAddItem: () => {},
  onUpdateItem: () => {},
  onDeleteItem: () => {},
  canInsertText: false,
  appsEnabled: false,
  skills: [],
  apps: [],
  prompts: [],
  files: [],
};

describe("BacklogPanel", () => {
  it("shows an empty-state message when no thread is selected", () => {
    const html = renderToStaticMarkup(
      <BacklogPanel
        activeThreadId={null}
        items={[]}
        isLoading={false}
        error={null}
        {...baseProps}
      />,
    );

    expect(html).toContain("Select a thread to keep follow-up notes here.");
  });

  it("renders backlog actions for an active thread", () => {
    const html = renderToStaticMarkup(
      <BacklogPanel
        activeThreadId="thread-1"
        items={[item]}
        isLoading={false}
        error={null}
        {...baseProps}
        onInsertText={() => {}}
        canInsertText
      />,
    );

    expect(html).toContain("Save");
    expect(html).toContain("Insert");
    expect(html).toContain("Edit");
    expect(html).toContain("Delete");
    expect(html).toContain(item.text);
  });
});
