import { memo, useEffect, useMemo, useRef } from "react";
import { FileDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";
import type {
  FileDiffMetadata,
  Hunk,
} from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { workerFactory } from "../../../utils/diffsWorker";

type GitDiffViewerItem = {
  path: string;
  status: string;
  diff: string;
};

type GitDiffViewerProps = {
  diffs: GitDiffViewerItem[];
  selectedPath: string | null;
  isLoading: boolean;
  error: string | null;
  onActivePathChange?: (path: string) => void;
};

type LineMaps = {
  oldLines: Map<number, string>;
  newLines: Map<number, string>;
};

type ParsedDiffEntry = GitDiffViewerItem & {
  fileDiff: FileDiffMetadata | null;
  lineMaps: LineMaps | null;
};

const DIFF_SCROLL_CSS = `
[data-column-number],
[data-buffer],
[data-separator-wrapper],
[data-annotation-content] {
  position: static !important;
}

[data-buffer] {
  background-image: none !important;
}
`;

function normalizePatchName(name: string) {
  if (!name) {
    return name;
  }
  return name.replace(/^(?:a|b)\//, "");
}

function buildLineMaps(hunks: Hunk[]): LineMaps {
  const oldLines = new Map<number, string>();
  const newLines = new Map<number, string>();
  for (const hunk of hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (const line of content.lines) {
          oldLines.set(oldLine, line);
          newLines.set(newLine, line);
          oldLine += 1;
          newLine += 1;
        }
      } else {
        for (const line of content.deletions) {
          oldLines.set(oldLine, line);
          oldLine += 1;
        }
        for (const line of content.additions) {
          newLines.set(newLine, line);
          newLine += 1;
        }
      }
    }
  }
  return { oldLines, newLines };
}

type DiffCardProps = {
  entry: ParsedDiffEntry;
  isSelected: boolean;
};

const DiffCard = memo(function DiffCard({
  entry,
  isSelected,
}: DiffCardProps) {
  const diffOptions = useMemo(
    () => ({
      diffStyle: "split" as const,
      hunkSeparators: "line-info" as const,
      overflow: "scroll" as const,
      unsafeCSS: DIFF_SCROLL_CSS,
      disableFileHeader: true,
    }),
    [],
  );

  return (
    <div
      data-diff-path={entry.path}
      className={`diff-viewer-item ${isSelected ? "active" : ""}`}
    >
      <div className="diff-viewer-header">
        <span className="diff-viewer-status">{entry.status}</span>
        <span className="diff-viewer-path">{entry.path}</span>
      </div>
      {entry.diff.trim().length > 0 && entry.fileDiff ? (
        <div className="diff-viewer-output">
          <FileDiff
            fileDiff={entry.fileDiff}
            options={diffOptions}
            className="diff-viewer-diffs"
            style={{ width: "100%", maxWidth: "100%", minWidth: 0 }}
          />
        </div>
      ) : (
        <div className="diff-viewer-placeholder">Diff unavailable.</div>
      )}
    </div>
  );
});

export function GitDiffViewer({
  diffs,
  selectedPath,
  isLoading,
  error,
}: GitDiffViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastScrolledPathRef = useRef<string | null>(null);
  const poolOptions = useMemo(() => ({ workerFactory }), []);
  const highlighterOptions = useMemo(
    () => ({ theme: { dark: "pierre-dark", light: "pierre-light" } }),
    [],
  );
  const parsedDiffs = useMemo<ParsedDiffEntry[]>(
    () =>
      diffs.map((entry) => {
        const patch = parsePatchFiles(entry.diff);
        const fileDiff = patch[0]?.files[0];
        if (!fileDiff) {
          return { ...entry, fileDiff: null, lineMaps: null };
        }
        const normalizedName = normalizePatchName(fileDiff.name || entry.path);
        const normalizedPrevName = fileDiff.prevName
          ? normalizePatchName(fileDiff.prevName)
          : undefined;
        const normalized: FileDiffMetadata = {
          ...fileDiff,
          name: normalizedName,
          prevName: normalizedPrevName,
        };
        return {
          ...entry,
          fileDiff: normalized,
          lineMaps: buildLineMaps(normalized.hunks),
        };
      }),
    [diffs],
  );

  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    if (lastScrolledPathRef.current === selectedPath) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let target: HTMLElement | null = null;
    const items = container.querySelectorAll<HTMLElement>("[data-diff-path]");
    for (const item of items) {
      if (item.dataset.diffPath === selectedPath) {
        target = item;
        break;
      }
    }
    if (!target) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const isVisible =
      targetRect.top >= containerRect.top &&
      targetRect.bottom <= containerRect.bottom;
    if (!isVisible) {
      target.scrollIntoView({ block: "start" });
    }
    lastScrolledPathRef.current = selectedPath;
  }, [selectedPath, parsedDiffs]);

  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={highlighterOptions}
    >
      <div className="diff-viewer" ref={containerRef}>
        {error && <div className="diff-viewer-empty">{error}</div>}
        {!error && isLoading && diffs.length > 0 && (
          <div className="diff-viewer-loading">Refreshing diff...</div>
        )}
        {!error && !isLoading && !diffs.length && (
          <div className="diff-viewer-empty">No changes detected.</div>
        )}
        {!error && parsedDiffs.length > 0 &&
          parsedDiffs.map((entry) => (
            <DiffCard
              key={entry.path}
              entry={entry}
              isSelected={entry.path === selectedPath}
            />
          ))}
      </div>
    </WorkerPoolContextProvider>
  );
}
