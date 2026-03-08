// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptPanel } from "./PromptPanel";

describe("PromptPanel", () => {
  const basePrompt = {
    name: "ship-it",
    path: "/tmp/prompts/ship-it.md",
    scope: "workspace" as const,
    description: "Deploy checklist",
    content: "Ship it",
  };

  function renderPromptPanel() {
    const onSendPrompt = vi.fn();
    const onSendPromptToNewAgent = vi.fn();
    const onCreatePrompt = vi.fn();
    const onUpdatePrompt = vi.fn();
    const onDeletePrompt = vi.fn();
    const onMovePrompt = vi.fn();
    const onRevealWorkspacePrompts = vi.fn();
    const onRevealGeneralPrompts = vi.fn();
    const onFilePanelModeChange = vi.fn();

    render(
      <PromptPanel
        prompts={[basePrompt]}
        workspacePath="/tmp/workspace"
        filePanelMode="prompts"
        onFilePanelModeChange={onFilePanelModeChange}
        onSendPrompt={onSendPrompt}
        onSendPromptToNewAgent={onSendPromptToNewAgent}
        onCreatePrompt={onCreatePrompt}
        onUpdatePrompt={onUpdatePrompt}
        onDeletePrompt={onDeletePrompt}
        onMovePrompt={onMovePrompt}
        onRevealWorkspacePrompts={onRevealWorkspacePrompts}
        onRevealGeneralPrompts={onRevealGeneralPrompts}
        canRevealGeneralPrompts
      />,
    );

    return {
      onSendPrompt,
      onSendPromptToNewAgent,
      onCreatePrompt,
      onUpdatePrompt,
      onDeletePrompt,
      onMovePrompt,
      onRevealWorkspacePrompts,
      onRevealGeneralPrompts,
      onFilePanelModeChange,
    };
  }

  it("opens a web popover menu and starts editing from prompt actions", async () => {
    renderPromptPanel();

    await act(async () => {
      fireEvent.click(screen.getAllByLabelText("Prompt actions")[0]);
    });

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move to general" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    });

    expect(screen.getByDisplayValue("ship-it")).toBeTruthy();
    expect(screen.getByDisplayValue("Deploy checklist")).toBeTruthy();
  });

  it("routes delete actions through the web popover menu", async () => {
    renderPromptPanel();

    await act(async () => {
      fireEvent.click(screen.getAllByLabelText("Prompt actions")[0]);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });

    expect(screen.getByText("Delete this prompt?")).toBeTruthy();
  });
});
