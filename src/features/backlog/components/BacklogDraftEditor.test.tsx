// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BacklogDraftEditor,
  computeBacklogSuggestionsStyle,
} from "./BacklogDraftEditor";

describe("BacklogDraftEditor", () => {
  it("renders composer-style file suggestions for backlog drafts", () => {
    const html = renderToStaticMarkup(
      <BacklogDraftEditor
        className="backlog-draft-input"
        value="@"
        onChange={() => {}}
        placeholder="Write a follow-up note or future message…"
        appsEnabled={false}
        skills={[]}
        apps={[]}
        prompts={[]}
        files={["src/App.tsx", "README.md"]}
      />,
    );

    expect(html).toContain("composer-suggestions");
    expect(html).toContain("src/App.tsx");
    expect(html).toContain("README.md");
  });

  it("places suggestions below when there is not enough space above", () => {
    const style = computeBacklogSuggestionsStyle({
      left: 180,
      viewportTop: 0,
      viewportHeight: 640,
      textareaTop: 24,
      textareaBottom: 96,
      containerWidth: 320,
    });

    expect(style.top).toContain("calc(100% +");
    expect(style.bottom).toBe("auto");
  });

  it("places suggestions above when there is more space above", () => {
    const style = computeBacklogSuggestionsStyle({
      left: 180,
      viewportTop: 0,
      viewportHeight: 560,
      textareaTop: 420,
      textareaBottom: 492,
      containerWidth: 320,
    });

    expect(style.bottom).toContain("calc(100% +");
    expect(style.top).toBe("auto");
  });

  it("accounts for the visual viewport top offset when placing suggestions", () => {
    const style = computeBacklogSuggestionsStyle({
      left: 180,
      viewportTop: 120,
      viewportHeight: 480,
      textareaTop: 160,
      textareaBottom: 232,
      containerWidth: 320,
    });

    expect(style.top).toContain("calc(100% +");
    expect(style.bottom).toBe("auto");
  });

  it("reports file autocomplete activation changes", () => {
    const onFileAutocompleteActiveChange = vi.fn();

    render(
      <BacklogDraftEditor
        className="backlog-draft-input"
        value="@"
        onChange={() => {}}
        onFileAutocompleteActiveChange={onFileAutocompleteActiveChange}
        placeholder="Write a follow-up note or future message…"
        appsEnabled={false}
        skills={[]}
        apps={[]}
        prompts={[]}
        files={["src/App.tsx"]}
      />,
    );

    expect(onFileAutocompleteActiveChange).toHaveBeenCalledWith(true);
  });
});
