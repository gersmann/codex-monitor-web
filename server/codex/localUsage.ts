import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { JsonRecord } from "../types.js";

type DailyUsageTotals = {
  input: number;
  cached: number;
  output: number;
  agentMs: number;
  agentRuns: number;
};

type UsageTotals = {
  input: number;
  cached: number;
  output: number;
};
type TokenUsageInfo = UsageTotals & {
  usedTotal: boolean;
};
type UsageScanState = {
  previousTotals: UsageTotals | null;
  currentModel: string | null;
  lastActivityMs: number | null;
  seenRuns: Set<number>;
  matchKnown: boolean;
  matchesWorkspace: boolean;
};

const MAX_ACTIVITY_GAP_MS = 2 * 60 * 1000;

function normalizeRootPath(value: string) {
  return path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
}

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asJsonRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function toNullableString(value: unknown) {
  const trimmed = trimString(value);
  return trimmed ? trimmed : null;
}

function formatLocalDayKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function makeDayKeys(days: number) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    keys.push(formatLocalDayKey(date));
  }
  return keys;
}

function dayDirForKey(root: string, dayKey: string) {
  const [year = "1970", month = "01", day = "01"] = dayKey.split("-");
  return path.join(root, year, month, day);
}

function dayKeyForTimestampMs(timestampMs: number) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return null;
  }
  return formatLocalDayKey(new Date(timestampMs));
}

function readTimestampMs(value: JsonRecord) {
  const raw = value.timestamp;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw < 1_000_000_000_000 ? raw * 1000 : raw;
}

function pathMatchesWorkspace(cwd: string, workspacePath: string) {
  const normalizedCwd = normalizeRootPath(cwd);
  const normalizedWorkspace = normalizeRootPath(workspacePath);
  return normalizedCwd === normalizedWorkspace || normalizedCwd.startsWith(`${normalizedWorkspace}/`);
}

function extractCwd(value: JsonRecord) {
  const payload = asJsonRecord(value.payload);
  return payload ? toNullableString(payload.cwd) : null;
}

function extractModelFromTurnContext(value: JsonRecord) {
  const payload = asJsonRecord(value.payload);
  if (!payload) {
    return null;
  }
  return (
    toNullableString(payload.model) ||
    toNullableString(asJsonRecord(payload.info)?.model)
  );
}

function extractModelFromTokenCount(value: JsonRecord) {
  const payload = asJsonRecord(value.payload);
  const info = asJsonRecord(payload?.info);
  return (
    toNullableString(info?.model) ||
    toNullableString(info?.model_name) ||
    toNullableString(payload?.model) ||
    toNullableString(value.model)
  );
}

function readUsageValue(map: JsonRecord | null, keys: string[]) {
  for (const key of keys) {
    const value = map?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
  }
  return 0;
}

function readUsageRecord(info: JsonRecord, snakeCase: string, camelCase: string) {
  return asJsonRecord(info[snakeCase]) ?? asJsonRecord(info[camelCase]);
}

function extractTokenUsageInfo(value: JsonRecord): TokenUsageInfo | null {
  const payload = asJsonRecord(value.payload);
  const info = asJsonRecord(payload?.info);
  if (!info) {
    return null;
  }
  const totalUsage = readUsageRecord(info, "total_token_usage", "totalTokenUsage");
  if (totalUsage) {
    return {
      input: readUsageValue(totalUsage, ["input_tokens", "inputTokens"]),
      cached: readUsageValue(totalUsage, [
        "cached_input_tokens",
        "cache_read_input_tokens",
        "cachedInputTokens",
        "cacheReadInputTokens",
      ]),
      output: readUsageValue(totalUsage, ["output_tokens", "outputTokens"]),
      usedTotal: true,
    };
  }
  const lastUsage = readUsageRecord(info, "last_token_usage", "lastTokenUsage");
  if (!lastUsage) {
    return null;
  }
  return {
    input: readUsageValue(lastUsage, ["input_tokens", "inputTokens"]),
    cached: readUsageValue(lastUsage, [
      "cached_input_tokens",
      "cache_read_input_tokens",
      "cachedInputTokens",
      "cacheReadInputTokens",
    ]),
    output: readUsageValue(lastUsage, ["output_tokens", "outputTokens"]),
    usedTotal: false,
  };
}

function trackActivity(
  daily: Map<string, DailyUsageTotals>,
  lastActivityMs: number | null,
  timestampMs: number,
) {
  if (lastActivityMs !== null && timestampMs > lastActivityMs) {
    const gapMs = timestampMs - lastActivityMs;
    if (gapMs > 0 && gapMs <= MAX_ACTIVITY_GAP_MS) {
      const dayKey = dayKeyForTimestampMs(timestampMs);
      if (dayKey) {
        daily.get(dayKey)!.agentMs += Math.round(gapMs);
      }
    }
  }
  return timestampMs;
}

function createUsageScanState(workspacePath: string | null): UsageScanState {
  const workspaceUnscoped = workspacePath === null;
  return {
    previousTotals: null,
    currentModel: null,
    lastActivityMs: null,
    seenRuns: new Set<number>(),
    matchKnown: workspaceUnscoped,
    matchesWorkspace: workspaceUnscoped,
  };
}

function incrementAgentRuns(
  daily: Map<string, DailyUsageTotals>,
  state: UsageScanState,
  timestampMs: number,
) {
  if (state.seenRuns.has(timestampMs)) {
    return;
  }
  state.seenRuns.add(timestampMs);
  const dayKey = dayKeyForTimestampMs(timestampMs);
  if (!dayKey) {
    return;
  }
  daily.get(dayKey)!.agentRuns += 1;
}

function updateActivityMs(
  daily: Map<string, DailyUsageTotals>,
  state: UsageScanState,
  timestampMs: number,
) {
  state.lastActivityMs = trackActivity(daily, state.lastActivityMs, timestampMs);
}

function computeTokenDelta(tokenUsage: TokenUsageInfo, previousTotals: UsageTotals | null) {
  if (tokenUsage.usedTotal) {
    const previous: UsageTotals = previousTotals ?? { input: 0, cached: 0, output: 0 };
    return {
      delta: {
        input: Math.max(0, tokenUsage.input - previous.input),
        cached: Math.max(0, tokenUsage.cached - previous.cached),
        output: Math.max(0, tokenUsage.output - previous.output),
      },
      nextTotals: {
        input: tokenUsage.input,
        cached: tokenUsage.cached,
        output: tokenUsage.output,
      },
    };
  }
  const previous: UsageTotals = previousTotals ?? { input: 0, cached: 0, output: 0 };
  return {
    delta: {
      input: tokenUsage.input,
      cached: tokenUsage.cached,
      output: tokenUsage.output,
    },
    nextTotals: {
      input: previous.input + tokenUsage.input,
      cached: previous.cached + tokenUsage.cached,
      output: previous.output + tokenUsage.output,
    },
  };
}

function applyTokenCountEntry(
  value: JsonRecord,
  daily: Map<string, DailyUsageTotals>,
  modelTotals: Map<string, number>,
  state: UsageScanState,
) {
  const tokenUsage = extractTokenUsageInfo(value);
  if (!tokenUsage) {
    return;
  }
  const { delta, nextTotals } = computeTokenDelta(tokenUsage, state.previousTotals);
  state.previousTotals = nextTotals;
  if (delta.input === 0 && delta.cached === 0 && delta.output === 0) {
    return;
  }
  const timestampMs = readTimestampMs(value);
  if (timestampMs === null) {
    return;
  }
  const dayKey = dayKeyForTimestampMs(timestampMs);
  if (!dayKey) {
    return;
  }
  const totals = daily.get(dayKey)!;
  const cached = Math.min(delta.cached, delta.input);
  totals.input += delta.input;
  totals.cached += cached;
  totals.output += delta.output;
  const model = state.currentModel ?? extractModelFromTokenCount(value) ?? "unknown";
  modelTotals.set(model, (modelTotals.get(model) ?? 0) + delta.input + delta.output);
  updateActivityMs(daily, state, timestampMs);
}

function handleEventMessageEntry(
  value: JsonRecord,
  daily: Map<string, DailyUsageTotals>,
  modelTotals: Map<string, number>,
  state: UsageScanState,
) {
  const payload = asJsonRecord(value.payload);
  const payloadType = trimString(payload?.type);

  if (payloadType === "agent_message") {
    const timestampMs = readTimestampMs(value);
    if (timestampMs === null) {
      return;
    }
    incrementAgentRuns(daily, state, timestampMs);
    updateActivityMs(daily, state, timestampMs);
    return;
  }

  if (payloadType === "agent_reasoning") {
    const timestampMs = readTimestampMs(value);
    if (timestampMs === null) {
      return;
    }
    updateActivityMs(daily, state, timestampMs);
    return;
  }

  if (payloadType !== "token_count") {
    return;
  }

  applyTokenCountEntry(value, daily, modelTotals, state);
}

function handleResponseItemEntry(
  value: JsonRecord,
  daily: Map<string, DailyUsageTotals>,
  state: UsageScanState,
) {
  const payload = asJsonRecord(value.payload);
  const role = trimString(payload?.role);
  const payloadType = trimString(payload?.type);
  const timestampMs = readTimestampMs(value);
  if (timestampMs === null) {
    return;
  }

  if (role === "assistant") {
    incrementAgentRuns(daily, state, timestampMs);
    updateActivityMs(daily, state, timestampMs);
    return;
  }
  if (payloadType !== "message") {
    updateActivityMs(daily, state, timestampMs);
  }
}

async function scanLocalUsageFile(
  filePath: string,
  daily: Map<string, DailyUsageTotals>,
  modelTotals: Map<string, number>,
  workspacePath: string | null,
) {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const state = createUsageScanState(workspacePath);

  try {
    for await (const line of lines) {
      if (line.length > 512_000) {
        continue;
      }
      let value: JsonRecord;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        value = parsed as JsonRecord;
      } catch {
        continue;
      }

      const entryType = trimString(value.type);
      if (entryType === "session_meta" || entryType === "turn_context") {
        const cwd = extractCwd(value);
        if (cwd && workspacePath) {
          state.matchesWorkspace = pathMatchesWorkspace(cwd, workspacePath);
          state.matchKnown = true;
          if (!state.matchesWorkspace) {
            break;
          }
        }
      }

      if (entryType === "turn_context") {
        state.currentModel = extractModelFromTurnContext(value) ?? state.currentModel;
        continue;
      }
      if (entryType === "session_meta") {
        continue;
      }
      if (!state.matchesWorkspace) {
        if (state.matchKnown) {
          break;
        }
        continue;
      }
      if (!state.matchKnown) {
        continue;
      }

      if (entryType === "event_msg" || entryType === "") {
        handleEventMessageEntry(value, daily, modelTotals, state);
        continue;
      }

      if (entryType === "response_item") {
        handleResponseItemEntry(value, daily, state);
      }
    }
  } finally {
    lines.close();
  }
}

async function listDayEntries(dayRoot: string) {
  return await fs.readdir(dayRoot, { withFileTypes: true }).catch(() => []);
}

function isJsonlSessionEntry(entry: { isFile: () => boolean; name: string }) {
  return entry.isFile() && path.extname(entry.name) === ".jsonl";
}

async function scanUsageForDay(
  dayRoot: string,
  daily: Map<string, DailyUsageTotals>,
  modelTotals: Map<string, number>,
  workspacePath: string | null,
) {
  const entries = await listDayEntries(dayRoot);
  for (const entry of entries) {
    if (!isJsonlSessionEntry(entry)) {
      continue;
    }
    await scanLocalUsageFile(path.join(dayRoot, entry.name), daily, modelTotals, workspacePath);
  }
}

async function scanUsageForRoots(
  sessionsRoots: string[],
  dayKeys: string[],
  daily: Map<string, DailyUsageTotals>,
  modelTotals: Map<string, number>,
  workspacePath: string | null,
) {
  for (const root of sessionsRoots) {
    for (const dayKey of dayKeys) {
      await scanUsageForDay(dayDirForKey(root, dayKey), daily, modelTotals, workspacePath);
    }
  }
}

export async function buildLocalUsageSnapshot(
  sessionsRoots: string[],
  days: number,
  workspacePath: string | null,
) {
  const dayKeys = makeDayKeys(days);
  const daily = new Map<string, DailyUsageTotals>(
    dayKeys.map((dayKey) => [
      dayKey,
      { input: 0, cached: 0, output: 0, agentMs: 0, agentRuns: 0 },
    ]),
  );
  const modelTotals = new Map<string, number>();

  await scanUsageForRoots(sessionsRoots, dayKeys, daily, modelTotals, workspacePath);

  const daysList = dayKeys.map((dayKey) => {
    const totals = daily.get(dayKey)!;
    const totalTokens = totals.input + totals.output;
    const cacheHitRatePercent = totals.input > 0 ? Math.round((totals.cached / totals.input) * 1000) / 10 : 0;
    return {
      day: dayKey,
      inputTokens: totals.input,
      cachedInputTokens: totals.cached,
      outputTokens: totals.output,
      totalTokens,
      cacheHitRatePercent,
      activeMs: totals.agentMs,
      activeMinutes: Math.round((totals.agentMs / 60000) * 10) / 10,
      agentRuns: totals.agentRuns,
    };
  });

  const totalInputTokens = daysList.reduce((sum, day) => sum + day.inputTokens, 0);
  const totalOutputTokens = daysList.reduce((sum, day) => sum + day.outputTokens, 0);
  const totalTokens = totalInputTokens + totalOutputTokens;
  const last7 = daysList.slice(-7);
  const last7DaysTokens = last7.reduce((sum, day) => sum + day.totalTokens, 0);
  const last7InputTokens = last7.reduce((sum, day) => sum + day.inputTokens, 0);
  const last7CachedInputTokens = last7.reduce((sum, day) => sum + day.cachedInputTokens, 0);
  const peakDay = daysList.reduce<{ day: string; totalTokens: number } | null>((best, day) => {
    if (!best || day.totalTokens > best.totalTokens) {
      return day;
    }
    return best;
  }, null);

  return {
    updatedAt: Date.now(),
    days: daysList,
    totals: {
      last7DaysTokens,
      last30DaysTokens: totalTokens,
      averageDailyTokens: last7.length > 0 ? Math.round(last7DaysTokens / last7.length) : 0,
      cacheHitRatePercent:
        last7InputTokens > 0
          ? Math.round((last7CachedInputTokens / last7InputTokens) * 1000) / 10
          : 0,
      peakDay: peakDay && peakDay.totalTokens > 0 ? peakDay.day : null,
      peakDayTokens: peakDay && peakDay.totalTokens > 0 ? peakDay.totalTokens : 0,
    },
    topModels: Array.from(modelTotals.entries())
      .filter(([model, tokens]) => model !== "unknown" && tokens > 0)
      .map(([model, tokens]) => ({
        model,
        tokens,
        sharePercent: totalTokens > 0 ? Math.round((tokens / totalTokens) * 1000) / 10 : 0,
      }))
      .sort((left, right) => right.tokens - left.tokens)
      .slice(0, 4),
  };
}
