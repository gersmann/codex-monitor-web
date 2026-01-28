import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readGlobalCodexConfigToml, writeGlobalCodexConfigToml } from "../../../services/tauri";
import { pushErrorToast } from "../../../services/toasts";

type GlobalCodexConfigState = {
  content: string;
  exists: boolean;
  truncated: boolean;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
};

const EMPTY_STATE: GlobalCodexConfigState = {
  content: "",
  exists: false,
  truncated: false,
  isLoading: false,
  isSaving: false,
  error: null,
};

export function useGlobalCodexConfigToml() {
  const [state, setState] = useState<GlobalCodexConfigState>(EMPTY_STATE);
  const lastLoadedContentRef = useRef<string>("");
  const requestIdRef = useRef(0);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const response = await readGlobalCodexConfigToml();
      if (requestId !== requestIdRef.current) {
        return;
      }
      lastLoadedContentRef.current = response.content;
      setState({
        content: response.content,
        exists: response.exists,
        truncated: response.truncated,
        isLoading: false,
        isSaving: false,
        error: null,
      });
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => ({ ...prev, isLoading: false, error: message }));
      pushErrorToast({
        title: "Couldn’t load global config.toml",
        message,
      });
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const save = useCallback(async () => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const content = state.content;
    setState((prev) => ({ ...prev, isSaving: true, error: null }));
    try {
      await writeGlobalCodexConfigToml(content);
      if (requestId !== requestIdRef.current) {
        return false;
      }
      lastLoadedContentRef.current = content;
      setState((prev) => ({
        ...prev,
        exists: true,
        truncated: false,
        isSaving: false,
        error: null,
      }));
      return true;
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => ({ ...prev, isSaving: false, error: message }));
      pushErrorToast({
        title: "Couldn’t save global config.toml",
        message,
      });
      return false;
    }
  }, [state.content]);

  const setContent = useCallback((value: string) => {
    setState((prev) => ({ ...prev, content: value }));
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const isDirty = useMemo(() => state.content !== lastLoadedContentRef.current, [state.content]);

  return {
    ...state,
    isDirty,
    setContent,
    refresh,
    save,
  };
}

