import * as tauriCore from "@tauri-apps/api/core";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function isVitestRuntime() {
  const processValue = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return Boolean(processValue?.env?.VITEST);
}

function getIsTauri() {
  if (isVitestRuntime()) {
    return true;
  }
  try {
    return typeof tauriCore.isTauri === "function" ? tauriCore.isTauri() : true;
  } catch {
    return true;
  }
}

export function isWebCompanionRuntime() {
  return !getIsTauri();
}

export function getWebApiBaseUrl() {
  const configured = import.meta.env.VITE_CODEX_MONITOR_API_BASE_URL;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return trimTrailingSlash(configured.trim());
  }
  return "/api";
}

export function getWebSocketUrl() {
  const configured = import.meta.env.VITE_CODEX_MONITOR_WS_URL;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }

  const apiBaseUrl = getWebApiBaseUrl();
  if (/^https?:\/\//i.test(apiBaseUrl)) {
    const wsBase = apiBaseUrl.replace(/^http/i, "ws").replace(/\/+$/, "");
    return wsBase.endsWith("/api") ? `${wsBase.slice(0, -4)}/events` : `${wsBase}/events`;
  }

  if (typeof window === "undefined") {
    return "ws://127.0.0.1:4318/events";
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const basePath = apiBaseUrl.startsWith("/") ? apiBaseUrl : `/${apiBaseUrl}`;
  return `${protocol}//${window.location.host}${basePath.replace(/\/api$/, "")}/events`;
}
