import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DebugEntry, ModelOption, WorkspaceInfo } from "../../../types";
import { getModelList } from "../../../services/tauri";

type UseModelsOptions = {
  activeWorkspace: WorkspaceInfo | null;
  onDebug?: (entry: DebugEntry) => void;
  preferredModelId?: string | null;
  preferredEffort?: string | null;
};

export function useModels({
  activeWorkspace,
  onDebug,
  preferredModelId = null,
  preferredEffort = null,
}: UseModelsOptions) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedEffort, setSelectedEffort] = useState<string | null>(null);
  const lastFetchedWorkspaceId = useRef<string | null>(null);
  const inFlight = useRef(false);

  const workspaceId = activeWorkspace?.id ?? null;
  const isConnected = Boolean(activeWorkspace?.connected);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );

  const reasoningOptions = useMemo(() => {
    if (!selectedModel) {
      return [];
    }
    return selectedModel.supportedReasoningEfforts.map(
      (effort) => effort.reasoningEffort,
    );
  }, [selectedModel]);

  const refreshModels = useCallback(async () => {
    if (!workspaceId || !isConnected) {
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    onDebug?.({
      id: `${Date.now()}-client-model-list`,
      timestamp: Date.now(),
      source: "client",
      label: "model/list",
      payload: { workspaceId },
    });
    try {
      const response = await getModelList(workspaceId);
      onDebug?.({
        id: `${Date.now()}-server-model-list`,
        timestamp: Date.now(),
        source: "server",
        label: "model/list response",
        payload: response,
      });
      const rawData = response.result?.data ?? response.data ?? [];
      const data: ModelOption[] = rawData.map((item: any) => ({
        id: String(item.id ?? item.model ?? ""),
        model: String(item.model ?? item.id ?? ""),
        displayName: String(item.displayName ?? item.display_name ?? item.model ?? ""),
        description: String(item.description ?? ""),
        supportedReasoningEfforts: Array.isArray(item.supportedReasoningEfforts)
          ? item.supportedReasoningEfforts
          : Array.isArray(item.supported_reasoning_efforts)
            ? item.supported_reasoning_efforts.map((effort: any) => ({
                reasoningEffort: String(
                  effort.reasoningEffort ?? effort.reasoning_effort ?? "",
                ),
                description: String(effort.description ?? ""),
              }))
            : [],
        defaultReasoningEffort: String(
          item.defaultReasoningEffort ?? item.default_reasoning_effort ?? "",
        ),
        isDefault: Boolean(item.isDefault ?? item.is_default ?? false),
      }));
      setModels(data);
      lastFetchedWorkspaceId.current = workspaceId;
      const preferredModel =
        data.find((model) => model.model === "gpt-5.2-codex") ?? null;
      const defaultModel =
        preferredModel ?? data.find((model) => model.isDefault) ?? data[0] ?? null;
      const existingSelection = data.find((model) => model.id === selectedModelId) ?? null;
      const preferredSelection = data.find((model) => model.id === preferredModelId) ?? null;
      const nextSelection = existingSelection ?? preferredSelection ?? defaultModel;
      if (nextSelection) {
        setSelectedModelId(nextSelection.id);
        const nextEffort =
          selectedEffort &&
          nextSelection.supportedReasoningEfforts.some(
            (effort) => effort.reasoningEffort === selectedEffort,
          )
            ? selectedEffort
            : preferredEffort &&
                nextSelection.supportedReasoningEfforts.some(
                  (effort) => effort.reasoningEffort === preferredEffort,
                )
              ? preferredEffort
              : nextSelection.defaultReasoningEffort ?? null;
        setSelectedEffort(nextEffort);
      }
    } catch (error) {
      onDebug?.({
        id: `${Date.now()}-client-model-list-error`,
        timestamp: Date.now(),
        source: "error",
        label: "model/list error",
        payload: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight.current = false;
    }
  }, [
    isConnected,
    onDebug,
    preferredEffort,
    preferredModelId,
    selectedEffort,
    selectedModelId,
    workspaceId,
  ]);

  useEffect(() => {
    if (!workspaceId || !isConnected) {
      return;
    }
    if (lastFetchedWorkspaceId.current === workspaceId && models.length > 0) {
      return;
    }
    refreshModels();
  }, [isConnected, models.length, refreshModels, workspaceId]);

  useEffect(() => {
    if (!selectedModel) {
      return;
    }
    if (
      selectedEffort &&
      selectedModel.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === selectedEffort,
      )
    ) {
      return;
    }
    setSelectedEffort(selectedModel.defaultReasoningEffort ?? null);
  }, [selectedEffort, selectedModel]);

  useEffect(() => {
    if (!models.length) {
      return;
    }
    const preferredSelection = preferredModelId
      ? models.find((model) => model.id === preferredModelId) ?? null
      : null;
    if (!preferredSelection) {
      return;
    }
    const preferredCodex =
      models.find((model) => model.model === "gpt-5.2-codex") ?? null;
    const defaultModel =
      preferredCodex ?? models.find((model) => model.isDefault) ?? models[0] ?? null;
    const shouldApplyPreferredModel =
      !selectedModelId ||
      (defaultModel &&
        selectedModelId === defaultModel.id &&
        selectedModelId !== preferredSelection.id);
    if (shouldApplyPreferredModel) {
      setSelectedModelId(preferredSelection.id);
      const nextEffort =
        preferredEffort &&
        preferredSelection.supportedReasoningEfforts.some(
          (effort) => effort.reasoningEffort === preferredEffort,
        )
          ? preferredEffort
          : preferredSelection.defaultReasoningEffort ?? null;
      setSelectedEffort(nextEffort);
      return;
    }
    if (selectedModelId !== preferredSelection.id || !preferredEffort) {
      return;
    }
    const preferredEffortSupported = preferredSelection.supportedReasoningEfforts.some(
      (effort) => effort.reasoningEffort === preferredEffort,
    );
    if (!preferredEffortSupported) {
      return;
    }
    const defaultEffort = preferredSelection.defaultReasoningEffort ?? null;
    if (!selectedEffort || selectedEffort === defaultEffort) {
      setSelectedEffort(preferredEffort);
    }
  }, [models, preferredEffort, preferredModelId, selectedEffort, selectedModelId]);

  return {
    models,
    selectedModel,
    selectedModelId,
    setSelectedModelId,
    reasoningOptions,
    selectedEffort,
    setSelectedEffort,
    refreshModels,
  };
}
