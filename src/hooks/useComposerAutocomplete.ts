import { useEffect, useMemo, useState } from "react";

export type AutocompleteItem = {
  id: string;
  label: string;
  description?: string;
  insertText?: string;
};

export type AutocompleteTrigger = {
  trigger: string;
  items: AutocompleteItem[];
};

type AutocompleteRange = {
  start: number;
  end: number;
};

type AutocompleteState = {
  active: boolean;
  trigger: string | null;
  query: string;
  range: AutocompleteRange | null;
};

type UseComposerAutocompleteArgs = {
  text: string;
  selectionStart: number | null;
  triggers: AutocompleteTrigger[];
  maxResults?: number;
};

const whitespaceRegex = /\s/;

function getTokenStart(text: string, cursor: number) {
  let index = cursor - 1;
  while (index >= 0 && !whitespaceRegex.test(text[index])) {
    index -= 1;
  }
  return index + 1;
}

function resolveAutocompleteState(
  text: string,
  cursor: number,
  triggers: AutocompleteTrigger[],
): AutocompleteState {
  const tokenStart = getTokenStart(text, cursor);
  if (tokenStart >= text.length) {
    return { active: false, trigger: null, query: "", range: null };
  }
  const triggerChar = text[tokenStart];
  const matched = triggers.find((entry) => entry.trigger === triggerChar);
  if (!matched) {
    return { active: false, trigger: null, query: "", range: null };
  }
  const query = text.slice(tokenStart + 1, cursor);
  return {
    active: true,
    trigger: triggerChar,
    query,
    range: { start: tokenStart + 1, end: cursor },
  };
}

function filterItems(items: AutocompleteItem[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return items.slice();
  }
  return items.filter((item) => {
    const label = item.label.toLowerCase();
    return label.includes(normalized);
  });
}

function sortItems(items: AutocompleteItem[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return items;
  }
  return items.slice().sort((a, b) => {
    const aLabel = a.label.toLowerCase();
    const bLabel = b.label.toLowerCase();
    const aStarts = aLabel.startsWith(normalized);
    const bStarts = bLabel.startsWith(normalized);
    if (aStarts !== bStarts) {
      return aStarts ? -1 : 1;
    }
    return aLabel.localeCompare(bLabel);
  });
}

export function useComposerAutocomplete({
  text,
  selectionStart,
  triggers,
  maxResults = 8,
}: UseComposerAutocompleteArgs) {
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const state = useMemo(() => {
    if (selectionStart === null || selectionStart < 0) {
      return { active: false, trigger: null, query: "", range: null };
    }
    return resolveAutocompleteState(text, selectionStart, triggers);
  }, [selectionStart, text, triggers]);

  const matches = useMemo(() => {
    if (!state.active || !state.trigger) {
      return [];
    }
    const source = triggers.find((entry) => entry.trigger === state.trigger);
    if (!source) {
      return [];
    }
    const filtered = filterItems(source.items, state.query);
    const sorted = sortItems(filtered, state.query);
    return sorted.slice(0, Math.max(0, maxResults));
  }, [state.active, state.query, state.trigger, triggers, maxResults]);

  useEffect(() => {
    setHighlightIndex(0);
    setDismissed(false);
  }, [state.active, state.query, state.trigger, state.range?.start, state.range?.end]);

  const moveHighlight = (delta: number) => {
    if (matches.length === 0) {
      return;
    }
    setHighlightIndex((prev) => {
      const next = (prev + delta + matches.length) % matches.length;
      return next;
    });
  };

  const close = () => {
    setHighlightIndex(0);
    setDismissed(true);
  };

  return {
    active: state.active && matches.length > 0 && !dismissed,
    query: state.query,
    range: state.range,
    matches,
    highlightIndex,
    setHighlightIndex,
    moveHighlight,
    close,
  };
}
