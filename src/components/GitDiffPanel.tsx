import { FileIcon, defaultStyles } from "react-file-icon";

type GitDiffPanelProps = {
  branchName: string;
  totalAdditions: number;
  totalDeletions: number;
  error?: string | null;
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

function extensionForPath(path: string) {
  const parts = path.split(".");
  if (parts.length <= 1) {
    return "";
  }
  return parts[parts.length - 1].toLowerCase();
}

export function GitDiffPanel({
  branchName,
  totalAdditions,
  totalDeletions,
  error,
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
      <div className="diff-branch">{branchName || "unknown"}</div>
      <div className="diff-list">
        {error && <div className="diff-error">{error}</div>}
        {!error && !files.length && (
          <div className="diff-empty">No changes detected.</div>
        )}
        {files.map((file) => {
          const { name, dir } = splitPath(file.path);
          const extension = extensionForPath(file.path);
          const style = extension ? defaultStyles[extension] : undefined;
          return (
            <div key={file.path} className="diff-row">
              <span className="diff-icon" aria-hidden>
                <FileIcon extension={extension || "file"} {...style} />
              </span>
              <div className="diff-file">
                <div className="diff-path">
                  <span>{name}</span>
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
