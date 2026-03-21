import { describe, expect, it } from "vitest";
import {
  buildAgentDescriptionPrompt,
  buildAppServerUserInputItems,
  buildRunMetadataPrompt,
  extractUserMessageTextFromStoredItem,
  findLastAgentMessageText,
  parseAgentDescriptionValue,
  parseRunMetadataValue,
} from "./codexPrompts.js";

describe("codexPrompts", () => {
  it("builds run metadata prompts", () => {
    const prompt = buildRunMetadataPrompt("Fix login redirect loop");
    expect(prompt).toContain("title");
    expect(prompt).toContain("worktreeName");
  });

  it("parses run metadata values", () => {
    expect(parseRunMetadataValue('{"title":"Fix Login","worktreeName":"fix/login"}')).toEqual({
      title: "Fix Login",
      worktreeName: "fix/login",
    });
    expect(() => parseRunMetadataValue("")).toThrow("No metadata was generated.");
    expect(() => parseRunMetadataValue("{bad")).toThrow("Failed to parse metadata JSON.");
  });

  it("builds and parses agent description payloads", () => {
    expect(buildAgentDescriptionPrompt("triage flaky tests")).toContain("developerInstructions");
    expect(
      parseAgentDescriptionValue(
        '{"description":"Stabilizes flaky tests","developerInstructions":"Reproduce.\\nIsolate.\\nPatch."}',
      ),
    ).toEqual({
      description: "Stabilizes flaky tests",
      developerInstructions: "Reproduce.\nIsolate.\nPatch.",
    });
    expect(
      parseAgentDescriptionValue("description: Improve queueing\ndeveloper instructions: Keep retries bounded"),
    ).toEqual({
      description: "Improve queueing",
      developerInstructions: "Keep retries bounded",
    });
  });

  it("finds the last agent message in the selected turn", () => {
    expect(
      findLastAgentMessageText(
        {
          turns: [
            {
              id: "turn-a",
              items: [{ type: "agentMessage", text: "hello" }],
            },
            {
              id: "turn-b",
              items: [{ type: "agentMessage", text: "world" }],
            },
          ],
        },
        "turn-a",
      ),
    ).toBe("hello");
  });

  it("builds app-server user input items and deduplicates mentions", () => {
    const input = buildAppServerUserInputItems(
      "Ship it",
      ["/tmp/image.png", "https://example.com/image.png"],
      [
        { name: "repo", path: "app://repo-1" },
        { name: "repo", path: "app://repo-1" },
      ],
    );
    expect(input).toEqual([
      { type: "text", text: "Ship it", text_elements: [] },
      { type: "localImage", path: "/tmp/image.png" },
      { type: "image", url: "https://example.com/image.png" },
      { type: "mention", name: "repo", path: "app://repo-1" },
    ]);
    expect(() => buildAppServerUserInputItems("   ")).toThrow("Empty user message.");
  });

  it("extracts user message text from stored items", () => {
    expect(
      extractUserMessageTextFromStoredItem({
        content: [
          { type: "text", text: "hello" },
          { type: "skill", name: "lint" },
          { type: "input_text", text: "world" },
        ],
      }),
    ).toBe("hello $lint world");
  });
});
