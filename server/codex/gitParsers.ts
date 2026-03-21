const MILLISECONDS_PER_SECOND = 10 ** 3;

function normalizeGitPathForUi(filePath: string) {
  return filePath.replace(/\\/g, "/");
}

export function parseNumstat(output: string) {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const [additionsRaw = "0", deletionsRaw = "0", ...pathParts] = line.split("\t");
    const filePath = normalizeGitPathForUi(pathParts.join("\t"));
    if (!filePath) {
      continue;
    }
    stats.set(filePath, {
      additions: Number.parseInt(additionsRaw, 10) || 0,
      deletions: Number.parseInt(deletionsRaw, 10) || 0,
    });
  }
  return stats;
}

export type ParsedStatusEntry = {
  path: string;
  indexStatus: string | null;
  worktreeStatus: string | null;
  untracked: boolean;
};

function parseStatusCode(code: string) {
  return code === " " || code === "?" ? null : code;
}

function parseStatusEntry(
  entry: string,
  nextEntry: string | undefined,
): { parsed: ParsedStatusEntry; consumedNextEntry: boolean } | null {
  if (entry.startsWith("## ")) {
    return null;
  }
  const indexCode = entry[0] ?? " ";
  const worktreeCode = entry[1] ?? " ";
  let filePath = entry.slice(3);
  let consumedNextEntry = false;
  const hasRenamedPath =
    (indexCode === "R" || indexCode === "C" || worktreeCode === "R" || worktreeCode === "C") &&
    Boolean(nextEntry);
  if (hasRenamedPath && nextEntry) {
    filePath = nextEntry;
    consumedNextEntry = true;
  }
  const normalizedPath = normalizeGitPathForUi(filePath);
  if (!normalizedPath) {
    return null;
  }
  return {
    parsed: {
      path: normalizedPath,
      indexStatus: parseStatusCode(indexCode),
      worktreeStatus: parseStatusCode(worktreeCode),
      untracked: indexCode === "?" || worktreeCode === "?",
    },
    consumedNextEntry,
  };
}

export function parseStatusEntries(output: string) {
  const entries = output.split("\0").filter(Boolean);
  const parsed: ParsedStatusEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const parsedEntry = parseStatusEntry(entries[index]!, entries[index + 1]);
    if (!parsedEntry) {
      continue;
    }
    parsed.push(parsedEntry.parsed);
    if (parsedEntry.consumedNextEntry) {
      index += 1;
    }
  }
  return parsed;
}

export function parseGitLogEntries(output: string) {
  return output
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = "", summary = "", author = "", timestamp = "0"] = entry.split("\x1f");
      return {
        sha,
        summary,
        author,
        timestamp: (Number.parseInt(timestamp, 10) || 0) * MILLISECONDS_PER_SECOND,
      };
    })
    .filter((entry) => entry.sha);
}
