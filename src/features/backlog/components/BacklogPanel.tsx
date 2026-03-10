import { useState } from "react";
import type { AppOption, CustomPromptOption, ThreadBacklogItem } from "@/types";
import type { PanelTabId } from "../../layout/components/PanelTabs";
import { PanelShell } from "../../layout/components/PanelShell";
import { PanelMeta } from "../../design-system/components/panel/PanelPrimitives";
import { BacklogDraftEditor } from "./BacklogDraftEditor";

type Skill = { name: string; description?: string };

type BacklogPanelProps = {
  activeThreadId: string | null;
  items: ThreadBacklogItem[];
  isLoading: boolean;
  error: string | null;
  filePanelMode: PanelTabId;
  onFilePanelModeChange: (mode: PanelTabId) => void;
  onAddItem: (text: string) => Promise<void> | void;
  onUpdateItem: (itemId: string, text: string) => Promise<void> | void;
  onDeleteItem: (itemId: string) => Promise<void> | void;
  onInsertText?: (text: string) => void;
  canInsertText: boolean;
  appsEnabled: boolean;
  skills: Skill[];
  apps: AppOption[];
  prompts: CustomPromptOption[];
  files: string[];
  onFileAutocompleteActiveChange?: (active: boolean) => void;
};

function formatTimestamp(timestamp: number) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(timestamp);
  } catch {
    return String(timestamp);
  }
}

export function BacklogPanel({
  activeThreadId,
  items,
  isLoading,
  error,
  filePanelMode,
  onFilePanelModeChange,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
  onInsertText,
  canInsertText,
  appsEnabled,
  skills,
  apps,
  prompts,
  files,
  onFileAutocompleteActiveChange,
}: BacklogPanelProps) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleCreate = async () => {
    const text = draft.trim();
    if (!text || isSaving) {
      return;
    }
    setIsSaving(true);
    setActionError(null);
    try {
      await onAddItem(text);
      setDraft("");
    } catch (errorValue) {
      setActionError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setIsSaving(false);
    }
  };

  const handleStartEdit = (item: ThreadBacklogItem) => {
    setActionError(null);
    setEditingId(item.id);
    setEditingText(item.text);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingText("");
    setActionError(null);
  };

  const handleSaveEdit = async () => {
    const itemId = editingId;
    const text = editingText.trim();
    if (!itemId || !text || isSaving) {
      return;
    }
    setIsSaving(true);
    setActionError(null);
    try {
      await onUpdateItem(itemId, text);
      handleCancelEdit();
    } catch (errorValue) {
      setActionError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (itemId: string) => {
    if (isSaving) {
      return;
    }
    setIsSaving(true);
    setActionError(null);
    try {
      await onDeleteItem(itemId);
      if (editingId === itemId) {
        handleCancelEdit();
      }
    } catch (errorValue) {
      setActionError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setIsSaving(false);
    }
  };

  const handlePop = async (item: ThreadBacklogItem) => {
    if (isSaving || !canInsertText || !onInsertText) {
      return;
    }
    setIsSaving(true);
    setActionError(null);
    try {
      onInsertText(item.text);
      await onDeleteItem(item.id);
      if (editingId === item.id) {
        handleCancelEdit();
      }
    } catch (errorValue) {
      setActionError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setIsSaving(false);
    }
  };

  const emptyState = !activeThreadId
    ? "Select a thread to keep follow-up notes here."
    : "No backlog items yet.";

  return (
    <PanelShell
      filePanelMode={filePanelMode}
      onFilePanelModeChange={onFilePanelModeChange}
      className="backlog-panel"
    >
      <div className="backlog-panel-body">
        <div className="backlog-panel-toolbar">
          <PanelMeta>{activeThreadId ? `${items.length} note${items.length === 1 ? "" : "s"}` : "Thread backlog"}</PanelMeta>
        </div>
        {!activeThreadId ? (
          <div className="backlog-panel-empty">{emptyState}</div>
        ) : (
          <>
            <div className="backlog-composer-card">
              <div className="backlog-composer">
              <BacklogDraftEditor
                className="backlog-draft-input"
                value={draft}
                onChange={setDraft}
                onFileAutocompleteActiveChange={onFileAutocompleteActiveChange}
                placeholder="Write a follow-up note or future message…"
                appsEnabled={appsEnabled}
                skills={skills}
                apps={apps}
                prompts={prompts}
                files={files}
              />
              <div className="backlog-actions">
                <button
                  type="button"
                  className="primary backlog-primary-action"
                  onClick={() => {
                    void handleCreate();
                  }}
                  disabled={!draft.trim() || isSaving}
                >
                  Save
                </button>
              </div>
              </div>
            </div>
            {error || actionError ? (
              <div className="backlog-panel-error" role="alert">
                {error || actionError}
              </div>
            ) : null}
            {isLoading && items.length === 0 ? (
              <div className="backlog-panel-empty">Loading backlog…</div>
            ) : items.length === 0 ? (
              <div className="backlog-panel-empty">{emptyState}</div>
            ) : (
              <div className="backlog-list">
                {items.map((item) => {
                  const isEditing = editingId === item.id;
                  return (
                    <div key={item.id} className="backlog-item">
                      <div className="backlog-item-meta">
                        <span>{formatTimestamp(item.createdAt)}</span>
                        {item.updatedAt > item.createdAt ? (
                          <span>Edited {formatTimestamp(item.updatedAt)}</span>
                        ) : null}
                      </div>
                      {isEditing ? (
                        <>
                          <BacklogDraftEditor
                            className="backlog-item-editor"
                            value={editingText}
                            onChange={setEditingText}
                            onFileAutocompleteActiveChange={onFileAutocompleteActiveChange}
                            placeholder="Edit backlog draft…"
                            appsEnabled={appsEnabled}
                            skills={skills}
                            apps={apps}
                            prompts={prompts}
                            files={files}
                            minRows={4}
                          />
                          <div className="backlog-item-actions">
                            <button
                              type="button"
                              className="ghost backlog-action"
                              onClick={handleCancelEdit}
                              disabled={isSaving}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="primary backlog-primary-action"
                              onClick={() => {
                                void handleSaveEdit();
                              }}
                              disabled={!editingText.trim() || isSaving}
                            >
                              Save
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="backlog-item-text">{item.text}</div>
                          <div className="backlog-item-actions">
                            <button
                              type="button"
                              className="ghost backlog-action"
                              onClick={() => {
                                void handlePop(item);
                              }}
                              disabled={!canInsertText || isSaving}
                              title={
                                canInsertText
                                  ? "Insert into composer and remove from backlog"
                                  : "Open a thread or workspace draft first"
                              }
                            >
                              Pop
                            </button>
                            <button
                              type="button"
                              className="ghost backlog-action"
                              onClick={() => onInsertText?.(item.text)}
                              disabled={!canInsertText}
                              title={
                                canInsertText
                                  ? "Insert into composer"
                                  : "Open a thread or workspace draft first"
                              }
                            >
                              Insert
                            </button>
                            <button
                              type="button"
                              className="ghost backlog-action"
                              onClick={() => handleStartEdit(item)}
                              disabled={isSaving}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="ghost backlog-action is-danger"
                              onClick={() => {
                                void handleDelete(item.id);
                              }}
                              disabled={isSaving}
                            >
                              Delete
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </PanelShell>
  );
}
