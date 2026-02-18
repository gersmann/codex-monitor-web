import { useCallback, useEffect, useState } from "react";
import type { AgentsSettings } from "@services/tauri";
import type { ModelOption, WorkspaceInfo } from "@/types";
import {
  createAgent,
  deleteAgent,
  getAgentsSettings,
  readAgentConfigToml,
  setAgentsCoreSettings,
  updateAgent,
  writeAgentConfigToml,
} from "@services/tauri";
import { useSettingsDefaultModels } from "./useSettingsDefaultModels";

type UseSettingsAgentsSectionArgs = {
  projects: WorkspaceInfo[];
};

export type SettingsAgentsSectionProps = {
  settings: AgentsSettings | null;
  isLoading: boolean;
  isUpdatingCore: boolean;
  creatingAgent: boolean;
  updatingAgentName: string | null;
  deletingAgentName: string | null;
  readingConfigAgentName: string | null;
  writingConfigAgentName: string | null;
  error: string | null;
  onRefresh: () => void;
  onSetMultiAgentEnabled: (enabled: boolean) => Promise<boolean>;
  onSetMaxThreads: (maxThreads: number) => Promise<boolean>;
  onCreateAgent: (input: {
    name: string;
    description?: string | null;
    template?: "blank";
    model?: string | null;
    reasoningEffort?: string | null;
  }) => Promise<boolean>;
  onUpdateAgent: (input: {
    originalName: string;
    name: string;
    description?: string | null;
    renameManagedFile?: boolean;
  }) => Promise<boolean>;
  onDeleteAgent: (input: {
    name: string;
    deleteManagedFile?: boolean;
  }) => Promise<boolean>;
  onReadAgentConfig: (agentName: string) => Promise<string | null>;
  onWriteAgentConfig: (agentName: string, content: string) => Promise<boolean>;
  modelOptions: ModelOption[];
  modelOptionsLoading: boolean;
  modelOptionsError: string | null;
};

const toErrorMessage = (value: unknown, fallback: string): string => {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return fallback;
};

export const useSettingsAgentsSection = ({
  projects,
}: UseSettingsAgentsSectionArgs): SettingsAgentsSectionProps => {
  const [settings, setSettings] = useState<AgentsSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdatingCore, setIsUpdatingCore] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [updatingAgentName, setUpdatingAgentName] = useState<string | null>(null);
  const [deletingAgentName, setDeletingAgentName] = useState<string | null>(null);
  const [readingConfigAgentName, setReadingConfigAgentName] = useState<string | null>(null);
  const [writingConfigAgentName, setWritingConfigAgentName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    models: modelOptions,
    isLoading: modelOptionsLoading,
    error: modelOptionsError,
  } = useSettingsDefaultModels(projects);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getAgentsSettings();
      setSettings(response);
    } catch (refreshError) {
      setError(toErrorMessage(refreshError, "Unable to load agents settings."));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyCoreSettings = useCallback(
    async (multiAgentEnabled: boolean, maxThreads: number): Promise<boolean> => {
      setIsUpdatingCore(true);
      setError(null);
      try {
        const response = await setAgentsCoreSettings({
          multiAgentEnabled,
          maxThreads,
        });
        setSettings(response);
        return true;
      } catch (updateError) {
        setError(toErrorMessage(updateError, "Unable to update agents core settings."));
        return false;
      } finally {
        setIsUpdatingCore(false);
      }
    },
    [],
  );

  const onSetMultiAgentEnabled = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      if (!settings) {
        return false;
      }
      return applyCoreSettings(enabled, settings.maxThreads);
    },
    [applyCoreSettings, settings],
  );

  const onSetMaxThreads = useCallback(
    async (maxThreads: number): Promise<boolean> => {
      if (!settings) {
        return false;
      }
      return applyCoreSettings(settings.multiAgentEnabled, maxThreads);
    },
    [applyCoreSettings, settings],
  );

  const onCreateAgent = useCallback(
    async (input: {
      name: string;
      description?: string | null;
      template?: "blank";
      model?: string | null;
      reasoningEffort?: string | null;
    }): Promise<boolean> => {
      setCreatingAgent(true);
      setError(null);
      try {
        const response = await createAgent(input);
        setSettings(response);
        return true;
      } catch (createError) {
        setError(toErrorMessage(createError, "Unable to create agent."));
        return false;
      } finally {
        setCreatingAgent(false);
      }
    },
    [],
  );

  const onUpdateAgent = useCallback(
    async (input: {
      originalName: string;
      name: string;
      description?: string | null;
      renameManagedFile?: boolean;
    }): Promise<boolean> => {
      setUpdatingAgentName(input.originalName);
      setError(null);
      try {
        const response = await updateAgent(input);
        setSettings(response);
        return true;
      } catch (updateError) {
        setError(toErrorMessage(updateError, "Unable to update agent."));
        return false;
      } finally {
        setUpdatingAgentName((current) =>
          current === input.originalName ? null : current,
        );
      }
    },
    [],
  );

  const onDeleteAgent = useCallback(
    async (input: {
      name: string;
      deleteManagedFile?: boolean;
    }): Promise<boolean> => {
      setDeletingAgentName(input.name);
      setError(null);
      try {
        const response = await deleteAgent(input);
        setSettings(response);
        return true;
      } catch (deleteError) {
        setError(toErrorMessage(deleteError, "Unable to delete agent."));
        return false;
      } finally {
        setDeletingAgentName((current) => (current === input.name ? null : current));
      }
    },
    [],
  );

  const onReadAgentConfig = useCallback(async (agentName: string): Promise<string | null> => {
    setReadingConfigAgentName(agentName);
    setError(null);
    try {
      return await readAgentConfigToml(agentName);
    } catch (readError) {
      setError(toErrorMessage(readError, "Unable to read agent config file."));
      return null;
    } finally {
      setReadingConfigAgentName((current) =>
        current === agentName ? null : current,
      );
    }
  }, []);

  const onWriteAgentConfig = useCallback(
    async (agentName: string, content: string): Promise<boolean> => {
      setWritingConfigAgentName(agentName);
      setError(null);
      try {
        await writeAgentConfigToml(agentName, content);
        await refresh();
        return true;
      } catch (writeError) {
        setError(toErrorMessage(writeError, "Unable to write agent config file."));
        return false;
      } finally {
        setWritingConfigAgentName((current) =>
          current === agentName ? null : current,
        );
      }
    },
    [refresh],
  );

  return {
    settings,
    isLoading,
    isUpdatingCore,
    creatingAgent,
    updatingAgentName,
    deletingAgentName,
    readingConfigAgentName,
    writingConfigAgentName,
    error,
    onRefresh: () => {
      void refresh();
    },
    onSetMultiAgentEnabled,
    onSetMaxThreads,
    onCreateAgent,
    onUpdateAgent,
    onDeleteAgent,
    onReadAgentConfig,
    onWriteAgentConfig,
    modelOptions,
    modelOptionsLoading,
    modelOptionsError,
  };
};
