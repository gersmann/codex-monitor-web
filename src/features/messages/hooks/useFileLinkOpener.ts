import { useCallback, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import * as Sentry from "@sentry/react";
import { openWorkspaceIn } from "../../../services/tauri";
import { pushErrorToast } from "../../../services/toasts";
import type { OpenAppTarget } from "../../../types";
import {
  isAbsolutePath,
  joinWorkspacePath,
  revealInFileManagerLabel,
} from "../../../utils/platformPaths";
import { resolveMountedWorkspacePath } from "../utils/mountedWorkspacePaths";
import { useMenuController } from "../../app/hooks/useMenuController";

type OpenTarget = {
  id: string;
  label: string;
  appName?: string | null;
  kind: OpenAppTarget["kind"];
  command?: string | null;
  args: string[];
};

const DEFAULT_OPEN_TARGET: OpenTarget = {
  id: "vscode",
  label: "VS Code",
  appName: "Visual Studio Code",
  kind: "app",
  command: null,
  args: [],
};

const resolveAppName = (target: OpenTarget) => (target.appName ?? "").trim();
const resolveCommand = (target: OpenTarget) => (target.command ?? "").trim();

const canOpenTarget = (target: OpenTarget) => {
  if (target.kind === "finder") {
    return true;
  }
  if (target.kind === "command") {
    return Boolean(resolveCommand(target));
  }
  return Boolean(resolveAppName(target));
};

function resolveFilePath(path: string, workspacePath?: string | null) {
  const trimmed = path.trim();
  if (!workspacePath) {
    return trimmed;
  }
  const mountedWorkspacePath = resolveMountedWorkspacePath(trimmed, workspacePath);
  if (mountedWorkspacePath) {
    return mountedWorkspacePath;
  }
  if (isAbsolutePath(trimmed)) {
    return trimmed;
  }
  return joinWorkspacePath(workspacePath, trimmed);
}

type ParsedFileLocation = {
  path: string;
  line: number | null;
  column: number | null;
};

type FileLinkMenuState = {
  rawPath: string;
  resolvedPath: string;
  line: number | null;
  column: number | null;
  target: OpenTarget;
  top: number;
  left: number;
};

const FILE_LOCATION_SUFFIX_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;
const FILE_LOCATION_RANGE_SUFFIX_PATTERN = /^(.*?):(\d+)-(\d+)$/;
const FILE_LOCATION_HASH_PATTERN = /^(.*?)#L(\d+)(?:C(\d+))?$/i;

function parsePositiveInteger(value?: string) {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseFileLocation(rawPath: string): ParsedFileLocation {
  const trimmed = rawPath.trim();
  const hashMatch = trimmed.match(FILE_LOCATION_HASH_PATTERN);
  if (hashMatch) {
    const [, path, lineValue, columnValue] = hashMatch;
    const line = parsePositiveInteger(lineValue);
    if (line !== null) {
      return {
        path,
        line,
        column: parsePositiveInteger(columnValue),
      };
    }
  }

  const match = trimmed.match(FILE_LOCATION_SUFFIX_PATTERN);
  if (match) {
    const [, path, lineValue, columnValue] = match;
    const line = parsePositiveInteger(lineValue);
    if (line === null) {
      return {
        path: trimmed,
        line: null,
        column: null,
      };
    }

    return {
      path,
      line,
      column: parsePositiveInteger(columnValue),
    };
  }

  const rangeMatch = trimmed.match(FILE_LOCATION_RANGE_SUFFIX_PATTERN);
  if (rangeMatch) {
    const [, path, startLineValue] = rangeMatch;
    const startLine = parsePositiveInteger(startLineValue);
    if (startLine !== null) {
      return {
        path,
        line: startLine,
        column: null,
      };
    }
  }

  return {
    path: trimmed,
    line: null,
    column: null,
  };
}

function toFileUrl(path: string, line: number | null, column: number | null) {
  const base = path.startsWith("/") ? `file://${path}` : path;
  if (line === null) {
    return base;
  }
  return `${base}#L${line}${column !== null ? `C${column}` : ""}`;
}

function clampMenuPosition(event: MouseEvent, width: number) {
  const margin = 12;
  return {
    top: Math.min(event.clientY, window.innerHeight - margin),
    left: Math.min(
      Math.max(event.clientX, margin),
      Math.max(margin, window.innerWidth - width - margin),
    ),
  };
}

const FILE_LINK_MENU_WIDTH = 220;

export function useFileLinkOpener(
  workspacePath: string | null,
  openTargets: OpenAppTarget[],
  selectedOpenAppId: string,
) {
  const [fileLinkMenu, setFileLinkMenu] = useState<FileLinkMenuState | null>(null);
  const fileLinkMenuController = useMenuController({
    open: fileLinkMenu !== null,
    onOpenChange: (open) => {
      if (!open) {
        setFileLinkMenu(null);
      }
    },
  });
  const target = useMemo(
    () => ({
      ...DEFAULT_OPEN_TARGET,
      ...(openTargets.find((entry) => entry.id === selectedOpenAppId) ??
        openTargets[0]),
    }),
    [openTargets, selectedOpenAppId],
  );
  const reportOpenError = useCallback(
    (error: unknown, context: Record<string, string | null>) => {
      const message = error instanceof Error ? error.message : String(error);
      Sentry.captureException(
        error instanceof Error ? error : new Error(message),
        {
          tags: {
            feature: "file-link-open",
          },
          extra: context,
        },
      );
      pushErrorToast({
        title: "Couldn’t open file",
        message,
      });
      console.warn("Failed to open file link", { message, ...context });
    },
    [],
  );

  const openFileLink = useCallback(
    async (rawPath: string) => {
      const fileLocation = parseFileLocation(rawPath);
      const resolvedPath = resolveFilePath(fileLocation.path, workspacePath);
      const openLocation = {
        ...(fileLocation.line !== null ? { line: fileLocation.line } : {}),
        ...(fileLocation.column !== null ? { column: fileLocation.column } : {}),
      };

      try {
        if (!canOpenTarget(target)) {
          return;
        }
        if (target.kind === "finder") {
          await revealItemInDir(resolvedPath);
          return;
        }

        if (target.kind === "command") {
          const command = resolveCommand(target);
          if (!command) {
            return;
          }
          await openWorkspaceIn(resolvedPath, {
            command,
            args: target.args,
            ...openLocation,
          });
          return;
        }

        const appName = resolveAppName(target);
        if (!appName) {
          return;
        }
        await openWorkspaceIn(resolvedPath, {
          appName,
          args: target.args,
          ...openLocation,
        });
      } catch (error) {
        reportOpenError(error, {
          rawPath,
          resolvedPath,
          workspacePath,
          targetId: target.id,
          targetKind: target.kind,
          targetAppName: target.appName ?? null,
          targetCommand: target.command ?? null,
        });
      }
    },
    [reportOpenError, target, workspacePath],
  );

  const closeFileLinkMenu = useCallback(() => {
    setFileLinkMenu(null);
  }, []);

  const openFileLinkFromMenu = useCallback(async () => {
    if (!fileLinkMenu) {
      return;
    }
    closeFileLinkMenu();
    await openFileLink(fileLinkMenu.rawPath);
  }, [closeFileLinkMenu, fileLinkMenu, openFileLink]);

  const revealLinkedFile = useCallback(async () => {
    if (!fileLinkMenu) {
      return;
    }
    const { rawPath, resolvedPath, target: currentTarget } = fileLinkMenu;
    closeFileLinkMenu();
    try {
      await revealItemInDir(resolvedPath);
    } catch (error) {
      reportOpenError(error, {
        rawPath,
        resolvedPath,
        workspacePath,
        targetId: currentTarget.id,
        targetKind: "finder",
        targetAppName: null,
        targetCommand: null,
      });
    }
  }, [closeFileLinkMenu, fileLinkMenu, reportOpenError, workspacePath]);

  const copyLinkedFileLink = useCallback(async () => {
    if (!fileLinkMenu) {
      return;
    }
    const { resolvedPath, line, column } = fileLinkMenu;
    closeFileLinkMenu();
    const link = toFileUrl(resolvedPath, line, column);
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Clipboard failures are non-fatal here.
    }
  }, [closeFileLinkMenu, fileLinkMenu]);

  const showFileLinkMenu = useCallback(
    async (event: MouseEvent, rawPath: string) => {
      event.preventDefault();
      event.stopPropagation();
      const fileLocation = parseFileLocation(rawPath);
      const resolvedPath = resolveFilePath(fileLocation.path, workspacePath);
      const { top, left } = clampMenuPosition(event, FILE_LINK_MENU_WIDTH);
      setFileLinkMenu({
        rawPath,
        resolvedPath,
        line: fileLocation.line,
        column: fileLocation.column,
        target,
        top,
        left,
      });
    },
    [target, workspacePath],
  );

  const openLabel =
    !fileLinkMenu
      ? ""
      : fileLinkMenu.target.kind === "finder"
        ? revealInFileManagerLabel()
        : fileLinkMenu.target.kind === "command"
          ? resolveCommand(fileLinkMenu.target)
            ? `Open in ${fileLinkMenu.target.label}`
            : "Set command in Settings"
          : resolveAppName(fileLinkMenu.target)
            ? `Open in ${resolveAppName(fileLinkMenu.target)}`
            : "Set app name in Settings";

  return {
    openFileLink,
    showFileLinkMenu,
    fileLinkMenu,
    fileLinkMenuRef: fileLinkMenuController.containerRef,
    closeFileLinkMenu,
    openFileLinkFromMenu,
    revealLinkedFile,
    copyLinkedFileLink,
    fileLinkMenuOpenLabel: openLabel,
    canOpenFileLinkFromMenu: fileLinkMenu ? canOpenTarget(fileLinkMenu.target) : false,
    canRevealLinkedFile: fileLinkMenu ? fileLinkMenu.target.kind !== "finder" : false,
  };
}
