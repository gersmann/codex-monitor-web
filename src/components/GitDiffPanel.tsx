import { FileIcon, defaultStyles } from "react-file-icon";

type GitDiffPanelProps = {
  branchName: string;
  totalAdditions: number;
  totalDeletions: number;
  fileStatus: string;
  error?: string | null;
  selectedPath?: string | null;
  onSelectFile?: (path: string) => void;
  files: {
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }[];
};

function splitPath(path: string) {
  const parts = path.split("/");
  if (parts.length === 1) {
    return { name: path, dir: "" };
  }
  return { name: parts[parts.length - 1], dir: parts.slice(0, -1).join("/") };
}

function splitNameAndExtension(name: string) {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return { base: name, extension: "" };
  }
  return {
    base: name.slice(0, lastDot),
    extension: name.slice(lastDot + 1).toLowerCase(),
  };
}

export function GitDiffPanel({
  branchName,
  totalAdditions,
  totalDeletions,
  fileStatus,
  error,
  selectedPath,
  onSelectFile,
  files,
}: GitDiffPanelProps) {
  return (
    <aside className="diff-panel">
      <div className="diff-header">
        <span>Git Diff</span>
        <span className="diff-totals">
          +{totalAdditions} / -{totalDeletions}
        </span>
      </div>
      <div className="diff-status">{fileStatus}</div>
      <div className="diff-branch">{branchName || "unknown"}</div>
      <div className="diff-list">
        {error && <div className="diff-error">{error}</div>}
        {!error && !files.length && (
          <div className="diff-empty">No changes detected.</div>
        )}
        {files.map((file) => {
          const { name } = splitPath(file.path);
          const { base, extension } = splitNameAndExtension(name);
          const style = extension ? defaultStyles[extension] : undefined;
          const isSelected = file.path === selectedPath;
          return (
            <div
              key={file.path}
              className={`diff-row ${isSelected ? "active" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelectFile?.(file.path)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectFile?.(file.path);
                }
              }}
            >
              <span className="diff-icon" aria-hidden>
                <FileIcon extension={extension || "file"} {...style} />
              </span>
              <div className="diff-file">
                <div className="diff-path">
                  <span className="diff-name">
                    <span className="diff-name-base">{base}</span>
                    {extension && (
                      <span className="diff-name-ext">.{extension}</span>
                    )}
                  </span>
                  <span className="diff-counts-inline">
                    <span className="diff-add">+{file.additions}</span>
                    <span className="diff-sep">/</span>
                    <span className="diff-del">-{file.deletions}</span>
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
