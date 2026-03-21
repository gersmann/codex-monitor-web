import type { GitHubIssue, GitHubPullRequest, GitLogEntry } from "../../../types";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { openExternalUrl } from "@services/opener";
import Copy from "lucide-react/dist/esm/icons/copy";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import FileText from "lucide-react/dist/esm/icons/file-text";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Minus from "lucide-react/dist/esm/icons/minus";
import ScrollText from "lucide-react/dist/esm/icons/scroll-text";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import Search from "lucide-react/dist/esm/icons/search";
import Plus from "lucide-react/dist/esm/icons/plus";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PanelTabId } from "../../layout/components/PanelTabs";
import { useMenuController } from "../../app/hooks/useMenuController";
import {
  PopoverMenuItem,
  PopoverSurface,
} from "../../design-system/components/popover/PopoverPrimitives";
import { PanelShell } from "../../layout/components/PanelShell";
import { pushErrorToast } from "../../../services/toasts";
import {
  fileManagerName,
  isAbsolutePath as isAbsolutePathForPlatform,
} from "../../../utils/platformPaths";
import {
  GitBranchRow,
  GitDiffModeContent,
  GitIssuesModeContent,
  GitLogModeContent,
  GitPerFileModeContent,
  GitPanelModeStatus,
  GitPullRequestsModeContent,
  GitRootCurrentPath,
} from "./GitDiffPanelModeContent";
import {
  SidebarError,
  type SidebarErrorAction,
} from "./GitDiffPanelShared";
import {
  getFileName,
  getGitHubBaseUrl,
  getRelativePathWithin,
  hasPushSyncConflict,
  isMissingRepo,
  joinRootAndPath,
  normalizeRootPath,
  resolveRootPath,
} from "./GitDiffPanel.utils";
import { useDiffFileSelection } from "../hooks/useDiffFileSelection";
import type { GitPanelMode } from "../types";
import type { PerFileDiffGroup } from "../utils/perFileThreadDiffs";

type GitContextMenuAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
};

type GitContextMenuState = {
  top: number;
  left: number;
  actions: GitContextMenuAction[];
};

const GIT_CONTEXT_MENU_WIDTH = 240;

type GitDiffPanelProps = {
  workspaceId?: string | null;
  workspacePath?: string | null;
  mode: GitPanelMode;
  onModeChange: (mode: GitPanelMode) => void;
  filePanelMode: PanelTabId;
  onFilePanelModeChange: (mode: PanelTabId) => void;
  worktreeApplyLabel?: string;
  worktreeApplyTitle?: string | null;
  worktreeApplyLoading?: boolean;
  worktreeApplyError?: string | null;
  worktreeApplySuccess?: boolean;
  onApplyWorktreeChanges?: () => void | Promise<void>;
  onRevertAllChanges?: () => void | Promise<void>;
  branchName: string;
  totalAdditions: number;
  totalDeletions: number;
  fileStatus: string;
  perFileDiffGroups?: PerFileDiffGroup[];
  error?: string | null;
  logError?: string | null;
  logLoading?: boolean;
  logTotal?: number;
  logAhead?: number;
  logBehind?: number;
  logAheadEntries?: GitLogEntry[];
  logBehindEntries?: GitLogEntry[];
  logUpstream?: string | null;
  issues?: GitHubIssue[];
  issuesTotal?: number;
  issuesLoading?: boolean;
  issuesError?: string | null;
  pullRequests?: GitHubPullRequest[];
  pullRequestsTotal?: number;
  pullRequestsLoading?: boolean;
  pullRequestsError?: string | null;
  selectedPullRequest?: number | null;
  onSelectPullRequest?: (pullRequest: GitHubPullRequest) => void;
  gitRemoteUrl?: string | null;
  gitRoot?: string | null;
  gitRootCandidates?: string[];
  gitRootScanDepth?: number;
  gitRootScanLoading?: boolean;
  gitRootScanError?: string | null;
  gitRootScanHasScanned?: boolean;
  onGitRootScanDepthChange?: (depth: number) => void;
  onScanGitRoots?: () => void;
  onSelectGitRoot?: (path: string) => void;
  onClearGitRoot?: () => void;
  onPickGitRoot?: () => void | Promise<void>;
  onInitGitRepo?: () => void | Promise<void>;
  initGitRepoLoading?: boolean;
  selectedPath?: string | null;
  onSelectFile?: (path: string) => void;
  stagedFiles: {
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }[];
  unstagedFiles: {
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }[];
  onStageAllChanges?: () => void | Promise<void>;
  onStageFile?: (path: string) => Promise<void> | void;
  onUnstageFile?: (path: string) => Promise<void> | void;
  onRevertFile?: (path: string) => Promise<void> | void;
  onReviewUncommittedChanges?: (workspaceId?: string | null) => void | Promise<void>;
  logEntries: GitLogEntry[];
  selectedCommitSha?: string | null;
  onSelectCommit?: (entry: GitLogEntry) => void;
  commitMessage?: string;
  commitMessageLoading?: boolean;
  commitMessageError?: string | null;
  onCommitMessageChange?: (value: string) => void;
  onGenerateCommitMessage?: () => void | Promise<void>;
  // Git operations
  onCommit?: () => void | Promise<void>;
  onCommitAndPush?: () => void | Promise<void>;
  onCommitAndSync?: () => void | Promise<void>;
  onPull?: () => void | Promise<void>;
  onFetch?: () => void | Promise<void>;
  onPush?: () => void | Promise<void>;
  onSync?: () => void | Promise<void>;
  commitLoading?: boolean;
  pullLoading?: boolean;
  fetchLoading?: boolean;
  pushLoading?: boolean;
  syncLoading?: boolean;
  commitError?: string | null;
  pullError?: string | null;
  fetchError?: string | null;
  pushError?: string | null;
  syncError?: string | null;
  // For showing push button when there are commits to push
  commitsAhead?: number;
};

export function GitDiffPanel({
  workspaceId = null,
  workspacePath = null,
  mode,
  onModeChange,
  filePanelMode,
  onFilePanelModeChange,
  worktreeApplyTitle = null,
  worktreeApplyLoading = false,
  worktreeApplyError = null,
  worktreeApplySuccess = false,
  onApplyWorktreeChanges,
  onRevertAllChanges: _onRevertAllChanges,
  branchName,
  totalAdditions,
  totalDeletions,
  fileStatus,
  perFileDiffGroups = [],
  error,
  logError,
  logLoading = false,
  logTotal = 0,
  gitRemoteUrl = null,
  onSelectFile,
  logEntries,
  logAhead = 0,
  logBehind = 0,
  logAheadEntries = [],
  logBehindEntries = [],
  logUpstream = null,
  selectedCommitSha = null,
  onSelectCommit,
  issues = [],
  issuesTotal = 0,
  issuesLoading = false,
  issuesError = null,
  pullRequests = [],
  pullRequestsTotal = 0,
  pullRequestsLoading = false,
  pullRequestsError = null,
  selectedPullRequest = null,
  onSelectPullRequest,
  gitRoot = null,
  gitRootCandidates = [],
  gitRootScanDepth = 2,
  gitRootScanLoading = false,
  gitRootScanError = null,
  gitRootScanHasScanned = false,
  selectedPath = null,
  stagedFiles = [],
  unstagedFiles = [],
  onStageAllChanges,
  onStageFile,
  onUnstageFile,
  onRevertFile,
  onReviewUncommittedChanges,
  onGitRootScanDepthChange,
  onScanGitRoots,
  onSelectGitRoot,
  onClearGitRoot,
  onPickGitRoot,
  onInitGitRepo,
  initGitRepoLoading = false,
  commitMessage = "",
  commitMessageLoading = false,
  commitMessageError = null,
  onCommitMessageChange,
  onGenerateCommitMessage,
  onCommit,
  onCommitAndPush: _onCommitAndPush,
  onCommitAndSync: _onCommitAndSync,
  onPull,
  onFetch,
  onPush,
  onSync: _onSync,
  commitLoading = false,
  pullLoading = false,
  fetchLoading = false,
  pushLoading = false,
  syncLoading: _syncLoading = false,
  commitError = null,
  pullError = null,
  fetchError = null,
  pushError = null,
  syncError = null,
  commitsAhead = 0,
}: GitDiffPanelProps) {
  const [dismissedErrorSignatures, setDismissedErrorSignatures] = useState<Set<string>>(
    new Set(),
  );
  const [contextMenu, setContextMenu] = useState<GitContextMenuState | null>(null);
  const contextMenuController = useMenuController({
    open: contextMenu !== null,
    onOpenChange: (open) => {
      if (!open) {
        setContextMenu(null);
      }
    },
  });
  const {
    selectedFiles,
    handleFileClick,
    handleDiffListClick,
    selectOnlyFile,
  } = useDiffFileSelection({
    stagedFiles,
    unstagedFiles,
    onSelectFile,
  });

  const ModeIcon = useMemo(() => {
    switch (mode) {
      case "log":
        return ScrollText;
      case "issues":
        return Search;
      case "prs":
        return GitBranch;
      default:
        return FileText;
    }
  }, [mode]);

  const pushNeedsSync = useMemo(() => hasPushSyncConflict(pushError), [pushError]);
  const pushErrorMessage = useMemo(() => {
    if (!pushError) {
      return null;
    }
    if (!pushNeedsSync) {
      return pushError;
    }
    return `Remote has new commits. Sync (pull then push) before retrying.\n\n${pushError}`;
  }, [pushError, pushNeedsSync]);

  const handleSyncFromError = useCallback(() => {
    void _onSync?.();
  }, [_onSync]);

  const pushErrorAction = useMemo<SidebarErrorAction | null>(() => {
    if (!pushNeedsSync || !_onSync) {
      return null;
    }
    return {
      label: _syncLoading ? "Syncing..." : "Sync (pull then push)",
      onAction: handleSyncFromError,
      disabled: _syncLoading,
      loading: _syncLoading,
    };
  }, [pushNeedsSync, _onSync, _syncLoading, handleSyncFromError]);

  const githubBaseUrl = useMemo(() => getGitHubBaseUrl(gitRemoteUrl), [gitRemoteUrl]);

  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, actions: GitContextMenuAction[]) => {
      event.preventDefault();
      event.stopPropagation();
      if (!actions.length) {
        return;
      }
      const margin = 12;
      setContextMenu({
        top: Math.min(event.clientY, window.innerHeight - margin),
        left: Math.min(
          Math.max(event.clientX, margin),
          Math.max(margin, window.innerWidth - GIT_CONTEXT_MENU_WIDTH - margin),
        ),
        actions,
      });
    },
    [],
  );

  const showLogMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, entry: GitLogEntry) => {
      const actions: GitContextMenuAction[] = [
        {
          id: "copy-sha",
          label: "Copy SHA",
          icon: <Copy size={14} aria-hidden />,
          onSelect: async () => {
            await navigator.clipboard.writeText(entry.sha);
          },
        },
      ];
      if (githubBaseUrl) {
        actions.push({
          id: "open-github",
          label: "Open on GitHub",
          icon: <ExternalLink size={14} aria-hidden />,
          onSelect: async () => {
            await openExternalUrl(`${githubBaseUrl}/commit/${entry.sha}`);
          },
        });
      }
      openContextMenu(event, actions);
    },
    [githubBaseUrl, openContextMenu],
  );

  const showPullRequestMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, pullRequest: GitHubPullRequest) => {
      openContextMenu(event, [
        {
          id: "open-pr",
          label: "Open on GitHub",
          icon: <ExternalLink size={14} aria-hidden />,
          onSelect: async () => {
          await openExternalUrl(pullRequest.url);
        },
        },
      ]);
    },
    [openContextMenu],
  );

  const discardFiles = useCallback(
    async (paths: string[]) => {
      if (!onRevertFile) {
        return;
      }

      const isSingle = paths.length === 1;
      const previewLimit = 6;
      const preview = paths.slice(0, previewLimit).join("\n");
      const more = paths.length > previewLimit ? `\n… and ${paths.length - previewLimit} more` : "";
      const message = isSingle
        ? `Discard changes in:\n\n${paths[0]}\n\nThis cannot be undone.`
        : `Discard changes in these files?\n\n${preview}${more}\n\nThis cannot be undone.`;
      const confirmed = await ask(message, {
        title: "Discard changes",
        kind: "warning",
      });
      if (!confirmed) {
        return;
      }

      for (const path of paths) {
        await onRevertFile(path);
      }
    },
    [onRevertFile],
  );

  const discardFile = useCallback(
    async (path: string) => {
      await discardFiles([path]);
    },
    [discardFiles],
  );

  const showFileMenu = useCallback(
    (
      event: ReactMouseEvent<HTMLDivElement>,
      path: string,
      _section: "staged" | "unstaged",
    ) => {
      const isInSelection = selectedFiles.has(path);
      const targetPaths = isInSelection && selectedFiles.size > 1 ? Array.from(selectedFiles) : [path];

      if (!isInSelection) {
        selectOnlyFile(path);
      }

      const fileCount = targetPaths.length;
      const plural = fileCount > 1 ? "s" : "";
      const countSuffix = fileCount > 1 ? ` (${fileCount})` : "";
      const normalizedRoot = resolveRootPath(gitRoot, workspacePath);
      const inferredRoot =
        !normalizedRoot && gitRootCandidates.length === 1
          ? resolveRootPath(gitRootCandidates[0], workspacePath)
          : "";
      const fallbackRoot = normalizeRootPath(workspacePath);
      const resolvedRoot = normalizedRoot || inferredRoot || fallbackRoot;

      const stagedPaths = targetPaths.filter((targetPath) =>
        stagedFiles.some((file) => file.path === targetPath),
      );
      const unstagedPaths = targetPaths.filter((targetPath) =>
        unstagedFiles.some((file) => file.path === targetPath),
      );

      const actions: GitContextMenuAction[] = [];

      if (stagedPaths.length > 0 && onUnstageFile) {
        actions.push({
          id: "unstage",
          label: `Unstage file${stagedPaths.length > 1 ? `s (${stagedPaths.length})` : ""}`,
          icon: <Minus size={14} aria-hidden />,
          onSelect: async () => {
              for (const stagedPath of stagedPaths) {
                await onUnstageFile(stagedPath);
              }
            },
        });
      }

      if (unstagedPaths.length > 0 && onStageFile) {
        actions.push({
          id: "stage",
          label: `Stage file${unstagedPaths.length > 1 ? `s (${unstagedPaths.length})` : ""}`,
          icon: <Plus size={14} aria-hidden />,
          onSelect: async () => {
              for (const unstagedPath of unstagedPaths) {
                await onStageFile(unstagedPath);
              }
            },
        });
      }

      if (targetPaths.length === 1) {
        const fileManagerLabel = fileManagerName();
        const rawPath = targetPaths[0];
        const absolutePath = resolvedRoot ? joinRootAndPath(resolvedRoot, rawPath) : rawPath;
        const relativeRoot =
          workspacePath && resolvedRoot ? getRelativePathWithin(workspacePath, resolvedRoot) : null;
        const projectRelativePath =
          relativeRoot !== null ? joinRootAndPath(relativeRoot, rawPath) : rawPath;
        const fileName = getFileName(rawPath);

        actions.push({
          id: "reveal",
          label: `Show in ${fileManagerLabel}`,
          icon: <FolderOpen size={14} aria-hidden />,
          onSelect: async () => {
              try {
                if (!resolvedRoot && !isAbsolutePathForPlatform(absolutePath)) {
                  pushErrorToast({
                    title: `Couldn't show file in ${fileManagerLabel}`,
                    message: "Select a git root first.",
                  });
                  return;
                }
                const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
                await revealItemInDir(absolutePath);
              } catch (menuError) {
                const message = menuError instanceof Error ? menuError.message : String(menuError);
                pushErrorToast({
                  title: `Couldn't show file in ${fileManagerLabel}`,
                  message,
                });
                console.warn("Failed to reveal file", {
                  message,
                  path: absolutePath,
                });
              }
            },
        });

        actions.push(
          {
            id: "copy-name",
            label: "Copy file name",
            icon: <Copy size={14} aria-hidden />,
            onSelect: async () => {
              await navigator.clipboard.writeText(fileName);
            },
          },
          {
            id: "copy-path",
            label: "Copy file path",
            icon: <Copy size={14} aria-hidden />,
            onSelect: async () => {
              await navigator.clipboard.writeText(projectRelativePath);
            },
          },
        );
      }

      if (onRevertFile) {
        actions.push({
          id: "discard",
          label: `Discard change${plural}${countSuffix}`,
          icon: <RotateCcw size={14} aria-hidden />,
          onSelect: async () => {
              await discardFiles(targetPaths);
            },
        });
      }

      if (!actions.length) {
        return;
      }
      openContextMenu(event, actions);
    },
    [
      selectedFiles,
      selectOnlyFile,
      stagedFiles,
      unstagedFiles,
      onUnstageFile,
      onStageFile,
      onRevertFile,
      discardFiles,
      openContextMenu,
      gitRoot,
      gitRootCandidates,
      workspacePath,
    ],
  );

  const logCountLabel = logTotal
    ? `${logTotal} commit${logTotal === 1 ? "" : "s"}`
    : logEntries.length
      ? `${logEntries.length} commit${logEntries.length === 1 ? "" : "s"}`
      : "No commits";
  const logSyncLabel = logUpstream ? `↑${logAhead} ↓${logBehind}` : "No upstream configured";
  const logUpstreamLabel = logUpstream ? `Upstream ${logUpstream}` : "";
  const showAheadSection = Boolean(logUpstream && logAhead > 0);
  const showBehindSection = Boolean(logUpstream && logBehind > 0);
  const hasDiffTotals = totalAdditions > 0 || totalDeletions > 0;
  const perFileEditCount = perFileDiffGroups.reduce(
    (total, group) => total + group.edits.length,
    0,
  );
  const perFileDiffStatusLabel = `${perFileDiffGroups.length} files · ${perFileEditCount} edits`;
  const diffTotalsLabel = `+${totalAdditions} / -${totalDeletions}`;
  const diffStatusLabel = hasDiffTotals
    ? [logUpstream ? logSyncLabel : null, diffTotalsLabel].filter(Boolean).join(" · ")
    : logUpstream
      ? `${logSyncLabel} · ${fileStatus}`
      : fileStatus;
  const hasGitRoot = Boolean(gitRoot && gitRoot.trim());
  const showGitRootPanel =
    isMissingRepo(error) ||
    gitRootScanLoading ||
    gitRootScanHasScanned ||
    Boolean(gitRootScanError) ||
    gitRootCandidates.length > 0;
  const normalizedGitRoot = normalizeRootPath(gitRoot);
  const errorScope = `${workspaceId ?? "no-workspace"}:${normalizedGitRoot || "no-git-root"}:${mode}`;
  const hasAnyChanges = stagedFiles.length > 0 || unstagedFiles.length > 0;
  const showApplyWorktree = mode === "diff" && Boolean(onApplyWorktreeChanges) && hasAnyChanges;
  const canGenerateCommitMessage = hasAnyChanges;
  const showGenerateCommitMessage = mode === "diff" && Boolean(onGenerateCommitMessage) && hasAnyChanges;
  const commitsBehind = logBehind;

  const sidebarErrorCandidates = useMemo(() => {
    const options: Array<{
      key: string;
      message: string | null | undefined;
      action?: SidebarErrorAction;
    }> =
      mode === "diff" || mode === "perFile"
        ? [
            { key: "push", message: pushErrorMessage, action: pushErrorAction ?? undefined },
            { key: "pull", message: pullError },
            { key: "fetch", message: fetchError },
            { key: "commit", message: commitError },
            { key: "sync", message: syncError },
            { key: "commitMessage", message: commitMessageError },
            { key: "git", message: error },
            { key: "worktreeApply", message: worktreeApplyError },
            { key: "gitRootScan", message: gitRootScanError },
          ]
        : mode === "log"
          ? [{ key: "log", message: logError }]
          : mode === "issues"
            ? [{ key: "issues", message: issuesError }]
            : [{ key: "pullRequests", message: pullRequestsError }];

    return options
      .filter((entry) => Boolean(entry.message))
      .map((entry) => ({
        ...entry,
        signature: `${errorScope}:${entry.key}:${entry.message}`,
        message: entry.message as string,
      }));
  }, [
    commitError,
    commitMessageError,
    error,
    fetchError,
    gitRootScanError,
    issuesError,
    logError,
    pullRequestsError,
    pullError,
    pushErrorAction,
    pushErrorMessage,
    syncError,
    worktreeApplyError,
    errorScope,
    mode,
  ]);

  const sidebarError = useMemo(
    () =>
      sidebarErrorCandidates.find((entry) => !dismissedErrorSignatures.has(entry.signature)) ??
      null,
    [dismissedErrorSignatures, sidebarErrorCandidates],
  );

  useEffect(() => {
    const activeSignatures = new Set(sidebarErrorCandidates.map((entry) => entry.signature));
    setDismissedErrorSignatures((previous) => {
      let changed = false;
      const next = new Set<string>();
      previous.forEach((signature) => {
        if (activeSignatures.has(signature)) {
          next.add(signature);
        } else {
          changed = true;
        }
      });
      return changed || next.size !== previous.size ? next : previous;
    });
  }, [sidebarErrorCandidates]);

  const showSidebarError = Boolean(sidebarError);

  return (
    <PanelShell
      filePanelMode={filePanelMode}
      onFilePanelModeChange={onFilePanelModeChange}
      headerClassName="git-panel-header"
      headerRight={
        <div className="git-panel-actions" role="group" aria-label="Git panel">
          <div className="git-panel-select">
            <span className="git-panel-select-icon" aria-hidden>
              <ModeIcon />
            </span>
            <select
              className="git-panel-select-input"
              value={mode}
              onChange={(event) => onModeChange(event.target.value as GitDiffPanelProps["mode"])}
              aria-label="Git panel view"
            >
              <option value="diff">Diff</option>
              <option value="perFile">Agent edits</option>
              <option value="log">Log</option>
              <option value="issues">Issues</option>
              <option value="prs">PRs</option>
            </select>
          </div>
        </div>
      }
    >

      <GitPanelModeStatus
        mode={mode}
        diffStatusLabel={diffStatusLabel}
        perFileDiffStatusLabel={perFileDiffStatusLabel}
        logCountLabel={logCountLabel}
        logSyncLabel={logSyncLabel}
        logUpstreamLabel={logUpstreamLabel}
        issuesLoading={issuesLoading}
        issuesTotal={issuesTotal}
        pullRequestsLoading={pullRequestsLoading}
        pullRequestsTotal={pullRequestsTotal}
      />

      <GitBranchRow
        mode={mode}
        branchName={branchName}
        onFetch={onFetch}
        fetchLoading={fetchLoading}
      />

      <GitRootCurrentPath
        mode={mode}
        hasGitRoot={hasGitRoot}
        gitRoot={gitRoot}
        onScanGitRoots={onScanGitRoots}
        gitRootScanLoading={gitRootScanLoading}
      />

      {mode === "diff" ? (
        <GitDiffModeContent
          error={error}
          showGitRootPanel={showGitRootPanel}
          onScanGitRoots={onScanGitRoots}
          gitRootScanLoading={gitRootScanLoading}
          gitRootScanDepth={gitRootScanDepth}
          onGitRootScanDepthChange={onGitRootScanDepthChange}
          onPickGitRoot={onPickGitRoot}
          onInitGitRepo={onInitGitRepo}
          initGitRepoLoading={initGitRepoLoading}
          hasGitRoot={hasGitRoot}
          onClearGitRoot={onClearGitRoot}
          gitRootScanError={gitRootScanError}
          gitRootScanHasScanned={gitRootScanHasScanned}
          gitRootCandidates={gitRootCandidates}
          gitRoot={gitRoot}
          onSelectGitRoot={onSelectGitRoot}
          showGenerateCommitMessage={showGenerateCommitMessage}
          showApplyWorktree={showApplyWorktree}
          commitMessage={commitMessage}
          onCommitMessageChange={onCommitMessageChange}
          commitMessageLoading={commitMessageLoading}
          canGenerateCommitMessage={canGenerateCommitMessage}
          onGenerateCommitMessage={onGenerateCommitMessage}
          worktreeApplyTitle={worktreeApplyTitle}
          worktreeApplyLoading={worktreeApplyLoading}
          worktreeApplySuccess={worktreeApplySuccess}
          onApplyWorktreeChanges={onApplyWorktreeChanges}
          stagedFiles={stagedFiles}
          unstagedFiles={unstagedFiles}
          commitLoading={commitLoading}
          onCommit={onCommit}
          commitsAhead={commitsAhead}
          commitsBehind={commitsBehind}
          onPull={onPull}
          pullLoading={pullLoading}
          onPush={onPush}
          pushLoading={pushLoading}
          onSync={_onSync}
          syncLoading={_syncLoading}
          onStageAllChanges={onStageAllChanges}
          onStageFile={onStageFile}
          onUnstageFile={onUnstageFile}
          onDiscardFile={onRevertFile ? discardFile : undefined}
          onDiscardFiles={onRevertFile ? discardFiles : undefined}
          onReviewUncommittedChanges={
            onReviewUncommittedChanges
              ? () => onReviewUncommittedChanges(workspaceId)
              : undefined
          }
          selectedFiles={selectedFiles}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          onFileClick={handleFileClick}
          onShowFileMenu={showFileMenu}
          onDiffListClick={handleDiffListClick}
        />
      ) : mode === "perFile" ? (
        <GitPerFileModeContent
          groups={perFileDiffGroups}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
        />
      ) : mode === "log" ? (
        <GitLogModeContent
          logError={logError}
          logLoading={logLoading}
          logEntries={logEntries}
          showAheadSection={showAheadSection}
          showBehindSection={showBehindSection}
          logAheadEntries={logAheadEntries}
          logBehindEntries={logBehindEntries}
          selectedCommitSha={selectedCommitSha}
          onSelectCommit={onSelectCommit}
          onShowLogMenu={showLogMenu}
        />
      ) : mode === "issues" ? (
        <GitIssuesModeContent
          issuesError={issuesError}
          issuesLoading={issuesLoading}
          issues={issues}
        />
      ) : (
        <GitPullRequestsModeContent
          pullRequestsError={pullRequestsError}
          pullRequestsLoading={pullRequestsLoading}
          pullRequests={pullRequests}
          selectedPullRequest={selectedPullRequest}
          onSelectPullRequest={onSelectPullRequest}
          onShowPullRequestMenu={showPullRequestMenu}
        />
      )}

      {showSidebarError && sidebarError && (
        <SidebarError
          message={sidebarError.message}
          action={sidebarError.action ?? null}
          onDismiss={() =>
            setDismissedErrorSignatures((previous) => {
              if (previous.has(sidebarError.signature)) {
                return previous;
              }
              const next = new Set(previous);
              next.add(sidebarError.signature);
              return next;
            })
          }
        />
      )}
      {contextMenu
        ? createPortal(
            <div
              ref={contextMenuController.containerRef}
              className="git-context-menu-shell"
              style={{
                position: "fixed",
                top: contextMenu.top,
                left: contextMenu.left,
                zIndex: 40,
              }}
            >
              <PopoverSurface className="git-context-menu" role="menu">
                {contextMenu.actions.map((action) => (
                  <PopoverMenuItem
                    key={action.id}
                    onClick={() => {
                      contextMenuController.close();
                      void action.onSelect();
                    }}
                    disabled={action.disabled}
                    icon={action.icon}
                  >
                    {action.label}
                  </PopoverMenuItem>
                ))}
              </PopoverSurface>
            </div>,
            document.body,
          )
        : null}
    </PanelShell>
  );
}
