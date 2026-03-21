import { useLayoutEffect, useRef, useState } from "react";
import type { AppOption, CustomPromptOption } from "@/types";
import { PopoverSurface } from "../../design-system/components/popover/PopoverPrimitives";
import { ComposerAutocompleteList } from "../../composer/components/ComposerAutocompleteList";
import { useComposerAutocompleteState } from "../../composer/hooks/useComposerAutocompleteState";
import { getCaretPosition } from "../../../utils/caretPosition";

type Skill = { name: string; description?: string };

type BacklogDraftEditorProps = {
  value: string;
  disabled?: boolean;
  placeholder: string;
  appsEnabled: boolean;
  skills: Skill[];
  apps: AppOption[];
  prompts: CustomPromptOption[];
  files: string[];
  onChange: (next: string) => void;
  onFileAutocompleteActiveChange?: (active: boolean) => void;
  minRows?: number;
  className: string;
};

const CARET_ANCHOR_GAP = 8;
const MIN_POPOVER_HEIGHT = 120;
const MAX_POPOVER_HEIGHT = 280;

type SuggestionsLayoutArgs = {
  left: number;
  viewportTop: number;
  viewportHeight: number;
  textareaTop: number;
  textareaBottom: number;
  containerWidth: number;
};

export function computeBacklogSuggestionsStyle({
  left,
  viewportTop,
  viewportHeight,
  textareaTop,
  textareaBottom,
  containerWidth,
}: SuggestionsLayoutArgs): React.CSSProperties {
  const popoverWidth = Math.min(containerWidth, 420);
  const maxLeft = Math.max(0, containerWidth - popoverWidth);
  const clampedLeft = Math.min(Math.max(0, left), maxLeft);
  const viewportBottom = viewportTop + viewportHeight;
  const availableAbove = Math.max(
    0,
    textareaTop - viewportTop - CARET_ANCHOR_GAP - 12,
  );
  const availableBelow = Math.max(
    0,
    viewportBottom - textareaBottom - CARET_ANCHOR_GAP - 12,
  );
  const placeBelow =
    availableBelow > 0 &&
    (availableBelow >= MIN_POPOVER_HEIGHT || availableBelow >= availableAbove);
  const maxHeight = Math.max(
    MIN_POPOVER_HEIGHT,
    Math.min(MAX_POPOVER_HEIGHT, placeBelow ? availableBelow : availableAbove),
  );

  return {
    left: clampedLeft,
    right: "auto",
    maxHeight,
    overflowY: "auto",
    top: placeBelow ? `calc(100% + ${CARET_ANCHOR_GAP}px)` : "auto",
    bottom: placeBelow ? "auto" : `calc(100% + ${CARET_ANCHOR_GAP}px)`,
  };
}

export function BacklogDraftEditor({
  value,
  disabled = false,
  placeholder,
  appsEnabled,
  skills,
  apps,
  prompts,
  files,
  onChange,
  onFileAutocompleteActiveChange,
  minRows = 3,
  className,
}: BacklogDraftEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [selectionStart, setSelectionStart] = useState<number | null>(value.length);
  const [suggestionsStyle, setSuggestionsStyle] = useState<React.CSSProperties | undefined>(
    undefined,
  );

  const {
    isAutocompleteOpen,
    autocompleteMatches,
    autocompleteAnchorIndex,
    highlightIndex,
    setHighlightIndex,
    applyAutocomplete,
    handleInputKeyDown,
    handleTextChange,
    handleSelectionChange,
    fileTriggerActive,
  } = useComposerAutocompleteState({
    text: value,
    selectionStart,
    disabled,
    appsEnabled,
    skills,
    apps,
    prompts,
    files,
    textareaRef,
    setText: onChange,
    setSelectionStart,
  });

  useLayoutEffect(() => {
    onFileAutocompleteActiveChange?.(fileTriggerActive);
    return () => {
      onFileAutocompleteActiveChange?.(false);
    };
  }, [fileTriggerActive, onFileAutocompleteActiveChange]);

  useLayoutEffect(() => {
    if (!isAutocompleteOpen) {
      setSuggestionsStyle(undefined);
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const cursor =
      autocompleteAnchorIndex ?? textarea.selectionStart ?? selectionStart ?? value.length;
    const caret = getCaretPosition(textarea, cursor);
    if (!caret) {
      return;
    }
    const textareaRect = textarea.getBoundingClientRect();
    const container = textarea.closest(".backlog-draft-editor");
    const containerRect = container?.getBoundingClientRect();
    const offsetLeft = textareaRect.left - (containerRect?.left ?? 0);
    const containerWidth = container?.clientWidth ?? textarea.clientWidth ?? 0;
    const viewport = window.visualViewport;
    setSuggestionsStyle(
      computeBacklogSuggestionsStyle({
        left: offsetLeft + caret.left,
        viewportTop: viewport?.offsetTop ?? 0,
        viewportHeight: viewport?.height ?? window.innerHeight,
        textareaTop: textareaRect.top,
        textareaBottom: textareaRect.bottom,
        containerWidth,
      }),
    );
  }, [autocompleteAnchorIndex, isAutocompleteOpen, selectionStart, value]);

  return (
    <div className="backlog-draft-editor">
      <textarea
        ref={textareaRef}
        className={className}
        value={value}
        onChange={(event) => handleTextChange(event.target.value, event.target.selectionStart)}
        onSelect={(event) =>
          handleSelectionChange((event.target as HTMLTextAreaElement).selectionStart)
        }
        onKeyDown={handleInputKeyDown}
        placeholder={placeholder}
        rows={minRows}
        disabled={disabled}
      />
      {isAutocompleteOpen && (
        <PopoverSurface
          className="composer-suggestions backlog-draft-suggestions"
          role="listbox"
          style={suggestionsStyle}
        >
          <ComposerAutocompleteList
            suggestions={autocompleteMatches}
            highlightIndex={highlightIndex}
            onHighlightIndex={setHighlightIndex}
            onSelectSuggestion={applyAutocomplete}
          />
        </PopoverSurface>
      )}
    </div>
  );
}
