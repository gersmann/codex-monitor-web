// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsAgentsSectionProps } from "@settings/hooks/useSettingsAgentsSection";
import { SettingsAgentsSection } from "./SettingsAgentsSection";

const baseProps = (): SettingsAgentsSectionProps => ({
  settings: {
    configPath: "/Users/me/.codex/config.toml",
    multiAgentEnabled: false,
    maxThreads: 6,
    agents: [
      {
        name: "researcher",
        description: "Research-focused role",
        configFile: "researcher.toml",
        resolvedPath: "/Users/me/.codex/agents/researcher.toml",
        managedByApp: true,
        fileExists: true,
      },
    ],
  },
  isLoading: false,
  isUpdatingCore: false,
  creatingAgent: false,
  updatingAgentName: null,
  deletingAgentName: null,
  readingConfigAgentName: null,
  writingConfigAgentName: null,
  createDescriptionGenerating: false,
  editDescriptionGenerating: false,
  error: null,
  onRefresh: vi.fn(),
  onSetMultiAgentEnabled: vi.fn(async () => true),
  onSetMaxThreads: vi.fn(async () => true),
  onCreateAgent: vi.fn(async () => true),
  onUpdateAgent: vi.fn(async () => true),
  onDeleteAgent: vi.fn(async () => true),
  onReadAgentConfig: vi.fn(async () => "model = \"gpt-5-codex\""),
  onWriteAgentConfig: vi.fn(async () => true),
  onGenerateCreateDescription: vi.fn(async () => null),
  onGenerateEditDescription: vi.fn(async () => null),
  modelOptions: [
    {
      id: "gpt-5-codex",
      model: "gpt-5-codex",
      displayName: "gpt-5-codex",
      description: "",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      isDefault: true,
    },
  ],
  modelOptionsLoading: false,
  modelOptionsError: null,
});

describe("SettingsAgentsSection", () => {
  afterEach(() => {
    cleanup();
  });

  it("enables create description improve button only when description is non-empty", () => {
    const props = baseProps();
    render(<SettingsAgentsSection {...props} />);

    const improveButton = screen.getByRole("button", {
      name: "Improve description for new agent",
    }) as HTMLButtonElement;
    expect(improveButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "testing" },
    });

    expect(improveButton.disabled).toBe(false);
  });

  it("applies generated description to create textarea", async () => {
    const props = baseProps();
    const onGenerateCreateDescription = vi.fn(async () =>
      "Trigger: when tests fail intermittently\nRole: isolate flaky causes and propose stable fixes",
    );
    render(
      <SettingsAgentsSection
        {...props}
        onGenerateCreateDescription={onGenerateCreateDescription}
      />,
    );

    const createDescription = screen.getByLabelText(
      "Description",
    ) as HTMLTextAreaElement;
    fireEvent.change(createDescription, { target: { value: "flaky tests" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Improve description for new agent" }),
    );

    await waitFor(() => {
      expect(onGenerateCreateDescription).toHaveBeenCalledWith("flaky tests");
    });
    await waitFor(() => {
      expect(createDescription.value).toContain("Trigger:");
      expect(createDescription.value).toContain("Role:");
    });
  });
});
