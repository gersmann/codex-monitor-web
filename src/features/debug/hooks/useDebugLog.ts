import { useCallback, useRef, useState } from "react";
import type { DebugEntry } from "../../../types";

const MAX_DEBUG_ENTRIES = 200;
const MAX_DEBUG_TOTAL_BYTES = 256 * 1024;
const MAX_SUMMARY_DEPTH = 3;
const MAX_SUMMARY_KEYS = 12;
const MAX_SUMMARY_ARRAY_SAMPLE = 3;
const MAX_STRING_LENGTH = 240;
const TRUNCATION_SUFFIX = "…";

function truncateString(value: string, maxLength = MAX_STRING_LENGTH) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - TRUNCATION_SUFFIX.length))}${TRUNCATION_SUFFIX}`;
}

function summarizePayloadInternal(payload: unknown, depth: number): unknown {
  if (payload === null || payload === undefined) {
    return payload;
  }
  if (typeof payload === "string") {
    return truncateString(payload);
  }
  if (
    typeof payload === "number" ||
    typeof payload === "boolean" ||
    typeof payload === "bigint"
  ) {
    return payload;
  }
  if (depth >= MAX_SUMMARY_DEPTH) {
    if (Array.isArray(payload)) {
      return { _type: "array", count: payload.length };
    }
    if (payload instanceof Date) {
      return payload.toISOString();
    }
    return { _type: "object" };
  }
  if (Array.isArray(payload)) {
    return {
      _type: "array",
      count: payload.length,
      sample: payload
        .slice(0, MAX_SUMMARY_ARRAY_SAMPLE)
        .map((entry) => summarizePayloadInternal(entry, depth + 1)),
    };
  }
  if (payload instanceof Date) {
    return payload.toISOString();
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const summarized: Record<string, unknown> = {};
    const keys = Object.keys(obj).slice(0, MAX_SUMMARY_KEYS);
    for (const key of keys) {
      summarized[key] = summarizePayloadInternal(obj[key], depth + 1);
    }
    if (Object.keys(obj).length > keys.length) {
      summarized._truncatedKeys = Object.keys(obj).length - keys.length;
    }
    return summarized;
  }
  return String(payload);
}

export function summarizePayload(payload: unknown): unknown {
  return summarizePayloadInternal(payload, 0);
}

function estimateEntryBytes(entry: DebugEntry) {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return 1024;
  }
}

export function trimDebugEntries(entries: DebugEntry[]) {
  const bounded = entries.slice(-MAX_DEBUG_ENTRIES);
  let totalBytes = 0;
  const kept: DebugEntry[] = [];

  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const entry = bounded[index]!;
    const entryBytes = estimateEntryBytes(entry);
    if (kept.length > 0 && totalBytes + entryBytes > MAX_DEBUG_TOTAL_BYTES) {
      break;
    }
    kept.push(entry);
    totalBytes += entryBytes;
  }

  return kept.reverse();
}

export function filterClearedDebugEntries(entries: DebugEntry[], clearedAfterTimestamp: number) {
  return entries.filter((entry) => entry.timestamp > clearedAfterTimestamp);
}

export function appendDebugEntry(
  entries: DebugEntry[],
  entry: DebugEntry,
  clearedAfterTimestamp: number,
) {
  if (entry.timestamp <= clearedAfterTimestamp) {
    return entries;
  }
  return trimDebugEntries([...entries, entry]);
}

export function useDebugLog() {
  const [debugOpen, setDebugOpenState] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [hasDebugAlerts, setHasDebugAlerts] = useState(false);
  const [debugPinned, setDebugPinned] = useState(false);
  const debugOpenRef = useRef(debugOpen);
  const lastClearedAtRef = useRef(0);
  debugOpenRef.current = debugOpen;

  const isAlertEntry = useCallback((entry: DebugEntry) => {
    if (entry.source === "error" || entry.source === "stderr") {
      return true;
    }
    const label = entry.label.toLowerCase();
    if (label.includes("warn") || label.includes("warning")) {
      return true;
    }
    if (typeof entry.payload === "string") {
      const payload = entry.payload.toLowerCase();
      return payload.includes("warn") || payload.includes("warning");
    }
    return false;
  }, []);

  const addDebugEntry = useCallback(
    (entry: DebugEntry) => {
      const isAlert = isAlertEntry(entry);
      if (!debugOpenRef.current && !isAlert) {
        return;
      }
      if (isAlert) {
        setHasDebugAlerts(true);
      }
      const compactEntry = { ...entry, payload: summarizePayload(entry.payload) };
      setDebugEntries((prev) =>
        appendDebugEntry(prev, compactEntry, lastClearedAtRef.current),
      );
    },
    [isAlertEntry],
  );

  const handleCopyDebug = useCallback(async () => {
    const text = debugEntries
      .map((entry) => {
        const timestamp = new Date(entry.timestamp).toLocaleTimeString();
        const payload =
          entry.payload !== undefined
            ? typeof entry.payload === "string"
              ? entry.payload
              : JSON.stringify(entry.payload, null, 2)
            : "";
        return [entry.source.toUpperCase(), timestamp, entry.label, payload]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n");
    if (text) {
      await navigator.clipboard.writeText(text);
    }
  }, [debugEntries]);

  const clearDebugEntries = useCallback(() => {
    const clearedAt = Date.now();
    lastClearedAtRef.current = clearedAt;
    setDebugEntries((prev) => filterClearedDebugEntries(prev, clearedAt));
    setHasDebugAlerts(false);
  }, []);

  const setDebugOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setDebugOpenState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        if (resolved) {
          setDebugPinned(true);
        }
        return resolved;
      });
    },
    [],
  );

  const showDebugButton = hasDebugAlerts || debugOpen || debugPinned;

  return {
    debugOpen,
    setDebugOpen,
    debugEntries,
    hasDebugAlerts,
    showDebugButton,
    addDebugEntry,
    handleCopyDebug,
    clearDebugEntries,
  };
}
