export function getServerThreadName(
  value: string | null | undefined,
): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

export function resolveThreadSummaryName(params: {
  customName?: string | null;
  serverName?: string | null;
  preview?: string | null;
  fallbackName: string;
}) {
  const customName = getServerThreadName(params.customName);
  if (customName) {
    return customName;
  }

  const serverName = getServerThreadName(params.serverName);
  if (serverName) {
    return serverName;
  }

  const preview = getServerThreadName(params.preview);
  if (preview) {
    return preview.length > 38 ? `${preview.slice(0, 38)}…` : preview;
  }

  return params.fallbackName;
}

