import { useEffect, useMemo, useRef } from "react";
import type { CollaborationModeOption, ModelOption } from "../../../types";

type UseCollaborationModeSelectionOptions = {
  selectedCollaborationMode: CollaborationModeOption | null;
  selectedCollaborationModeId: string | null;
  models: ModelOption[];
  selectedModelId: string | null;
  selectedEffort: string | null;
  resolvedModel: string | null;
  setSelectedModelId: (id: string | null) => void;
  setSelectedEffort: (effort: string | null) => void;
};

export function useCollaborationModeSelection({
  selectedCollaborationMode,
  selectedCollaborationModeId,
  models,
  selectedModelId,
  selectedEffort,
  resolvedModel,
  setSelectedModelId,
  setSelectedEffort,
}: UseCollaborationModeSelectionOptions) {
  const lastAppliedCollaborationModeId = useRef<string | null>(null);
  const lastUserModelId = useRef<string | null>(null);
  const lastUserEffort = useRef<string | null>(null);
  const wasCollaborationModeActive = useRef(false);

  const collaborationModeModelOption = useMemo(() => {
    const collaborationModeModel = selectedCollaborationMode?.model ?? null;
    if (!collaborationModeModel) {
      return null;
    }
    return (
      models.find((model) => model.model === collaborationModeModel) ??
      models.find((model) => model.id === collaborationModeModel) ??
      null
    );
  }, [models, selectedCollaborationMode?.model]);

  useEffect(() => {
    if (!selectedCollaborationModeId) {
      if (wasCollaborationModeActive.current) {
        const restoreModelId = lastUserModelId.current;
        if (
          restoreModelId &&
          restoreModelId !== selectedModelId &&
          models.some((model) => model.id === restoreModelId)
        ) {
          setSelectedModelId(restoreModelId);
        }
        if (lastUserEffort.current !== null && lastUserEffort.current !== selectedEffort) {
          setSelectedEffort(lastUserEffort.current);
        }
        lastUserModelId.current = null;
        lastUserEffort.current = null;
        wasCollaborationModeActive.current = false;
      }
      lastAppliedCollaborationModeId.current = null;
      return;
    }
    if (!wasCollaborationModeActive.current) {
      lastUserModelId.current = selectedModelId;
      lastUserEffort.current = selectedEffort;
      wasCollaborationModeActive.current = true;
    }
    if (selectedCollaborationModeId === lastAppliedCollaborationModeId.current) {
      return;
    }
    const collaborationModeModel = selectedCollaborationMode?.model ?? null;
    const nextModelId = collaborationModeModelOption?.id ?? null;
    if (nextModelId && nextModelId !== selectedModelId) {
      setSelectedModelId(nextModelId);
    }
    const nextEffort = selectedCollaborationMode?.reasoningEffort ?? null;
    if (nextEffort && nextEffort !== selectedEffort) {
      setSelectedEffort(nextEffort);
    }
    if (!collaborationModeModel || nextModelId) {
      lastAppliedCollaborationModeId.current = selectedCollaborationModeId;
    }
  }, [
    collaborationModeModelOption?.id,
    models,
    selectedCollaborationMode?.model,
    selectedCollaborationMode?.reasoningEffort,
    selectedCollaborationModeId,
    selectedEffort,
    selectedModelId,
    setSelectedEffort,
    setSelectedModelId,
  ]);

  const collaborationModePayload = useMemo(() => {
    if (!selectedCollaborationModeId || !selectedCollaborationMode) {
      return null;
    }

    const modeValue = selectedCollaborationMode.mode || selectedCollaborationMode.id;
    if (!modeValue) {
      return null;
    }

    return {
      mode: modeValue,
      settings: {
        model: resolvedModel ?? selectedCollaborationMode.model ?? "",
        reasoning_effort:
          selectedEffort ?? selectedCollaborationMode.reasoningEffort ?? null,
        developer_instructions:
          selectedCollaborationMode.developerInstructions ?? null,
      },
    };
  }, [
    resolvedModel,
    selectedCollaborationMode,
    selectedCollaborationModeId,
    selectedEffort,
  ]);

  return { collaborationModePayload };
}
