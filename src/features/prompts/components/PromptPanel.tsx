import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CustomPromptOption } from "../../../types";
import { expandCustomPromptText, getPromptArgumentHint } from "../../../utils/customPrompts";
import type { PanelTabId } from "../../layout/components/PanelTabs";
import { PanelShell } from "../../layout/components/PanelShell";
import {
  PanelMeta,
  PanelSearchField,
} from "../../design-system/components/panel/PanelPrimitives";
import {
  MenuTrigger,
  PopoverMenuItem,
  PopoverSurface,
} from "../../design-system/components/popover/PopoverPrimitives";
import MoreHorizontal from "lucide-react/dist/esm/icons/more-horizontal";
import Plus from "lucide-react/dist/esm/icons/plus";
import ScrollText from "lucide-react/dist/esm/icons/scroll-text";
import Search from "lucide-react/dist/esm/icons/search";
import { useMenuController } from "../../app/hooks/useMenuController";

type PromptPanelProps = {
  prompts: CustomPromptOption[];
  workspacePath: string | null;
  filePanelMode: PanelTabId;
  onFilePanelModeChange: (mode: PanelTabId) => void;
  onSendPrompt: (text: string) => void | Promise<void>;
  onSendPromptToNewAgent: (text: string) => void | Promise<void>;
  onCreatePrompt: (data: {
    scope: "workspace" | "global";
    name: string;
    description?: string | null;
    argumentHint?: string | null;
    content: string;
  }) => void | Promise<void>;
  onUpdatePrompt: (data: {
    path: string;
    name: string;
    description?: string | null;
    argumentHint?: string | null;
    content: string;
  }) => void | Promise<void>;
  onDeletePrompt: (path: string) => void | Promise<void>;
  onMovePrompt: (data: { path: string; scope: "workspace" | "global" }) => void | Promise<void>;
  onRevealWorkspacePrompts: () => void | Promise<void>;
  onRevealGeneralPrompts: () => void | Promise<void>;
  canRevealGeneralPrompts: boolean;
};

const PROMPTS_PREFIX = "prompts:";

type PromptEditorState = {
  mode: "create" | "edit";
  scope: "workspace" | "global";
  name: string;
  description: string;
  argumentHint: string;
  content: string;
  path?: string;
};

function buildPromptCommand(name: string, args: string) {
  const trimmedArgs = args.trim();
  return `/${PROMPTS_PREFIX}${name}${trimmedArgs ? ` ${trimmedArgs}` : ""}`;
}

function isWorkspacePrompt(prompt: CustomPromptOption) {
  return prompt.scope === "workspace";
}

type PromptActionMenuProps = {
  prompt: CustomPromptOption;
  onEdit: () => void;
  onMove: (scope: "workspace" | "global") => void | Promise<void>;
  onDelete: () => void;
};

function PromptActionMenu({
  prompt,
  onEdit,
  onMove,
  onDelete,
}: PromptActionMenuProps) {
  const menu = useMenuController();
  const scope = isWorkspacePrompt(prompt) ? "workspace" : "global";
  const nextScope = scope === "workspace" ? "global" : "workspace";

  return (
    <div className="prompt-action-menu-shell" ref={menu.containerRef}>
      <MenuTrigger
        type="button"
        isOpen={menu.isOpen}
        className="ghost icon-button prompt-action-menu"
        activeClassName="is-active"
        onClick={menu.toggle}
        aria-label="Prompt actions"
        title="Prompt actions"
      >
        <MoreHorizontal aria-hidden />
      </MenuTrigger>
      {menu.isOpen && (
        <PopoverSurface className="prompt-action-popover" role="menu">
          <PopoverMenuItem
            onClick={() => {
              menu.close();
              onEdit();
            }}
          >
            Edit
          </PopoverMenuItem>
          <PopoverMenuItem
            onClick={() => {
              menu.close();
              void onMove(nextScope);
            }}
          >
            {`Move to ${nextScope === "workspace" ? "workspace" : "general"}`}
          </PopoverMenuItem>
          <PopoverMenuItem
            onClick={() => {
              menu.close();
              onDelete();
            }}
          >
            Delete
          </PopoverMenuItem>
        </PopoverSurface>
      )}
    </div>
  );
}

export function PromptPanel({
  prompts,
  workspacePath,
  filePanelMode,
  onFilePanelModeChange,
  onSendPrompt,
  onSendPromptToNewAgent,
  onCreatePrompt,
  onUpdatePrompt,
  onDeletePrompt,
  onMovePrompt,
  onRevealWorkspacePrompts,
  onRevealGeneralPrompts,
  canRevealGeneralPrompts,
}: PromptPanelProps) {
  const [query, setQuery] = useState("");
  const [argsByPrompt, setArgsByPrompt] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<PromptEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const normalizedQuery = query.trim().toLowerCase();

  const showError = (error: unknown) => {
    window.alert(error instanceof Error ? error.message : String(error));
  };

  const resetEditorState = () => {
    setEditorError(null);
    setPendingDeletePath(null);
  };

  const updateEditor = (patch: Partial<PromptEditorState>) => {
    setEditor((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  useEffect(() => {
    return () => {
      if (highlightTimer.current) {
        window.clearTimeout(highlightTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!pendingDeletePath) {
      return;
    }
    const stillExists = prompts.some((prompt) => prompt.path === pendingDeletePath);
    if (!stillExists) {
      setPendingDeletePath(null);
    }
  }, [pendingDeletePath, prompts]);

  const triggerHighlight = (key: string) => {
    if (!key) {
      return;
    }
    if (highlightTimer.current) {
      window.clearTimeout(highlightTimer.current);
    }
    setHighlightKey(key);
    highlightTimer.current = window.setTimeout(() => {
      setHighlightKey(null);
    }, 650);
  };

  const buildPromptText = (prompt: CustomPromptOption, args: string) => {
    const command = buildPromptCommand(prompt.name, args);
    const expansion = expandCustomPromptText(command, [prompt]);
    if (expansion && "error" in expansion) {
      showError(expansion.error);
      return null;
    }
    if (expansion && "expanded" in expansion) {
      return expansion.expanded;
    }
    return prompt.content;
  };

  const filteredPrompts = useMemo(() => {
    if (!normalizedQuery) {
      return prompts;
    }
    return prompts.filter((prompt) => {
      const haystack = `${prompt.name} ${prompt.description ?? ""} ${prompt.path}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, prompts]);

  const { workspacePrompts, globalPrompts } = useMemo(() => {
    const workspaceEntries: CustomPromptOption[] = [];
    const globalEntries: CustomPromptOption[] = [];
    filteredPrompts.forEach((prompt) => {
      if (isWorkspacePrompt(prompt)) {
        workspaceEntries.push(prompt);
      } else {
        globalEntries.push(prompt);
      }
    });
    return { workspacePrompts: workspaceEntries, globalPrompts: globalEntries };
  }, [filteredPrompts]);

  const totalCount = filteredPrompts.length;
  const hasPrompts = totalCount > 0;

  const handleArgsChange = (key: string, value: string) => {
    setArgsByPrompt((prev) => ({ ...prev, [key]: value }));
  };

  const startCreate = (scope: "workspace" | "global") => {
    resetEditorState();
    setEditor({
      mode: "create",
      scope,
      name: "",
      description: "",
      argumentHint: "",
      content: "",
    });
  };

  const startEdit = (prompt: CustomPromptOption) => {
    const scope = isWorkspacePrompt(prompt) ? "workspace" : "global";
    resetEditorState();
    setEditor({
      mode: "edit",
      scope,
      name: prompt.name,
      description: prompt.description ?? "",
      argumentHint: prompt.argumentHint ?? "",
      content: prompt.content ?? "",
      path: prompt.path,
    });
  };

  const handleSave = async () => {
    if (!editor || isSaving) {
      return;
    }
    const name = editor.name.trim();
    if (!name) {
      setEditorError("Name is required.");
      return;
    }
    if (/\s/.test(name)) {
      setEditorError("Name cannot include whitespace.");
      return;
    }
    setEditorError(null);
    setIsSaving(true);
    const description = editor.description.trim() || null;
    const argumentHint = editor.argumentHint.trim() || null;
    const content = editor.content;
    try {
      if (editor.mode === "create") {
        await onCreatePrompt({
          scope: editor.scope,
          name,
          description,
          argumentHint,
          content,
        });
        triggerHighlight(name);
      } else if (editor.path) {
        await onUpdatePrompt({
          path: editor.path,
          name,
          description,
          argumentHint,
          content,
        });
        triggerHighlight(editor.path ?? name);
      }
      setEditor(null);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteRequest = (prompt: CustomPromptOption) => {
    if (!prompt.path) {
      return;
    }
    setPendingDeletePath(prompt.path);
  };

  const handleDeleteConfirm = async (prompt: CustomPromptOption) => {
    if (!prompt.path) {
      return;
    }
    try {
      await onDeletePrompt(prompt.path);
      setPendingDeletePath((current) =>
        current === prompt.path ? null : current,
      );
    } catch (error) {
      showError(error);
    }
  };

  const handleMove = async (prompt: CustomPromptOption, scope: "workspace" | "global") => {
    if (!prompt.path) {
      return;
    }
    try {
      await onMovePrompt({ path: prompt.path, scope });
      triggerHighlight(prompt.name);
    } catch (error) {
      showError(error);
    }
  };

  const renderPromptRow = (prompt: CustomPromptOption) => {
    const hint = getPromptArgumentHint(prompt);
    const showArgsInput = Boolean(hint);
    const key = prompt.path || prompt.name;
    const argsValue = argsByPrompt[key] ?? "";
    const effectiveArgs = showArgsInput ? argsValue : "";
    const isHighlighted = highlightKey === prompt.path || highlightKey === prompt.name;
    return (
      <div className={`prompt-row${isHighlighted ? " is-highlight" : ""}`} key={key}>
        <div className="prompt-row-header">
          <div className="prompt-name">{prompt.name}</div>
          {prompt.description && (
            <div className="prompt-description">{prompt.description}</div>
          )}
        </div>
        {hint && <div className="prompt-hint">{hint}</div>}
        <div className="prompt-actions">
          {showArgsInput ? (
            <input
              className="prompt-args-input"
              type="text"
              placeholder={hint ?? "Arguments"}
              value={argsValue}
              onChange={(event) => handleArgsChange(key, event.target.value)}
              aria-label={`Arguments for ${prompt.name}`}
            />
          ) : null}
          <button
            type="button"
            className="ghost prompt-action"
            onClick={() => {
              const text = buildPromptText(prompt, effectiveArgs);
              if (!text) {
                return;
              }
              void onSendPrompt(text);
            }}
            title="Send to current agent"
          >
            Send
          </button>
          <button
            type="button"
            className="ghost prompt-action"
            onClick={() => {
              const text = buildPromptText(prompt, effectiveArgs);
              if (!text) {
                return;
              }
              void onSendPromptToNewAgent(text);
            }}
            title="Send to a new agent"
          >
            New agent
          </button>
          <PromptActionMenu
            prompt={prompt}
            onEdit={() => startEdit(prompt)}
            onMove={(scope) => handleMove(prompt, scope)}
            onDelete={() => handleDeleteRequest(prompt)}
          />
        </div>
        {pendingDeletePath === prompt.path && (
          <div className="prompt-delete-confirm">
            <span>Delete this prompt?</span>
            <button
              type="button"
              className="ghost prompt-action"
              onClick={() => void handleDeleteConfirm(prompt)}
            >
              Delete
            </button>
            <button
              type="button"
              className="ghost prompt-action"
              onClick={() => setPendingDeletePath(null)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <PanelShell
      filePanelMode={filePanelMode}
      onFilePanelModeChange={onFilePanelModeChange}
      className="prompt-panel"
      headerClassName="git-panel-header"
      headerRight={
        <PanelMeta className="prompt-panel-meta">
          {hasPrompts ? `${totalCount} prompt${totalCount === 1 ? "" : "s"}` : "No prompts"}
        </PanelMeta>
      }
      search={
        <PanelSearchField
          className="file-tree-search"
          inputClassName="file-tree-search-input"
          placeholder="Filter prompts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter prompts"
          icon={<Search aria-hidden />}
        />
      }
    >
      <div className="prompt-panel-scroll">
        {editor && (
          <div className="prompt-editor">
            <div className="prompt-editor-row">
              <label className="prompt-editor-label">
                Name
                <input
                  className="prompt-args-input"
                  type="text"
                  value={editor.name}
                  onChange={(event) => updateEditor({ name: event.target.value })}
                  placeholder="Prompt name"
                />
              </label>
              <label className="prompt-editor-label">
                Scope
                <select
                  className="prompt-scope-select"
                  value={editor.scope}
                  onChange={(event) =>
                    updateEditor({
                      scope: event.target.value as PromptEditorState["scope"],
                    })
                  }
                  disabled={editor.mode === "edit"}
                >
                  <option value="workspace">Workspace</option>
                  <option value="global">General</option>
                </select>
              </label>
            </div>
            <div className="prompt-editor-row">
              <label className="prompt-editor-label">
                Description
                <input
                  className="prompt-args-input"
                  type="text"
                  value={editor.description}
                  onChange={(event) => updateEditor({ description: event.target.value })}
                  placeholder="Optional description"
                />
              </label>
              <label className="prompt-editor-label">
                Argument hint
                <input
                  className="prompt-args-input"
                  type="text"
                  value={editor.argumentHint}
                  onChange={(event) => updateEditor({ argumentHint: event.target.value })}
                  placeholder="Optional argument hint"
                />
              </label>
            </div>
            <label className="prompt-editor-label">
              Content
              <textarea
                className="prompt-editor-textarea"
                value={editor.content}
                onChange={(event) => updateEditor({ content: event.target.value })}
                placeholder="Prompt content"
                rows={6}
              />
            </label>
            {editorError && <div className="prompt-editor-error">{editorError}</div>}
            <div className="prompt-editor-actions">
              <button
                type="button"
                className="ghost prompt-action"
                onClick={() => setEditor(null)}
                disabled={isSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ghost prompt-action"
                onClick={() => void handleSave()}
                disabled={isSaving}
              >
                {editor.mode === "create" ? "Create" : "Save"}
              </button>
            </div>
          </div>
        )}
        <div className="prompt-section">
          <div className="prompt-section-header">
            <div className="prompt-section-title">Workspace prompts</div>
            <button
              type="button"
              className="ghost icon-button prompt-section-add"
              onClick={() => startCreate("workspace")}
              aria-label="Add workspace prompt"
              title="Add workspace prompt"
            >
              <Plus aria-hidden />
            </button>
          </div>
          {workspacePrompts.length > 0 ? (
            <div className="prompt-list">
              {workspacePrompts.map((prompt) => renderPromptRow(prompt))}
            </div>
          ) : (
            <div className="prompt-empty-card">
              <ScrollText className="prompt-empty-icon" aria-hidden />
              <div className="prompt-empty-text">
                <div className="prompt-empty-title">No workspace prompts yet</div>
                <div className="prompt-empty-subtitle">
                  Create one here or drop a .md file into the{" "}
                  {workspacePath ? (
                    <button
                      type="button"
                      className="prompt-empty-link"
                      onClick={() => void onRevealWorkspacePrompts()}
                    >
                      workspace prompts folder
                    </button>
                  ) : (
                    <span className="prompt-empty-link is-disabled">
                      workspace prompts folder
                    </span>
                  )}
                  .
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="prompt-section">
          <div className="prompt-section-header">
            <div className="prompt-section-title">General prompts</div>
            <button
              type="button"
              className="ghost icon-button prompt-section-add"
              onClick={() => startCreate("global")}
              aria-label="Add general prompt"
              title="Add general prompt"
            >
              <Plus aria-hidden />
            </button>
          </div>
          {globalPrompts.length > 0 ? (
            <div className="prompt-list">
              {globalPrompts.map((prompt) => renderPromptRow(prompt))}
            </div>
          ) : (
            <div className="prompt-empty-card">
              <ScrollText className="prompt-empty-icon" aria-hidden />
              <div className="prompt-empty-text">
                <div className="prompt-empty-title">No general prompts yet</div>
                <div className="prompt-empty-subtitle">
                  Create one here or drop a .md file into{" "}
                  {canRevealGeneralPrompts ? (
                    <button
                      type="button"
                      className="prompt-empty-link"
                      onClick={() => void onRevealGeneralPrompts()}
                    >
                      CODEX_HOME/prompts
                    </button>
                  ) : (
                    <span className="prompt-empty-link is-disabled">
                      CODEX_HOME/prompts
                    </span>
                  )}
                  .
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </PanelShell>
  );
}
