import type { JsonRecord } from "../types.js";

const AGENT_DESCRIPTION_DEVELOPER_KEYS = new Set([
  "developer instructions",
  "developer_instructions",
  "instructions",
]);

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function extractJsonValue(raw: string) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as JsonRecord;
  } catch {
    return null;
  }
}

function sanitizeRunWorktreeName(value: string) {
  const normalized = value.trim().toLowerCase();
  let cleaned = "";
  let previousDash = false;
  for (const character of normalized) {
    if (
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9") ||
      character === "/"
    ) {
      cleaned += character;
      previousDash = false;
      continue;
    }
    if (character === "-" || character === "_" || /\s/.test(character)) {
      if (!previousDash) {
        cleaned += "-";
        previousDash = true;
      }
    }
  }
  while (cleaned.endsWith("-") || cleaned.endsWith("/")) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

export function buildRunMetadataPrompt(prompt: string) {
  return (
    "You create concise run metadata for a coding task.\n" +
    "Return ONLY a JSON object with keys:\n" +
    "- title: short, clear, 3-7 words, Title Case\n" +
    "- worktreeName: lower-case, kebab-case slug prefixed with one of: " +
    "feat/, fix/, chore/, test/, docs/, refactor/, perf/, build/, ci/, style/.\n\n" +
    "Choose fix/ when the task is a bug fix, error, regression, crash, or cleanup. " +
    "Use the closest match for chores/tests/docs/refactors/perf/build/ci/style. " +
    "Otherwise use feat/.\n\n" +
    "Examples:\n" +
    '{"title":"Fix Login Redirect Loop","worktreeName":"fix/login-redirect-loop"}\n' +
    '{"title":"Add Workspace Home View","worktreeName":"feat/workspace-home"}\n' +
    '{"title":"Update Lint Config","worktreeName":"chore/update-lint-config"}\n' +
    '{"title":"Add Coverage Tests","worktreeName":"test/add-coverage-tests"}\n\n' +
    `Task:\n${prompt}`
  );
}

export function parseRunMetadataValue(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("No metadata was generated.");
  }
  const parsed = extractJsonValue(trimmed);
  if (!parsed) {
    throw new Error("Failed to parse metadata JSON.");
  }
  const title = trimString(parsed.title);
  if (!title) {
    throw new Error("Missing title in metadata.");
  }
  const worktreeName = sanitizeRunWorktreeName(
    trimString(parsed.worktreeName) || trimString(parsed.worktree_name),
  );
  if (!worktreeName) {
    throw new Error("Missing worktree name in metadata.");
  }
  return {
    title,
    worktreeName,
  };
}

export function buildAgentDescriptionPrompt(description: string) {
  return (
    "You generate custom coding-agent configuration text.\n" +
    "Return ONLY a JSON object with exactly these keys:\n" +
    "- description: short role summary, one sentence, 4-12 words.\n" +
    "- developerInstructions: multiline instructions for the agent.\n\n" +
    "Requirements:\n" +
    "- Preserve the user's intent, even when the input is short.\n" +
    "- Keep description concise and practical.\n" +
    "- developerInstructions should be actionable and specific.\n" +
    "- developerInstructions must be 3-8 lines.\n" +
    "- Do not include markdown fences.\n\n" +
    "Example:\n" +
    '{"description":"Investigates flaky tests and stabilizes suites","developerInstructions":"Investigate flaky test failures and identify root causes.\\nReproduce failures deterministically before proposing changes.\\nPrefer minimal, safe fixes and add targeted regression coverage."}\n\n' +
    "User prompt:\n" +
    description
  );
}

function normalizeAgentDescriptionOutput(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("No agent configuration was generated");
  }
  const cleaned = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"))
    .join("\n");
  if (!cleaned.trim()) {
    throw new Error("No agent configuration was generated");
  }
  return cleaned;
}

function parseAgentDescriptionFromJson(cleaned: string) {
  const parsed = extractJsonValue(cleaned);
  if (!parsed) {
    return null;
  }
  const description = trimString(parsed.description);
  const developerInstructions =
    trimString(parsed.developerInstructions) || trimString(parsed.developer_instructions);
  if (!description && !developerInstructions) {
    return null;
  }
  return { description, developerInstructions };
}

function parseAgentDescriptionLabelLine(line: string) {
  const separator = line.indexOf(":");
  if (separator < 0) {
    return null;
  }
  return {
    key: line.slice(0, separator).trim().toLowerCase(),
    value: line.slice(separator + 1).trim(),
  };
}

function combineAgentDescriptionValue(value: string, trailing: string) {
  if (value && trailing) {
    return `${value}\n${trailing}`;
  }
  return value || trailing;
}

function parseAgentDescriptionFromLines(cleaned: string) {
  const cleanedLines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let description = "";
  let developerInstructions = "";

  for (let index = 0; index < cleanedLines.length; index += 1) {
    const line = cleanedLines[index]!;
    const parsedLine = parseAgentDescriptionLabelLine(line);
    if (!parsedLine) {
      continue;
    }
    if (parsedLine.key === "description" && !description && parsedLine.value) {
      description = parsedLine.value;
      continue;
    }
    if (AGENT_DESCRIPTION_DEVELOPER_KEYS.has(parsedLine.key) && !developerInstructions) {
      const trailing = cleanedLines.slice(index + 1).join("\n").trim();
      const combined = combineAgentDescriptionValue(parsedLine.value, trailing);
      if (combined.trim()) {
        developerInstructions = combined;
      }
    }
  }

  if (!description && !developerInstructions) {
    return null;
  }
  return { description, developerInstructions };
}

function parseAgentDescriptionFromFirstLine(cleaned: string) {
  const newlineIndex = cleaned.indexOf("\n");
  if (newlineIndex < 0) {
    return null;
  }
  const first = cleaned.slice(0, newlineIndex).trim();
  const rest = cleaned.slice(newlineIndex + 1).trim();
  if (!first && !rest) {
    return null;
  }
  return {
    description: first,
    developerInstructions: rest,
  };
}

export function parseAgentDescriptionValue(raw: string) {
  const cleaned = normalizeAgentDescriptionOutput(raw);
  const fromJson = parseAgentDescriptionFromJson(cleaned);
  if (fromJson) {
    return fromJson;
  }
  const fromLines = parseAgentDescriptionFromLines(cleaned);
  if (fromLines) {
    return fromLines;
  }
  const fromFirstLine = parseAgentDescriptionFromFirstLine(cleaned);
  if (fromFirstLine) {
    return fromFirstLine;
  }
  return {
    description: cleaned,
    developerInstructions: "",
  };
}

export function findLastAgentMessageText(rawThread: JsonRecord, expectedTurnId: string | null) {
  const rawTurns = Array.isArray(rawThread.turns) ? (rawThread.turns as JsonRecord[]) : [];
  const targetTurn =
    (expectedTurnId
      ? rawTurns.find((turn) => trimString(turn.id) === expectedTurnId) ?? null
      : null) ??
    rawTurns[rawTurns.length - 1] ??
    null;
  if (!targetTurn) {
    throw new Error("Detached Codex turn completed without a turn payload.");
  }
  const items = Array.isArray(targetTurn.items) ? (targetTurn.items as JsonRecord[]) : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (trimString(item.type) !== "agentMessage") {
      continue;
    }
    const text = trimString(item.text);
    if (text) {
      return text;
    }
  }
  throw new Error("Detached Codex turn completed without an agent message.");
}

function isInlineImageUrl(image: string) {
  return (
    image.startsWith("data:") ||
    image.startsWith("http://") ||
    image.startsWith("https://")
  );
}

export function buildAppServerUserInputItems(
  text: string,
  images: string[] = [],
  appMentions?: unknown,
) {
  const input: JsonRecord[] = [];
  const trimmedText = text.trim();
  if (trimmedText) {
    input.push({
      type: "text",
      text: trimmedText,
      text_elements: [],
    });
  }
  for (const image of images) {
    const trimmed = image.trim();
    if (!trimmed) {
      continue;
    }
    if (isInlineImageUrl(trimmed)) {
      input.push({ type: "image", url: trimmed });
      continue;
    }
    input.push({ type: "localImage", path: trimmed });
  }
  if (Array.isArray(appMentions)) {
    const seenPaths = new Set<string>();
    for (const rawMention of appMentions) {
      if (!rawMention || typeof rawMention !== "object") {
        throw new Error("Invalid app mention payload.");
      }
      const mention = rawMention as Record<string, unknown>;
      const name = trimString(mention.name);
      const mentionPath = trimString(mention.path);
      if (!name || !mentionPath || !mentionPath.startsWith("app://")) {
        throw new Error("Invalid app mention payload.");
      }
      if (seenPaths.has(mentionPath)) {
        continue;
      }
      seenPaths.add(mentionPath);
      input.push({
        type: "mention",
        name,
        path: mentionPath,
      });
    }
  }
  if (input.length === 0) {
    throw new Error("Empty user message.");
  }
  return input;
}

export function extractUserMessageTextFromStoredItem(item: JsonRecord) {
  const content = Array.isArray(item.content) ? (item.content as JsonRecord[]) : [];
  const textParts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const type = trimString(entry.type);
    if (type === "text" || type === "input_text") {
      const text = trimString(entry.text);
      if (text) {
        textParts.push(text);
      }
      continue;
    }
    if (type === "skill") {
      const name = trimString(entry.name);
      if (name) {
        textParts.push(`$${name}`);
      }
    }
  }
  return textParts.join(" ").trim();
}
