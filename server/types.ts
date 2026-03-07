export type JsonRecord = Record<string, unknown>;

export type WorkspaceSettingsRecord = {
  sidebarCollapsed: boolean;
  sortOrder?: number | null;
  groupId?: string | null;
  cloneSourceWorkspaceId?: string | null;
  gitRoot?: string | null;
  launchScript?: string | null;
  launchScripts?: JsonRecord[] | null;
  worktreeSetupScript?: string | null;
};

export type StoredWorkspace = {
  id: string;
  name: string;
  path: string;
  kind?: "main" | "worktree";
  parentId?: string | null;
  worktree?: {
    branch: string;
  } | null;
  settings: WorkspaceSettingsRecord;
};

export type StoredThreadItem = JsonRecord;

export type StoredTurn = {
  id: string;
  createdAt: number;
  completedAt: number | null;
  status: "active" | "completed" | "failed" | "cancelled";
  items: StoredThreadItem[];
  errorMessage: string | null;
};

export type TokenUsageTotals = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type StoredThread = {
  id: string;
  workspaceId: string;
  sdkThreadId: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  name: string | null;
  preview: string;
  activeTurnId: string | null;
  turns: StoredTurn[];
  modelId: string | null;
  effort: string | null;
  tokenUsage: {
    total: TokenUsageTotals;
    last: TokenUsageTotals;
    modelContextWindow: number | null;
  } | null;
};

export type ThreadsFile = {
  threads: StoredThread[];
};

export type TextFileResponse = {
  exists: boolean;
  content: string;
  truncated: boolean;
};

export type RpcErrorShape = {
  error: {
    message: string;
  };
};

export type AppServerEventPayload = {
  workspace_id: string;
  message: JsonRecord;
};
